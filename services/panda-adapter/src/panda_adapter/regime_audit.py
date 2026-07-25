"""Deterministic no-lookahead regime split for CHECKS_WIRING §2."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from math import isfinite, sqrt
from typing import Any

import numpy as np
import pandas as pd

from .audit_cache import (
    IndexDailyCache,
    PitMembershipCache,
    load_index_daily_cache,
    load_pit_membership_cache,
)
from .engine.constants import (
    AUDIT_TOOL_CONTRACT_VERSION,
    ENGINE_VERSION,
    REGIME_HIGH_VOLATILITY_QUANTILE,
    REGIME_SPLIT_SOURCE_REF,
    REGIME_TREND_MA_DAYS,
    REGIME_VOLATILITY_WINDOW_DAYS,
    TRADING_DAYS_PER_YEAR,
)
from .engine.core import run_momentum_backtest
from .engine.strategy import parse_momentum_strategy
from .market_panel import MarketPanel, load_cached_market_panel

IndexLoader = Callable[[], IndexDailyCache | None]
MembershipLoader = Callable[[], PitMembershipCache]


def run_regime_split(
    spec: Mapping[str, Any],
    *,
    panel_loader: Callable[[Mapping[str, Any]], MarketPanel] = (
        load_cached_market_panel
    ),
    index_loader: IndexLoader = load_index_daily_cache,
    membership_loader: MembershipLoader = load_pit_membership_cache,
) -> dict[str, Any]:
    strategy = parse_momentum_strategy(spec)
    panel = panel_loader(spec)
    cached_index = index_loader()
    assumptions = [
        (
            "A return dated t is classified only with index information "
            "available through t-1."
        ),
        (
            f"Trend uses a {REGIME_TREND_MA_DAYS}-trading-day moving "
            f"average; volatility uses {REGIME_VOLATILITY_WINDOW_DAYS} "
            "trading days and an expanding historical two-thirds quantile."
        ),
    ]
    if cached_index is None:
        mode = "constituent_proxy"
        membership_cache = membership_loader()
        index_close = _constituent_equal_weight_proxy(
            panel.adjusted_close,
            membership_cache.snapshots,
        )
        available_symbols = set(panel.adjusted_close.columns)
        unavailable_members = (
            set().union(*membership_cache.snapshots.values()) - available_symbols
        )
        assumptions.append(
            (
                "The prepared index-daily cache was unavailable; the cached "
                f"{membership_cache.cache_version} PIT constituent timeline's "
                "equal-weight return was used as the authorized deterministic "
                "proxy. A snapshot becomes eligible only after its effective "
                "date, so future constituents cannot enter earlier proxy "
                "returns. Days before the first cached PIT snapshot remain "
                "unlabeled."
            )
        )
        assumptions.append(
            (
                f"{len(unavailable_members)} PIT member(s) absent from the "
                "frozen price panel were omitted under the authorized "
                "remove-only degradation; each proxy day uses the intersection "
                "of its as-of PIT membership and the frozen panel."
            )
        )
    else:
        mode = "index_daily"
        index_close = cached_index.close
        assumptions.append(
            f"Index labels use prepared cache version {cached_index.cache_version}."
        )

    baseline = run_momentum_backtest(
        panel.adjusted_close,
        tradable=panel.tradable,
        window=strategy["window"],
        top_n=strategy["top_n"],
        cost_model=strategy["cost_model"],
    )
    rows = baseline["dailyReturns"]
    dates = pd.DatetimeIndex(pd.to_datetime([row["date"] for row in rows]))
    labels = label_regimes(index_close, dates)
    (
        environments,
        zero_total_pnl,
        unlabeled_nonzero_days,
    ) = split_returns_by_regime(rows, labels)
    if unlabeled_nonzero_days:
        assumptions.append(
            (
                f"{unlabeled_nonzero_days} nonzero-return strategy day(s) "
                "preceded the first usable regime label and are excluded "
                "from slice metrics. Each reported pnlShare remains its "
                "additive contribution divided by full-period P&L, so the "
                "reported shares need not sum to 1."
            )
        )
    if zero_total_pnl:
        assumptions.append(
            (
                "Full-period P&L was zero; pnlShare is deterministically set "
                "to 0 for every environment and cannot evidence concentration."
            )
        )
    total_pnl = float(rows[-1]["equity"]) - 1.0
    if total_pnl < 0:
        assumptions.append(
            (
                "Full-period P&L was negative; signed pnlShare values are "
                "reported but concentration thresholds require caution."
            )
        )
    dominant = sorted(
        environments,
        key=lambda value: (-float(value["pnlShare"]), str(value["id"])),
    )[0]
    return {
        "contractVersion": AUDIT_TOOL_CONTRACT_VERSION,
        "engineVersion": ENGINE_VERSION,
        "kind": "regime_split",
        "mode": mode,
        "environments": environments,
        "dominantEnvironment": {
            "id": dominant["id"],
            "pnlShare": dominant["pnlShare"],
        },
        "sourceRef": REGIME_SPLIT_SOURCE_REF,
        "assumptions": assumptions,
    }


def label_regimes(
    index_close: pd.Series,
    target_dates: Sequence[pd.Timestamp],
) -> pd.DataFrame:
    """Label t from close/volatility observations ending no later than t-1."""

    close = _normalize_index_close(index_close)
    moving_average = close.rolling(
        REGIME_TREND_MA_DAYS,
        min_periods=REGIME_TREND_MA_DAYS,
    ).mean()
    realized_volatility = (
        close.pct_change(fill_method=None)
        .rolling(
            REGIME_VOLATILITY_WINDOW_DAYS,
            min_periods=REGIME_VOLATILITY_WINDOW_DAYS,
        )
        .std(ddof=1)
        .mul(sqrt(TRADING_DAYS_PER_YEAR))
    )
    output: list[dict[str, Any]] = []
    for raw_date in target_dates:
        date = pd.Timestamp(raw_date)
        prior_position = int(close.index.searchsorted(date, side="left")) - 1
        if prior_position < 0:
            output.append(_missing_label(date))
            continue
        prior_date = pd.Timestamp(close.index[prior_position])
        prior_close = float(close.iloc[prior_position])
        prior_average = moving_average.iloc[prior_position]
        current_volatility = realized_volatility.iloc[prior_position]
        historical_volatility = realized_volatility.iloc[
            : prior_position + 1
        ].dropna()
        if (
            pd.isna(prior_average)
            or pd.isna(current_volatility)
            or historical_volatility.empty
        ):
            output.append(_missing_label(date))
            continue
        cutoff = float(
            historical_volatility.quantile(
                REGIME_HIGH_VOLATILITY_QUANTILE,
                interpolation="linear",
            )
        )
        trend = "up" if prior_close > float(prior_average) else "down"
        volatility = (
            "high" if float(current_volatility) >= cutoff else "normal"
        )
        output.append(
            {
                "date": date,
                "priorDate": prior_date,
                "trend": trend,
                "volatility": volatility,
                "id": f"{trend}-{volatility}",
            }
        )
    return pd.DataFrame(output).set_index("date")


def split_returns_by_regime(
    daily_rows: Sequence[Mapping[str, Any]],
    labels: pd.DataFrame,
) -> tuple[list[dict[str, Any]], bool, int]:
    """Calculate slice metrics and additive equity-P&L contribution shares."""

    if not daily_rows:
        raise ValueError("regime split requires daily returns")
    frame = pd.DataFrame([dict(row) for row in daily_rows])
    if set(frame.columns) != {"date", "return", "equity"}:
        raise ValueError("regime daily rows are invalid")
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame["return"] = pd.to_numeric(frame["return"], errors="coerce")
    frame["equity"] = pd.to_numeric(frame["equity"], errors="coerce")
    if (
        frame[["date", "return", "equity"]].isna().any().any()
        or frame["date"].duplicated().any()
    ):
        raise ValueError("regime daily rows contain invalid values")
    frame = frame.set_index("date").sort_index()
    prior_equity = pd.Series(
        np.r_[1.0, frame["equity"].to_numpy(dtype=float)[:-1]],
        index=frame.index,
        dtype=float,
    )
    # Compute additive contributions before discarding warm-up rows. This
    # preserves the true previous equity even when MA200 cannot label the
    # first cached days of the authorized constituent proxy.
    frame["pnl"] = frame["equity"] - prior_equity
    frame = frame.join(labels[["id", "trend", "volatility"]], how="left")
    unlabeled_nonzero_days = int(
        (frame["id"].isna() & frame["return"].abs().gt(1e-15)).sum()
    )
    labeled_frame = frame[frame["id"].notna()].copy()
    if labeled_frame.empty:
        raise RuntimeError("regime split has no labeled strategy days")

    total_pnl = float(daily_rows[-1]["equity"]) - 1.0
    zero_total_pnl = abs(total_pnl) <= 1e-15

    environments: list[dict[str, Any]] = []
    for environment_id, group in labeled_frame.groupby("id", sort=True):
        returns = group["return"].astype(float)
        days = len(returns)
        compounded = float(np.prod(1.0 + returns.to_numpy(dtype=float)))
        annual_return = (
            compounded ** (TRADING_DAYS_PER_YEAR / days) - 1.0
        )
        standard_deviation = (
            float(returns.std(ddof=1)) if days > 1 else 0.0
        )
        sharpe = (
            float(returns.mean())
            / standard_deviation
            * sqrt(TRADING_DAYS_PER_YEAR)
            if standard_deviation > 0
            else None
        )
        first = group.iloc[0]
        pnl_share = (
            0.0
            if zero_total_pnl
            else float(group["pnl"].sum()) / total_pnl
        )
        values = {
            "id": str(environment_id),
            "trend": str(first["trend"]),
            "volatility": str(first["volatility"]),
            "days": days,
            "annualReturn": _required_finite(
                annual_return,
                "regime annualReturn",
            ),
            "sharpe": _finite(sharpe),
            "pnlShare": _required_finite(pnl_share, "regime pnlShare"),
        }
        environments.append(values)
    return environments, zero_total_pnl, unlabeled_nonzero_days


def _constituent_equal_weight_proxy(
    adjusted_close: pd.DataFrame,
    snapshots: Mapping[pd.Timestamp, frozenset[str]],
) -> pd.Series:
    if not isinstance(adjusted_close, pd.DataFrame) or adjusted_close.empty:
        raise ValueError("constituent proxy requires a non-empty price panel")
    prices = adjusted_close.sort_index().apply(
        pd.to_numeric,
        errors="coerce",
    )
    prices.index = pd.DatetimeIndex(pd.to_datetime(prices.index))
    if prices.index.has_duplicates or prices.columns.has_duplicates:
        raise ValueError("constituent proxy price keys must be unique")
    if not snapshots:
        raise ValueError("constituent proxy requires PIT membership snapshots")
    ordered_snapshots: list[tuple[pd.Timestamp, frozenset[str]]] = []
    for raw_date, raw_members in sorted(snapshots.items()):
        date = pd.Timestamp(raw_date)
        if (
            pd.isna(date)
            or not isinstance(raw_members, frozenset)
            or not raw_members
            or any(
                not isinstance(symbol, str) or not symbol
                for symbol in raw_members
            )
        ):
            raise ValueError("constituent proxy PIT membership is invalid")
        ordered_snapshots.append((date, raw_members))
    if len({date for date, _ in ordered_snapshots}) != len(ordered_snapshots):
        raise ValueError("constituent proxy PIT dates must be unique")

    returns = prices.pct_change(fill_method=None)
    proxy_close: dict[pd.Timestamp, float] = {}
    snapshot_position = 0
    active_members: frozenset[str] | None = None
    first_snapshot_date = ordered_snapshots[0][0]
    first_position = int(prices.index.searchsorted(first_snapshot_date, side="left"))
    if first_position >= len(prices.index):
        raise ValueError("constituent proxy PIT timeline is outside the price window")
    initial_date = pd.Timestamp(prices.index[first_position])
    proxy_close[initial_date] = 1.0
    current_close = 1.0

    for position in range(first_position + 1, len(prices.index)):
        previous_date = pd.Timestamp(prices.index[position - 1])
        while (
            snapshot_position < len(ordered_snapshots)
            and ordered_snapshots[snapshot_position][0] <= previous_date
        ):
            active_members = ordered_snapshots[snapshot_position][1]
            snapshot_position += 1
        if active_members is None:
            continue
        available = sorted(active_members & set(prices.columns))
        if not available:
            raise RuntimeError(
                "constituent proxy PIT membership has no cached price coverage"
            )
        current_date = pd.Timestamp(prices.index[position])
        daily = returns.loc[current_date, available].dropna().astype(float)
        if daily.empty or not np.isfinite(daily.to_numpy(dtype=float)).all():
            raise RuntimeError(
                "constituent proxy PIT membership has no valid daily returns"
            )
        current_close *= 1.0 + float(daily.mean())
        if not isfinite(current_close) or current_close <= 0:
            raise RuntimeError("constituent proxy produced an invalid close")
        proxy_close[current_date] = current_close
    if len(proxy_close) < 2:
        raise RuntimeError("constituent proxy has insufficient PIT-covered dates")
    return pd.Series(proxy_close, dtype=float, name="close")


def _normalize_index_close(value: pd.Series) -> pd.Series:
    if not isinstance(value, pd.Series) or value.empty:
        raise ValueError("index close must be a non-empty Series")
    close = value.copy()
    close.index = pd.DatetimeIndex(pd.to_datetime(close.index))
    close = pd.to_numeric(close, errors="coerce").astype(float).sort_index()
    if (
        close.index.has_duplicates
        or close.isna().any()
        or not close.map(lambda number: isfinite(number) and number > 0).all()
    ):
        raise ValueError("index close contains invalid values")
    return close


def _missing_label(date: pd.Timestamp) -> dict[str, Any]:
    return {
        "date": date,
        "priorDate": pd.NaT,
        "trend": None,
        "volatility": None,
        "id": None,
    }


def _finite(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    return number if isfinite(number) else None


def _required_finite(value: Any, name: str) -> float:
    number = _finite(value)
    if number is None:
        raise RuntimeError(f"{name} is nonfinite")
    return number
