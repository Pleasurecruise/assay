"""Deterministic point-in-time data-availability audit.

The normal path incrementally caches constituent snapshots, fetches only
historical constituents absent from the existing as-of market panel, and then
reruns the baseline with point-in-time selection eligibility.  Provider time
is bounded separately from computation.  Only after 20 minutes of cumulative
blocked acquisition does the audit degrade to a disclosed remove-only mode.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
from time import monotonic, sleep
import tempfile
from typing import Any, Final, Literal

import numpy as np
import pandas as pd

from .client import create_initialized_client
from .data_transport import (
    DEFAULT_RETRY_POLICY,
    DataTransportError,
    RetryPolicy,
    retry_transport,
)
from .engine.constants import ENGINE_VERSION
from .engine.core import momentum_signal, run_momentum_backtest
from .market_panel import (
    INDEX_SYMBOL,
    TRADABLE_TRADE_STATUS,
    MarketPanel,
    load_cached_market_panel,
)
from .source_normalization import (
    normalize_source_frame,
    symbols_from_weights,
)

AvailabilityMode = Literal["full_pit", "degraded_remove_only"]

PIT_SNAPSHOT_SCHEMA_VERSION: Final = "pit-index-snapshot-v1"
PIT_EXTRA_SCHEMA_VERSION: Final = "pit-extra-panel-batch-v1"
PIT_DATASET_VERSION: Final = "factor-close-trade-status-pit-v1"
AVAILABILITY_SOURCE_REF: Final = "artifact:data-availability/pit-audit"
DEFAULT_PIT_CACHE_ROOT: Final = Path(".cache/assay/pit-availability-v1")
DEFAULT_MAX_BLOCKED_SECONDS: Final = 20 * 60
INDEX_SNAPSHOT_LOOKBACK_DAYS: Final = 7
FACTOR_WINDOW_DAYS: Final = 7
EXTRA_SYMBOL_BATCH_SIZE: Final = 25
SAMPLE_SYMBOL_LIMIT: Final = 10


class AvailabilityBudgetExceeded(RuntimeError):
    """Raised internally when live data acquisition exhausts its wall budget."""


@dataclass(slots=True)
class _AcquisitionBudget:
    max_blocked_seconds: float
    clock: Callable[[], float]
    sleeper: Callable[[float], None]
    retry_policy: RetryPolicy
    blocked_seconds: float = 0.0

    def call(self, label: str, operation: Callable[[], Any]) -> Any:
        """Keep retrying chronic transport failures until the shared budget."""

        while True:
            if self.blocked_seconds >= self.max_blocked_seconds:
                raise AvailabilityBudgetExceeded(
                    "availability data acquisition budget exhausted"
                )
            started = self.clock()
            try:
                value = retry_transport(
                    label,
                    operation,
                    policy=self.retry_policy,
                    sleeper=self.sleeper,
                )
            except DataTransportError:
                elapsed = max(0.0, self.clock() - started)
                self.blocked_seconds += elapsed
                if self.blocked_seconds >= self.max_blocked_seconds:
                    raise AvailabilityBudgetExceeded(
                        "availability data acquisition budget exhausted"
                    ) from None
                if elapsed == 0:
                    raise RuntimeError(
                        "availability acquisition clock did not advance"
                    ) from None
                continue
            self.blocked_seconds += max(0.0, self.clock() - started)
            return value


@dataclass(slots=True)
class _LazyClient:
    factory: Callable[[], Any]
    value: Any | None = None

    def get(self) -> Any:
        if self.value is None:
            self.value = self.factory()
        return self.value


def run_availability_audit(
    spec: Mapping[str, Any],
    *,
    panel_loader: Callable[[Mapping[str, Any]], MarketPanel] = (
        load_cached_market_panel
    ),
    client: Any | None = None,
    client_factory: Callable[[], Any] = create_initialized_client,
    cache_root: Path | None = None,
    max_blocked_seconds: float = DEFAULT_MAX_BLOCKED_SECONDS,
    clock: Callable[[], float] = monotonic,
    sleeper: Callable[[float], None] = sleep,
    retry_policy: RetryPolicy = DEFAULT_RETRY_POLICY,
) -> dict[str, Any]:
    """Run the PIT correction and return one JSON-safe availability result."""

    if not isinstance(spec, Mapping):
        raise ValueError("availability audit spec must be an object")
    if (
        not isinstance(max_blocked_seconds, (int, float))
        or isinstance(max_blocked_seconds, bool)
        or max_blocked_seconds <= 0
    ):
        raise ValueError("max_blocked_seconds must be positive")

    strategy = _parse_strategy(spec)
    panel = panel_loader(spec)
    base_symbols = tuple(str(symbol) for symbol in panel.adjusted_close.columns)
    if not base_symbols:
        raise ValueError("availability audit requires a non-empty market panel")
    rebalance_pairs = _rebalance_pairs(panel.adjusted_close.index)
    if not rebalance_pairs:
        raise ValueError("availability audit requires a completed monthly rebalance")

    root = cache_root or Path(
        os.environ.get("ASSAY_PIT_CACHE_ROOT", str(DEFAULT_PIT_CACHE_ROOT))
    )
    acquisition_budget = _AcquisitionBudget(
        max_blocked_seconds=float(max_blocked_seconds),
        clock=clock,
        sleeper=sleeper,
        retry_policy=retry_policy,
    )
    lazy_client = _LazyClient(
        factory=client_factory,
        value=client,
    )

    signal_dates = [signal_date for signal_date, _ in rebalance_pairs]
    timeline, timeline_complete = _load_pit_timeline(
        index_symbol=INDEX_SYMBOL,
        requested_dates=signal_dates,
        base_symbols=base_symbols,
        cache_root=root,
        client=lazy_client,
        budget=acquisition_budget,
    )

    mode: AvailabilityMode = "full_pit" if timeline_complete else "degraded_remove_only"
    historical_symbols = sorted(
        set().union(*timeline.values()) - set(base_symbols) if timeline else set()
    )
    expanded_panel = panel
    if mode == "full_pit" and historical_symbols:
        try:
            extra_rows = _load_or_fetch_extra_rows(
                index_symbol=INDEX_SYMBOL,
                symbols=historical_symbols,
                start_date=panel.adjusted_close.index.min(),
                end_date=panel.adjusted_close.index.max(),
                cache_root=root,
                client=lazy_client,
                budget=acquisition_budget,
            )
        except AvailabilityBudgetExceeded:
            mode = "degraded_remove_only"
        else:
            expanded_panel = _merge_extra_panel(panel, extra_rows)

    future_symbols_by_date = {
        date: set(base_symbols) - set(timeline.get(date, base_symbols))
        for date in signal_dates
    }
    affected_rebalances = [
        date.strftime("%Y-%m-%d")
        for date in signal_dates
        if future_symbols_by_date[date]
    ]
    future_symbols = sorted(set().union(*future_symbols_by_date.values()))

    eligibility = _eligibility_mask(
        panel=expanded_panel,
        signal_dates=signal_dates,
        timeline=timeline,
        fallback_symbols=base_symbols,
    )
    baseline_result = run_momentum_backtest(
        panel.adjusted_close,
        tradable=panel.tradable,
        window=strategy["window"],
        top_n=strategy["top_n"],
        cost_model=strategy["cost_model"],
    )
    corrected_result = run_momentum_backtest(
        expanded_panel.adjusted_close,
        tradable=expanded_panel.tradable,
        eligible=eligibility,
        window=strategy["window"],
        top_n=strategy["top_n"],
        cost_model=strategy["cost_model"],
    )
    baseline_annual_return = _required_metric(
        baseline_result,
        "annualReturn",
    )
    corrected_annual_return = _required_metric(
        corrected_result,
        "annualReturn",
    )
    corrected_sharpe = _required_metric(corrected_result, "sharpe")

    assumptions = [
        (
            "The as-of comparison universe is exactly the symbol set already "
            "present in the frozen market panel."
        ),
        (
            "PIT constituent snapshots are cached incrementally at signal "
            "rebalance dates; the existing market panel is never re-downloaded."
        ),
        (
            "Financial disclosure timing is not activated because this "
            "strategy uses only price momentum."
        ),
    ]
    if mode == "full_pit":
        assumptions.append(
            (
                "Historical PIT constituents absent from the as-of panel were "
                "fetched incrementally with get_factor(close) and trade_status."
            )
        )
    else:
        assumptions.append(
            (
                "Live PIT acquisition exceeded the 20-minute cumulative "
                "blocked-time budget; correction is remove-only and does not "
                "add historical constituents absent from the existing panel."
            )
        )
        if not timeline_complete:
            assumptions.append(
                (
                    "Rebalance dates without a cached PIT snapshot retain the "
                    "as-of membership and therefore cannot create removals."
                )
            )

    return {
        "engineVersion": ENGINE_VERSION,
        "mode": mode,
        "futureConstituentCount": len(future_symbols),
        "affectedRebalances": affected_rebalances,
        "sampleSymbols": future_symbols[:SAMPLE_SYMBOL_LIMIT],
        "untradableTargets": _count_untradable_targets(
            panel=expanded_panel,
            eligibility=eligibility,
            rebalance_pairs=rebalance_pairs,
            window=strategy["window"],
            top_n=strategy["top_n"],
        ),
        "contaminatedSelectionRate": _contaminated_selection_rate(
            panel=panel,
            timeline=timeline,
            rebalance_pairs=rebalance_pairs,
            window=strategy["window"],
            top_n=strategy["top_n"],
        ),
        "corrected": {
            "annualReturn": corrected_annual_return,
            "sharpe": corrected_sharpe,
            "delta": corrected_annual_return - baseline_annual_return,
        },
        "sourceRef": AVAILABILITY_SOURCE_REF,
        "assumptions": assumptions,
    }


def _parse_strategy(spec: Mapping[str, Any]) -> dict[str, Any]:
    universe = spec.get("universe")
    signal = spec.get("signal")
    selection = spec.get("selection")
    rebalance = spec.get("rebalance")
    costs = spec.get("costs", {})
    if not isinstance(universe, Mapping) or universe.get("index") != INDEX_SYMBOL:
        raise ValueError(f"spec.universe.index must equal {INDEX_SYMBOL}")
    if (
        not isinstance(signal, Mapping)
        or signal.get("kind") != "template"
        or signal.get("template") != "momentum"
    ):
        raise ValueError("availability audit supports only template momentum")
    parameters = signal.get("params")
    if not isinstance(parameters, Mapping):
        raise ValueError("spec.signal.params must be an object")
    window = parameters.get("window")
    if isinstance(window, bool) or not isinstance(window, int) or window <= 0:
        raise ValueError("spec.signal.params.window must be positive")
    if not isinstance(selection, Mapping):
        raise ValueError("spec.selection must be an object")
    top_n = selection.get("topN")
    if (
        isinstance(top_n, bool)
        or not isinstance(top_n, int)
        or top_n <= 0
        or top_n > 200
    ):
        raise ValueError("spec.selection.topN must be from 1 to 200")
    if selection.get("weighting", "equal") != "equal":
        raise ValueError("availability audit supports only equal weighting")
    if (
        not isinstance(rebalance, Mapping)
        or rebalance.get("frequency") != "monthly"
        or rebalance.get("at", "close") != "close"
    ):
        raise ValueError("availability audit supports month-end close rebalancing")
    if not isinstance(costs, Mapping):
        raise ValueError("spec.costs must be an object")
    cost_model = costs.get("model", "standard")
    if not isinstance(cost_model, str):
        raise ValueError("spec.costs.model must be a string")
    return {
        "window": window,
        "top_n": top_n,
        "cost_model": cost_model,
    }


def _rebalance_pairs(
    values: pd.DatetimeIndex,
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    dates = pd.DatetimeIndex(pd.to_datetime(values)).sort_values()
    periods = dates.to_period("M")
    return [
        (pd.Timestamp(dates[position]), pd.Timestamp(dates[position + 1]))
        for position in range(len(dates) - 1)
        if periods[position] != periods[position + 1]
    ]


def _snapshot_path(
    cache_root: Path,
    index_symbol: str,
    requested_date: pd.Timestamp,
) -> Path:
    index_key = index_symbol.replace(".", "_")
    return (
        cache_root
        / "index-weights"
        / index_key
        / f"{requested_date.strftime('%Y%m%d')}.json"
    )


def _snapshot_payload(
    *,
    index_symbol: str,
    requested_date: pd.Timestamp,
    effective_date: str,
    symbols: Sequence[str],
) -> dict[str, Any]:
    return {
        "schemaVersion": PIT_SNAPSHOT_SCHEMA_VERSION,
        "indexSymbol": index_symbol,
        "requestedDate": requested_date.strftime("%Y-%m-%d"),
        "effectiveDate": effective_date,
        "symbols": list(symbols),
    }


def _read_snapshot(
    path: Path,
    *,
    index_symbol: str,
    requested_date: pd.Timestamp,
) -> frozenset[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("cannot read PIT constituent snapshot") from error
    if not isinstance(payload, Mapping):
        raise RuntimeError("PIT constituent snapshot must be an object")
    symbols = payload.get("symbols")
    if (
        payload.get("schemaVersion") != PIT_SNAPSHOT_SCHEMA_VERSION
        or payload.get("indexSymbol") != index_symbol
        or payload.get("requestedDate") != requested_date.strftime("%Y-%m-%d")
        or not isinstance(symbols, list)
        or any(not isinstance(symbol, str) or not symbol for symbol in symbols)
        or symbols != sorted(set(symbols))
    ):
        raise RuntimeError("PIT constituent snapshot identity is invalid")
    effective = pd.to_datetime(
        payload.get("effectiveDate"),
        errors="coerce",
    )
    if pd.isna(effective) or pd.Timestamp(effective) > requested_date:
        raise RuntimeError("PIT constituent snapshot date is invalid")
    return frozenset(symbols)


def _load_pit_timeline(
    *,
    index_symbol: str,
    requested_dates: Sequence[pd.Timestamp],
    base_symbols: Sequence[str],
    cache_root: Path,
    client: _LazyClient,
    budget: _AcquisitionBudget,
) -> tuple[dict[pd.Timestamp, frozenset[str]], bool]:
    timeline: dict[pd.Timestamp, frozenset[str]] = {}
    complete = True
    for requested_date in requested_dates:
        path = _snapshot_path(cache_root, index_symbol, requested_date)
        if path.is_file():
            timeline[requested_date] = _read_snapshot(
                path,
                index_symbol=index_symbol,
                requested_date=requested_date,
            )
            continue
        try:
            start_date = requested_date - pd.Timedelta(
                days=INDEX_SNAPSHOT_LOOKBACK_DAYS - 1
            )
            value = budget.call(
                "get_index_weights",
                lambda requested_date=requested_date, start_date=start_date: (
                    client.get().get_index_weights(
                        index_symbol=index_symbol,
                        start_date=start_date.strftime("%Y%m%d"),
                        end_date=requested_date.strftime("%Y%m%d"),
                    )
                ),
            )
        except AvailabilityBudgetExceeded:
            complete = False
            break
        symbols, effective_date = symbols_from_weights(
            value,
            requested_date=requested_date,
        )
        payload = _snapshot_payload(
            index_symbol=index_symbol,
            requested_date=requested_date,
            effective_date=effective_date,
            symbols=symbols,
        )
        _write_json_atomic(path, payload)
        timeline[requested_date] = frozenset(symbols)

    if not complete:
        for requested_date in requested_dates:
            timeline.setdefault(
                requested_date,
                frozenset(base_symbols),
            )
    return timeline, complete


def _factor_windows(
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    result: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    cursor = start_date.normalize()
    while cursor <= end_date:
        chunk_end = min(
            cursor + pd.Timedelta(days=FACTOR_WINDOW_DAYS - 1),
            end_date,
        )
        result.append((cursor, chunk_end))
        cursor = chunk_end + pd.Timedelta(days=1)
    return result


def _extra_identity(
    *,
    index_symbol: str,
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
) -> dict[str, str]:
    return {
        "datasetVersion": PIT_DATASET_VERSION,
        "indexSymbol": index_symbol,
        "start": start_date.strftime("%Y-%m-%d"),
        "end": end_date.strftime("%Y-%m-%d"),
    }


def _extra_root(
    cache_root: Path,
    identity: Mapping[str, str],
) -> Path:
    digest = sha256(
        json.dumps(
            dict(identity),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()[:16]
    return cache_root / "extra-panel" / digest


def _batch_path(root: Path, symbols: Sequence[str]) -> Path:
    digest = sha256("\n".join(symbols).encode("utf-8")).hexdigest()[:16]
    return root / f"symbols-{len(symbols)}-{digest}.json"


def _load_or_fetch_extra_rows(
    *,
    index_symbol: str,
    symbols: Sequence[str],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    cache_root: Path,
    client: _LazyClient,
    budget: _AcquisitionBudget,
) -> pd.DataFrame:
    identity = _extra_identity(
        index_symbol=index_symbol,
        start_date=start_date,
        end_date=end_date,
    )
    root = _extra_root(cache_root, identity)
    cached_frames: list[pd.DataFrame] = []
    covered: set[str] = set()
    if root.is_dir():
        for path in sorted(root.glob("symbols-*.json")):
            frame, batch_symbols = _read_extra_batch(
                path,
                identity=identity,
                start_date=start_date,
                end_date=end_date,
            )
            overlap = covered & set(batch_symbols)
            if overlap:
                raise RuntimeError("PIT extra-panel cache overlaps symbols")
            covered.update(batch_symbols)
            cached_frames.append(frame)

    requested = set(symbols)
    if not covered <= requested:
        raise RuntimeError("PIT extra-panel cache contains unexpected symbols")
    missing = sorted(requested - covered)
    for offset in range(0, len(missing), EXTRA_SYMBOL_BATCH_SIZE):
        batch = tuple(missing[offset : offset + EXTRA_SYMBOL_BATCH_SIZE])
        frame = _fetch_extra_batch(
            client=client,
            budget=budget,
            symbols=batch,
            start_date=start_date,
            end_date=end_date,
        )
        _write_json_atomic(
            _batch_path(root, batch),
            {
                "schemaVersion": PIT_EXTRA_SCHEMA_VERSION,
                "identity": dict(identity),
                "symbols": list(batch),
                "rows": json.loads(
                    frame.to_json(orient="records", double_precision=15)
                ),
            },
        )
        cached_frames.append(frame)
        covered.update(batch)

    if covered != requested:
        raise RuntimeError("PIT extra-panel symbol coverage is incomplete")
    if not cached_frames:
        return pd.DataFrame(columns=["date", "symbol", "adjClose", "tradeStatus"])
    combined = pd.concat(cached_frames, ignore_index=True)
    if combined.duplicated(["date", "symbol"]).any():
        raise RuntimeError("PIT extra-panel cache contains duplicate keys")
    return combined.sort_values(["date", "symbol"]).reset_index(drop=True)


def _fetch_extra_batch(
    *,
    client: _LazyClient,
    budget: _AcquisitionBudget,
    symbols: Sequence[str],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
) -> pd.DataFrame:
    factor_frames: list[pd.DataFrame] = []
    for chunk_start, chunk_end in _factor_windows(start_date, end_date):
        value = budget.call(
            "get_factor(close)",
            lambda chunk_start=chunk_start, chunk_end=chunk_end: (
                client.get().get_factor(
                    symbol=list(symbols),
                    start_date=chunk_start.strftime("%Y%m%d"),
                    end_date=chunk_end.strftime("%Y%m%d"),
                    factors=["close"],
                    type="stock",
                )
            ),
        )
        factor_frames.append(
            normalize_source_frame(
                value,
                source="factor-close",
                start_date=chunk_start,
                end_date=chunk_end,
                symbols=symbols,
                context="get_factor(close)",
            )
        )
    factor = pd.concat(factor_frames, ignore_index=True)
    if factor.empty:
        raise RuntimeError("PIT historical constituents returned no prices")
    if set(factor["symbol"]) != set(symbols):
        raise RuntimeError("PIT historical constituent price coverage is incomplete")

    status_frames: list[pd.DataFrame] = []
    factor_dates = sorted(pd.Timestamp(value) for value in factor["date"].unique())
    for trading_date in factor_dates:
        value = budget.call(
            "get_market_data(trade_status)",
            lambda trading_date=trading_date: (
                client.get().get_market_data(
                    symbol=list(symbols),
                    start_date=trading_date.strftime("%Y%m%d"),
                    end_date=trading_date.strftime("%Y%m%d"),
                    fields=["symbol", "date", "trade_status"],
                    type="stock",
                )
            ),
        )
        status_frames.append(
            normalize_source_frame(
                value,
                source="trade-status",
                start_date=trading_date,
                end_date=trading_date,
                symbols=symbols,
                context="get_market_data(trade_status)",
            )
        )
    status = pd.concat(status_frames, ignore_index=True)
    factor_keys = set(zip(factor["date"], factor["symbol"], strict=True))
    status_keys = set(zip(status["date"], status["symbol"], strict=True))
    if factor_keys - status_keys:
        raise RuntimeError("PIT factor rows are missing trade status coverage")
    merged = factor.merge(
        status,
        on=["date", "symbol"],
        how="left",
        validate="one_to_one",
    )
    if merged["tradeStatus"].isna().any():
        raise RuntimeError("PIT factor rows are missing trade status after merge")
    merged["tradeStatus"] = merged["tradeStatus"].astype(int)
    return (
        merged[["date", "symbol", "adjClose", "tradeStatus"]]
        .sort_values(["date", "symbol"])
        .reset_index(drop=True)
    )


def _read_extra_batch(
    path: Path,
    *,
    identity: Mapping[str, str],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
) -> tuple[pd.DataFrame, tuple[str, ...]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("cannot read PIT extra-panel cache") from error
    if not isinstance(payload, Mapping):
        raise RuntimeError("PIT extra-panel cache must be an object")
    symbols = payload.get("symbols")
    rows = payload.get("rows")
    if (
        payload.get("schemaVersion") != PIT_EXTRA_SCHEMA_VERSION
        or payload.get("identity") != dict(identity)
        or not isinstance(symbols, list)
        or any(not isinstance(symbol, str) or not symbol for symbol in symbols)
        or symbols != sorted(set(symbols))
        or not isinstance(rows, list)
    ):
        raise RuntimeError("PIT extra-panel cache identity is invalid")
    factor = normalize_source_frame(
        rows,
        source="factor-close",
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
        context="cached PIT factor-close",
    )
    status = normalize_source_frame(
        rows,
        source="trade-status",
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
        context="cached PIT trade-status",
    )
    if set(factor["symbol"]) != set(symbols):
        raise RuntimeError("PIT extra-panel cache symbol coverage is incomplete")
    merged = factor.merge(
        status,
        on=["date", "symbol"],
        how="left",
        validate="one_to_one",
    )
    if merged["tradeStatus"].isna().any():
        raise RuntimeError("PIT extra-panel cache status coverage is incomplete")
    merged["tradeStatus"] = merged["tradeStatus"].astype(int)
    return (
        merged[["date", "symbol", "adjClose", "tradeStatus"]],
        tuple(symbols),
    )


def _merge_extra_panel(
    base: MarketPanel,
    extra_rows: pd.DataFrame,
) -> MarketPanel:
    if extra_rows.empty:
        return base
    values = extra_rows.copy()
    values["date"] = pd.to_datetime(values["date"])
    prices = values.pivot(
        index="date",
        columns="symbol",
        values="adjClose",
    ).reindex(index=base.adjusted_close.index)
    statuses = values.pivot(
        index="date",
        columns="symbol",
        values="tradeStatus",
    ).reindex(index=base.adjusted_close.index, columns=prices.columns)
    overlap = set(base.adjusted_close.columns) & set(prices.columns)
    if overlap:
        raise RuntimeError("PIT extension attempted to re-fetch panel symbols")
    adjusted_close = pd.concat(
        [base.adjusted_close, prices],
        axis=1,
    ).sort_index(axis=1)
    tradable = pd.concat(
        [
            base.tradable,
            statuses.eq(TRADABLE_TRADE_STATUS).fillna(False).astype(bool),
        ],
        axis=1,
    ).reindex(columns=adjusted_close.columns)
    return MarketPanel(
        adjusted_close=adjusted_close,
        tradable=tradable,
    )


def _eligibility_mask(
    *,
    panel: MarketPanel,
    signal_dates: Sequence[pd.Timestamp],
    timeline: Mapping[pd.Timestamp, frozenset[str]],
    fallback_symbols: Sequence[str],
) -> pd.DataFrame:
    eligible = pd.DataFrame(
        False,
        index=panel.adjusted_close.index,
        columns=panel.adjusted_close.columns,
        dtype=bool,
    )
    available = set(panel.adjusted_close.columns)
    for date in signal_dates:
        members = set(timeline.get(date, frozenset(fallback_symbols)))
        selected_columns = sorted(members & available)
        eligible.loc[date, selected_columns] = True
    return eligible


def _count_untradable_targets(
    *,
    panel: MarketPanel,
    eligibility: pd.DataFrame,
    rebalance_pairs: Sequence[tuple[pd.Timestamp, pd.Timestamp]],
    window: int,
    top_n: int,
) -> int:
    signals = momentum_signal(panel.adjusted_close, window)
    raw_available = panel.adjusted_close.notna()
    symbols = list(panel.adjusted_close.columns)
    count = 0
    for signal_date, execution_date in rebalance_pairs:
        signal_values = signals.loc[signal_date].to_numpy(dtype=float)
        eligible_values = eligibility.loc[signal_date].to_numpy(dtype=bool)
        candidates = np.flatnonzero(
            np.isfinite(signal_values) & eligible_values
        ).tolist()
        ranked = sorted(
            candidates,
            key=lambda position: (
                -float(signal_values[position]),
                symbols[position],
            ),
        )[:top_n]
        for position in ranked:
            symbol = symbols[position]
            if not (
                bool(raw_available.loc[signal_date, symbol])
                and bool(panel.tradable.loc[signal_date, symbol])
                and bool(raw_available.loc[execution_date, symbol])
                and bool(panel.tradable.loc[execution_date, symbol])
            ):
                count += 1
    return count


def _contaminated_selection_rate(
    *,
    panel: MarketPanel,
    timeline: Mapping[pd.Timestamp, frozenset[str]],
    rebalance_pairs: Sequence[tuple[pd.Timestamp, pd.Timestamp]],
    window: int,
    top_n: int,
) -> float:
    """Measure future constituents among the as-of strategy's selected names."""

    signals = momentum_signal(panel.adjusted_close, window)
    symbols = list(panel.adjusted_close.columns)
    contaminated = 0
    selected_count = 0
    for signal_date, _ in rebalance_pairs:
        values = signals.loc[signal_date].to_numpy(dtype=float)
        ranked = sorted(
            np.flatnonzero(np.isfinite(values)).tolist(),
            key=lambda position: (
                -float(values[position]),
                symbols[position],
            ),
        )[:top_n]
        members = timeline.get(
            signal_date,
            frozenset(symbols),
        )
        selected_count += len(ranked)
        contaminated += sum(
            1 for position in ranked if symbols[position] not in members
        )
    return contaminated / selected_count if selected_count else 0.0


def _required_metric(
    result: Mapping[str, Any],
    name: str,
) -> float:
    metrics = result.get("metrics")
    if not isinstance(metrics, Mapping):
        raise RuntimeError("availability backtest metrics are unavailable")
    value = metrics.get(name)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise RuntimeError(f"availability backtest {name} is unavailable")
    number = float(value)
    if not np.isfinite(number):
        raise RuntimeError(f"availability backtest {name} is nonfinite")
    return number


def _write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    content = json.dumps(
        value,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
