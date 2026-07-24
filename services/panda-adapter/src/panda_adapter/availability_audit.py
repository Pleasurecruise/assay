"""Deterministic point-in-time data-availability audit.

The normal path incrementally caches constituent snapshots, fetches only
historical constituents absent from the existing as-of market panel, and then
reruns the baseline with point-in-time selection eligibility.  Every factor
window and daily trade-status response is persisted before the next provider
call, so interrupted runs resume from completed fragments.  The PIT membership
timeline is mandatory and fails closed when incomplete or undated. Provider
time is bounded separately from computation; only missing historical-member
prices or statuses may degrade to a disclosed remove-only mode.

A configured promoted v9 cache is a production boundary: the audit becomes a
pure reader and never repairs, downloads, deletes, or rewrites PIT data.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from time import monotonic, sleep
from typing import Any, Final, Literal

import numpy as np
import pandas as pd

from .audit_cache import (
    V9_CACHE_VERSION,
    HistoricalMembersPolicy,
    load_historical_members_policy,
)
from .client import create_initialized_client
from .data_transport import (
    DEFAULT_RETRY_POLICY,
    DataTransportError,
    RetryPolicy,
    retry_transport,
)
from .engine.constants import AUDIT_TOOL_CONTRACT_VERSION, ENGINE_VERSION
from .engine.core import momentum_signal, run_momentum_backtest
from .engine.strategy import parse_momentum_strategy
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
PIT_EXTRA_SCHEMA_VERSION: Final = "pit-extra-panel-batch-v2"
PIT_EXTRA_FRAGMENT_SCHEMA_VERSION: Final = "pit-extra-panel-fragment-v2"
PIT_DATASET_VERSION: Final = "factor-close-trade-status-pit-v2"
AVAILABILITY_SOURCE_REF: Final = "artifact:data-availability/pit-audit"
DEFAULT_PIT_CACHE_ROOT: Final = Path(".cache/assay/pit-availability-v1")
DEFAULT_MAX_BLOCKED_SECONDS: Final = 90
INDEX_SNAPSHOT_LOOKBACK_DAYS: Final = 7
FACTOR_WINDOW_DAYS: Final = 7
EXTRA_SYMBOL_BATCH_SIZE: Final = 25
SAMPLE_SYMBOL_LIMIT: Final = 10


class AvailabilityBudgetExceeded(RuntimeError):
    """Raised internally when live data acquisition exhausts its wall budget."""


class _FragmentCoverageError(RuntimeError):
    """Raised when a source fragment omits keys required by another source."""


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
    configured_v9_root = os.environ.get("ASSAY_V9_CACHE_ROOT")
    # Promotion switches availability from the resumable preparation path to
    # a fail-closed reader.  The no-manifest development path below retains
    # incremental acquisition and its bounded remove-only degradation.
    cache_only = bool(configured_v9_root)
    historical_policy: HistoricalMembersPolicy | None = None
    if configured_v9_root:
        historical_policy = load_historical_members_policy(
            Path(configured_v9_root),
            pit_cache_root=root,
            base_symbols=base_symbols,
            panel_dates=panel.adjusted_close.index,
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
        cache_only=cache_only,
    )
    if not timeline_complete:
        # P1 makes the PIT membership timeline a hard requirement.  The only
        # authorized degradation is remove-only when historical-member prices
        # or statuses are unavailable after the timeline itself is complete.
        raise AvailabilityBudgetExceeded(
            "PIT constituent timeline acquisition is incomplete"
        )

    mode: AvailabilityMode = (
        "degraded_remove_only"
        if historical_policy is not None and historical_policy.mode == "remove_only"
        else "full_pit"
    )
    historical_symbols = sorted(
        set().union(*timeline.values()) - set(base_symbols) if timeline else set()
    )
    expanded_panel = panel
    if mode == "full_pit" and historical_symbols:
        mutable_required: dict[pd.Timestamp, set[str]] = {}
        historical_symbol_set = set(historical_symbols)
        for signal_date, execution_date in rebalance_pairs:
            members = (
                set(timeline.get(signal_date, frozenset())) & historical_symbol_set
            )
            for required_date in (signal_date, execution_date):
                mutable_required.setdefault(required_date, set()).update(members)
        required_status_symbols_by_date = {
            date: frozenset(symbols) for date, symbols in mutable_required.items()
        }
        try:
            extra_rows = _load_or_fetch_extra_rows(
                index_symbol=INDEX_SYMBOL,
                symbols=historical_symbols,
                start_date=panel.adjusted_close.index.min(),
                end_date=panel.adjusted_close.index.max(),
                trading_dates=panel.adjusted_close.index,
                required_status_symbols_by_date=(required_status_symbols_by_date),
                cache_root=root,
                client=lazy_client,
                budget=acquisition_budget,
                cache_only=cache_only,
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
    elif historical_policy is not None:
        assumptions.append(_manifest_remove_only_assumption(historical_policy))
    else:
        assumptions.append(
            (
                "Live PIT acquisition exceeded the "
                f"{acquisition_budget.max_blocked_seconds:g}-second cumulative "
                "blocked-time budget; correction is remove-only and does not add "
                "historical constituents absent from the existing panel."
            )
        )

    # Host-only Moiré M2 context. The corrected panel and membership mask are
    # persisted below the PIT cache boundary and never enter the model-visible
    # availability response.
    from .moire_audit import persist_corrected_backtest_context

    persist_corrected_backtest_context(
        spec=spec,
        panel=expanded_panel,
        eligible=eligibility,
        availability_mode=mode,
        cache_version=V9_CACHE_VERSION,
        pit_dataset_version=PIT_DATASET_VERSION,
        pit_cache_root=root,
    )

    return {
        "contractVersion": AUDIT_TOOL_CONTRACT_VERSION,
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


def _manifest_remove_only_assumption(policy: HistoricalMembersPolicy) -> str:
    if policy.reason_code is None:
        raise RuntimeError("remove-only policy requires a reason code")
    return (
        f"The promoted {policy.cache_version} manifest authorizes remove-only "
        f"historical-member handling ({policy.reason_code}); no live "
        "historical-member acquisition was attempted."
    )


def _parse_strategy(spec: Mapping[str, Any]) -> dict[str, Any]:
    return parse_momentum_strategy(spec)


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
        or not symbols
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
    cache_only: bool = False,
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
        if cache_only:
            raise RuntimeError(
                "configured v9 cache is missing a required PIT snapshot"
            )
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


def _fragment_path(
    root: Path,
    *,
    source: Literal["factor-close", "trade-status"],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    symbols: Sequence[str],
) -> Path:
    digest = sha256("\n".join(symbols).encode("utf-8")).hexdigest()[:16]
    date_range = f"{start_date.strftime('%Y%m%d')}-{end_date.strftime('%Y%m%d')}"
    return (
        root
        / "fragments"
        / source
        / date_range
        / f"symbols-{len(symbols)}-{digest}.json"
    )


def _fragment_payload(
    *,
    identity: Mapping[str, str],
    source: Literal["factor-close", "trade-status"],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    symbols: Sequence[str],
    frame: pd.DataFrame,
) -> dict[str, Any]:
    return {
        "schemaVersion": PIT_EXTRA_FRAGMENT_SCHEMA_VERSION,
        "identity": dict(identity),
        "source": source,
        "start": start_date.strftime("%Y-%m-%d"),
        "end": end_date.strftime("%Y-%m-%d"),
        "symbols": list(symbols),
        "rows": json.loads(frame.to_json(orient="records", double_precision=15)),
    }


def _read_extra_fragment(
    path: Path,
    *,
    identity: Mapping[str, str],
    source: Literal["factor-close", "trade-status"],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    symbols: Sequence[str],
) -> pd.DataFrame:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("cannot read PIT extra-panel fragment") from error
    expected_symbols = list(symbols)
    rows = payload.get("rows") if isinstance(payload, Mapping) else None
    if (
        not isinstance(payload, Mapping)
        or payload.get("schemaVersion") != PIT_EXTRA_FRAGMENT_SCHEMA_VERSION
        or payload.get("identity") != dict(identity)
        or payload.get("source") != source
        or payload.get("start") != start_date.strftime("%Y-%m-%d")
        or payload.get("end") != end_date.strftime("%Y-%m-%d")
        or payload.get("symbols") != expected_symbols
        or not isinstance(rows, list)
    ):
        raise RuntimeError("PIT extra-panel fragment identity is invalid")
    return normalize_source_frame(
        rows,
        source=source,
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
        context=f"cached PIT {source}",
    )


def _load_or_fetch_extra_fragment(
    *,
    root: Path,
    identity: Mapping[str, str],
    source: Literal["factor-close", "trade-status"],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    symbols: Sequence[str],
    budget: _AcquisitionBudget,
    label: str,
    operation: Callable[[], Any],
    context: str,
    required_symbols: Sequence[str] = (),
    cache_only: bool = False,
) -> pd.DataFrame:
    path = _fragment_path(
        root,
        source=source,
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
    )
    if path.is_file():
        frame = _read_extra_fragment(
            path,
            identity=identity,
            source=source,
            start_date=start_date,
            end_date=end_date,
            symbols=symbols,
        )
        try:
            _require_fragment_symbols(
                frame,
                required_symbols=required_symbols,
                context=f"cached PIT {source}",
            )
        except _FragmentCoverageError:
            if cache_only:
                raise RuntimeError(
                    "configured v9 cache has an incomplete required "
                    "PIT extra-panel fragment"
                ) from None
            # A structurally valid but incomplete source response must not
            # become a permanent cache hit. The exact scoped fragment is
            # recoverable, so discard it and reacquire within the same budget.
            try:
                path.unlink()
            except OSError as error:
                raise RuntimeError(
                    "cannot discard incomplete PIT extra-panel fragment"
                ) from error
        else:
            return frame
    if cache_only:
        raise RuntimeError(
            "configured v9 cache is missing a required PIT extra-panel fragment"
        )
    value = budget.call(label, operation)
    frame = normalize_source_frame(
        value,
        source=source,
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
        context=context,
    )
    _require_fragment_symbols(
        frame,
        required_symbols=required_symbols,
        context=context,
    )
    _write_json_atomic(
        path,
        _fragment_payload(
            identity=identity,
            source=source,
            start_date=start_date,
            end_date=end_date,
            symbols=symbols,
            frame=frame,
        ),
    )
    return frame


def _require_fragment_symbols(
    frame: pd.DataFrame,
    *,
    required_symbols: Sequence[str],
    context: str,
) -> None:
    missing = set(required_symbols) - set(frame["symbol"])
    if missing:
        raise _FragmentCoverageError(f"{context} is missing required symbol coverage")


def _discard_source_fragments(
    *,
    root: Path,
    source: Literal["factor-close", "trade-status"],
    windows: Sequence[tuple[pd.Timestamp, pd.Timestamp]],
    symbols: Sequence[str],
) -> None:
    """Discard only the exact source fragments proven incomplete."""

    for start_date, end_date in windows:
        path = _fragment_path(
            root,
            source=source,
            start_date=start_date,
            end_date=end_date,
            symbols=symbols,
        )
        try:
            path.unlink(missing_ok=True)
        except OSError as error:
            raise RuntimeError(
                "cannot discard incomplete PIT extra-panel fragments"
            ) from error


def _load_or_fetch_extra_rows(
    *,
    index_symbol: str,
    symbols: Sequence[str],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    trading_dates: Sequence[pd.Timestamp],
    required_status_symbols_by_date: Mapping[
        pd.Timestamp,
        frozenset[str],
    ],
    cache_root: Path,
    client: _LazyClient,
    budget: _AcquisitionBudget,
    cache_only: bool = False,
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
            root=root,
            identity=identity,
            client=client,
            budget=budget,
            symbols=batch,
            start_date=start_date,
            end_date=end_date,
            trading_dates=trading_dates,
            required_status_symbols_by_date=(required_status_symbols_by_date),
            cache_only=cache_only,
        )
        if not cache_only:
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
    root: Path,
    identity: Mapping[str, str],
    client: _LazyClient,
    budget: _AcquisitionBudget,
    symbols: Sequence[str],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    trading_dates: Sequence[pd.Timestamp],
    required_status_symbols_by_date: Mapping[
        pd.Timestamp,
        frozenset[str],
    ],
    cache_only: bool = False,
) -> pd.DataFrame:
    factor_frames: list[pd.DataFrame] = []
    factor_windows = _factor_windows(start_date, end_date)
    for chunk_start, chunk_end in factor_windows:
        factor_frames.append(
            _load_or_fetch_extra_fragment(
                root=root,
                identity=identity,
                source="factor-close",
                start_date=chunk_start,
                end_date=chunk_end,
                symbols=symbols,
                budget=budget,
                label="get_factor(close)",
                operation=lambda chunk_start=chunk_start, chunk_end=chunk_end: (
                    client.get().get_factor(
                        symbol=list(symbols),
                        start_date=chunk_start.strftime("%Y%m%d"),
                        end_date=chunk_end.strftime("%Y%m%d"),
                        factors=["close"],
                        type="stock",
                    )
                ),
                context="get_factor(close)",
                cache_only=cache_only,
            )
        )
    factor = pd.concat(factor_frames, ignore_index=True)
    if factor.empty:
        if not cache_only:
            _discard_source_fragments(
                root=root,
                source="factor-close",
                windows=factor_windows,
                symbols=symbols,
            )
        raise RuntimeError("PIT historical constituents returned no prices")
    if set(factor["symbol"]) != set(symbols):
        # Cartesian date/symbol coverage is intentionally not required:
        # pre-listing, post-delisting, and suspended dates may lack prices.
        # Every PIT constituent must nevertheless appear somewhere in the
        # requested audit window, or the candidate fragments are not reusable.
        if not cache_only:
            _discard_source_fragments(
                root=root,
                source="factor-close",
                windows=factor_windows,
                symbols=symbols,
            )
        raise RuntimeError("PIT historical constituent price coverage is incomplete")

    status_frames: list[pd.DataFrame] = []
    status_dates = sorted(
        pd.Timestamp(value).normalize()
        for value in trading_dates
        if start_date <= pd.Timestamp(value) <= end_date
    )
    batch_symbols = set(symbols)
    for trading_date in status_dates:
        date_text = trading_date.strftime("%Y-%m-%d")
        factor_symbols = set(
            factor.loc[factor["date"] == date_text, "symbol"].astype(str).unique()
        )
        critical_symbols = (
            set(
                required_status_symbols_by_date.get(
                    trading_date,
                    frozenset(),
                )
            )
            & batch_symbols
        )
        required_symbols = tuple(sorted(factor_symbols | critical_symbols))
        status_frames.append(
            _load_or_fetch_extra_fragment(
                root=root,
                identity=identity,
                source="trade-status",
                start_date=trading_date,
                end_date=trading_date,
                symbols=symbols,
                budget=budget,
                label="get_market_data(trade_status)",
                operation=lambda trading_date=trading_date: (
                    client.get().get_market_data(
                        symbol=list(symbols),
                        start_date=trading_date.strftime("%Y%m%d"),
                        end_date=trading_date.strftime("%Y%m%d"),
                        fields=["symbol", "date", "trade_status"],
                        type="stock",
                    )
                ),
                context="get_market_data(trade_status)",
                required_symbols=required_symbols,
                cache_only=cache_only,
            )
        )
    status = pd.concat(status_frames, ignore_index=True)
    factor_keys = set(zip(factor["date"], factor["symbol"], strict=True))
    status_keys = set(zip(status["date"], status["symbol"], strict=True))
    if factor_keys - status_keys:
        raise RuntimeError("PIT factor rows are missing trade status coverage")
    tradable_status = status.loc[status["tradeStatus"] == TRADABLE_TRADE_STATUS]
    tradable_status_keys = set(
        zip(
            tradable_status["date"],
            tradable_status["symbol"],
            strict=True,
        )
    )
    missing_factor_keys = tradable_status_keys - factor_keys
    if missing_factor_keys:
        missing_factor_dates = {pd.Timestamp(date) for date, _ in missing_factor_keys}
        affected_windows = [
            (window_start, window_end)
            for window_start, window_end in factor_windows
            if any(
                window_start <= missing_date <= window_end
                for missing_date in missing_factor_dates
            )
        ]
        if not cache_only:
            _discard_source_fragments(
                root=root,
                source="factor-close",
                windows=affected_windows,
                symbols=symbols,
            )
        raise RuntimeError("PIT tradable status rows are missing factor close coverage")
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
    """Count selected target occurrences blocked on their execution dates."""

    signals = momentum_signal(panel.adjusted_close, window)
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
            if not bool(panel.tradable.loc[execution_date, symbol]):
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
