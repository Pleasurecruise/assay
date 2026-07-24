"""Deterministic homogeneity and information-decay instrument."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from math import isfinite, sqrt
from typing import Any

import numpy as np
import pandas as pd

from .audit_cache import (
    ComparatorFactorCache,
    load_comparator_factor_cache,
)
from .engine.constants import (
    AUDIT_TOOL_CONTRACT_VERSION,
    ENGINE_VERSION,
    HOMOGENEITY_AUDIT_SOURCE_REF,
    HOMOGENEITY_COMPARATORS,
    HOMOGENEITY_MOMENTUM_WINDOW,
    HOMOGENEITY_REVERSAL_WINDOW,
    HOMOGENEITY_VOLATILITY_WINDOW,
    TRADING_DAYS_PER_YEAR,
)
from .engine.core import momentum_signal
from .engine.strategy import parse_momentum_strategy
from .market_panel import MarketPanel, load_cached_market_panel

FactorLoader = Callable[[], ComparatorFactorCache | None]


def run_homogeneity(
    spec: Mapping[str, Any],
    *,
    panel_loader: Callable[[Mapping[str, Any]], MarketPanel] = (
        load_cached_market_panel
    ),
    factor_loader: FactorLoader = load_comparator_factor_cache,
) -> dict[str, Any]:
    strategy = parse_momentum_strategy(spec)
    panel = panel_loader(spec)
    prices = _normalize_prices(panel.adjusted_close)
    audited_signal = momentum_signal(prices, strategy["window"])
    comparators = classic_comparator_panels(prices)
    assumptions = [
        (
            "Classic comparators use momentum_20=close/close.shift(20)-1, "
            "reversal_5=-(close/close.shift(5)-1), and volatility_20="
            "rolling_std(daily_return,20,ddof=1)*sqrt(252)."
        ),
        (
            "Spearman uses average ranks for ties; annual IC and RankIC are "
            "means of valid month-end cross-sectional coefficients against "
            "the next month-end adjusted-close return."
        ),
    ]
    factor_cache = factor_loader()
    if factor_cache is None:
        mode = "classic_only"
        assumptions.append(
            (
                "The prepared ratio_pe_ttm/market_cap cache was unavailable; "
                "the authorized classic-only comparator set was used."
            )
        )
    else:
        mode = "full_factor_library"
        comparators.update(
            {
                name: _align_factor_panel(value, prices)
                for name, value in factor_cache.values.items()
            }
        )
        assumptions.append(
            (
                "Platform comparator factors use prepared cache version "
                f"{factor_cache.cache_version}."
            )
        )

    comparison_order = (
        HOMOGENEITY_COMPARATORS
        if mode == "full_factor_library"
        else HOMOGENEITY_COMPARATORS[:3]
    )
    rebalance_dates = _completed_rebalance_dates(prices.index)
    comparisons = [
        _comparison_result(
            comparator=name,
            audited_signal=audited_signal,
            comparator_values=comparators[name],
            dates=rebalance_dates,
            tradable=panel.tradable,
        )
        for name in comparison_order
    ]
    annual_ic = annual_information_coefficients(
        audited_signal,
        prices,
        rebalance_dates=rebalance_dates,
        tradable=panel.tradable,
    )
    if not annual_ic:
        raise RuntimeError("homogeneity audit has no valid annual IC evidence")

    valid_comparisons = [
        row for row in comparisons if row["meanSpearman"] is not None
    ]
    nearest = (
        sorted(
            valid_comparisons,
            key=lambda row: (
                -abs(float(row["meanSpearman"])),
                comparison_order.index(row["comparator"]),
            ),
        )[0]
        if valid_comparisons
        else None
    )
    rank_ic_slope = calculate_rank_ic_slope(annual_ic)
    return {
        "contractVersion": AUDIT_TOOL_CONTRACT_VERSION,
        "engineVersion": ENGINE_VERSION,
        "kind": "homogeneity",
        "mode": mode,
        "comparisons": comparisons,
        "annualIc": annual_ic,
        "summary": {
            "nearestComparator": (
                nearest["comparator"] if nearest is not None else None
            ),
            "maxAbsMeanSpearman": (
                abs(float(nearest["meanSpearman"]))
                if nearest is not None
                else None
            ),
            "yearsCovered": len(annual_ic),
            "rankIcSlope": _finite(rank_ic_slope),
        },
        "sourceRef": HOMOGENEITY_AUDIT_SOURCE_REF,
        "assumptions": assumptions,
    }


def classic_comparator_panels(
    adjusted_close: pd.DataFrame,
) -> dict[str, pd.DataFrame]:
    prices = _normalize_prices(adjusted_close)
    returns = prices.pct_change(fill_method=None)
    return {
        "momentum_20": prices.div(
            prices.shift(HOMOGENEITY_MOMENTUM_WINDOW)
        ).sub(1.0),
        "reversal_5": prices.div(
            prices.shift(HOMOGENEITY_REVERSAL_WINDOW)
        ).sub(1.0).mul(-1.0),
        "volatility_20": returns.rolling(
            HOMOGENEITY_VOLATILITY_WINDOW,
            min_periods=HOMOGENEITY_VOLATILITY_WINDOW,
        )
        .std(ddof=1)
        .mul(sqrt(TRADING_DAYS_PER_YEAR)),
    }


def mean_cross_sectional_spearman(
    left: pd.DataFrame,
    right: pd.DataFrame,
    *,
    dates: Sequence[pd.Timestamp],
    tradable: pd.DataFrame | None = None,
) -> tuple[float | None, int]:
    left_values, right_values = left.align(right, join="inner")
    valid_coefficients: list[float] = []
    for raw_date in dates:
        date = pd.Timestamp(raw_date)
        if date not in left_values.index:
            continue
        first = left_values.loc[date]
        second = right_values.loc[date]
        if tradable is not None and date in tradable.index:
            mask = (
                tradable.reindex(columns=first.index)
                .loc[date]
                .fillna(False)
                .astype(bool)
            )
            first = first[mask]
            second = second[mask]
        coefficient = spearman_coefficient(first, second)
        if coefficient is not None:
            valid_coefficients.append(coefficient)
    return (
        (
            float(np.mean(np.asarray(valid_coefficients, dtype=float)))
            if valid_coefficients
            else None
        ),
        len(valid_coefficients),
    )


def annual_information_coefficients(
    audited_signal: pd.DataFrame,
    adjusted_close: pd.DataFrame,
    *,
    rebalance_dates: Sequence[pd.Timestamp],
    tradable: pd.DataFrame | None = None,
) -> list[dict[str, Any]]:
    prices = _normalize_prices(adjusted_close)
    observations: dict[int, list[tuple[float, float]]] = {}
    for start, end in zip(
        rebalance_dates,
        rebalance_dates[1:],
        strict=False,
    ):
        if start not in audited_signal.index or end not in prices.index:
            continue
        signal = audited_signal.loc[start]
        forward_return = prices.loc[end].div(prices.loc[start]).sub(1.0)
        if tradable is not None and start in tradable.index:
            mask = (
                tradable.reindex(columns=signal.index)
                .loc[start]
                .fillna(False)
                .astype(bool)
            )
            signal = signal[mask]
            forward_return = forward_return[mask]
        pearson = pearson_coefficient(signal, forward_return)
        rank_ic = spearman_coefficient(signal, forward_return)
        if pearson is None and rank_ic is None:
            continue
        observations.setdefault(start.year, []).append(
            (
                pearson if pearson is not None else float("nan"),
                rank_ic if rank_ic is not None else float("nan"),
            )
        )

    result: list[dict[str, Any]] = []
    for year, values in sorted(observations.items()):
        pearson_values = np.asarray([value[0] for value in values], dtype=float)
        rank_values = np.asarray([value[1] for value in values], dtype=float)
        result.append(
            {
                "year": str(year),
                "observations": len(values),
                "pearsonIc": _finite_nanmean(pearson_values),
                "rankIc": _finite_nanmean(rank_values),
            }
        )
    return result


def calculate_rank_ic_slope(
    annual_ic: Sequence[Mapping[str, Any]],
) -> float | None:
    rank_values = [
        (int(row["year"]), float(row["rankIc"]))
        for row in annual_ic
        if row.get("rankIc") is not None
    ]
    if len(rank_values) < 2:
        return None
    return float(
        np.polyfit(
            np.asarray([year for year, _ in rank_values], dtype=float),
            np.asarray([value for _, value in rank_values], dtype=float),
            1,
        )[0]
    )


def spearman_coefficient(
    left: pd.Series,
    right: pd.Series,
) -> float | None:
    """Equivalent to scipy.stats.spearmanr with average ranks for ties."""

    paired = _paired_values(left, right)
    if paired is None:
        return None
    first, second = paired
    first_ranks = pd.Series(first).rank(method="average").to_numpy(dtype=float)
    second_ranks = pd.Series(second).rank(method="average").to_numpy(dtype=float)
    return _array_pearson(first_ranks, second_ranks)


def pearson_coefficient(
    left: pd.Series,
    right: pd.Series,
) -> float | None:
    paired = _paired_values(left, right)
    if paired is None:
        return None
    return _array_pearson(*paired)


def _paired_values(
    left: pd.Series,
    right: pd.Series,
) -> tuple[np.ndarray, np.ndarray] | None:
    paired = pd.concat(
        [
            pd.to_numeric(left, errors="coerce"),
            pd.to_numeric(right, errors="coerce"),
        ],
        axis=1,
        join="inner",
    ).dropna()
    if len(paired) < 2:
        return None
    first = paired.iloc[:, 0].to_numpy(dtype=float)
    second = paired.iloc[:, 1].to_numpy(dtype=float)
    if (
        not np.isfinite(first).all()
        or not np.isfinite(second).all()
        or np.ptp(first) <= 0
        or np.ptp(second) <= 0
    ):
        return None
    return first, second


def _array_pearson(
    first: np.ndarray,
    second: np.ndarray,
) -> float | None:
    coefficient = float(np.corrcoef(first, second)[0, 1])
    if not isfinite(coefficient):
        return None
    # Floating-point roundoff can produce values infinitesimally outside the
    # mathematical correlation range and violate the frozen transport schema.
    return max(-1.0, min(1.0, coefficient))


def _comparison_result(
    *,
    comparator: str,
    audited_signal: pd.DataFrame,
    comparator_values: pd.DataFrame,
    dates: Sequence[pd.Timestamp],
    tradable: pd.DataFrame,
) -> dict[str, Any]:
    value, count = mean_cross_sectional_spearman(
        audited_signal,
        comparator_values,
        dates=dates,
        tradable=tradable,
    )
    return {
        "comparator": comparator,
        "meanSpearman": _finite(value),
        "rebalanceObservations": count,
    }


def _align_factor_panel(
    values: pd.DataFrame,
    prices: pd.DataFrame,
) -> pd.DataFrame:
    if not isinstance(values, pd.DataFrame):
        raise TypeError("comparator factor must be a DataFrame")
    factor = values.copy()
    factor.index = pd.DatetimeIndex(pd.to_datetime(factor.index))
    factor.columns = [str(column) for column in factor.columns]
    factor = factor.apply(pd.to_numeric, errors="coerce")
    return factor.reindex(index=prices.index, columns=prices.columns)


def _normalize_prices(values: pd.DataFrame) -> pd.DataFrame:
    if not isinstance(values, pd.DataFrame) or values.empty:
        raise ValueError("homogeneity prices must be a non-empty DataFrame")
    prices = values.copy()
    prices.index = pd.DatetimeIndex(pd.to_datetime(prices.index))
    prices.columns = [str(column) for column in prices.columns]
    if prices.index.has_duplicates or prices.columns.has_duplicates:
        raise ValueError("homogeneity price keys must be unique")
    prices = prices.sort_index().sort_index(axis=1)
    prices = prices.apply(pd.to_numeric, errors="coerce").astype(float)
    if (prices.dropna(how="all") <= 0).to_numpy().any():
        raise ValueError("homogeneity prices must be positive when present")
    return prices


def _completed_rebalance_dates(
    dates: pd.DatetimeIndex,
) -> list[pd.Timestamp]:
    periods = dates.to_period("M")
    return [
        pd.Timestamp(dates[position])
        for position in range(len(dates) - 1)
        if periods[position] != periods[position + 1]
    ]


def _finite_nanmean(values: np.ndarray) -> float | None:
    finite_values = values[np.isfinite(values)]
    return (
        float(np.mean(finite_values))
        if len(finite_values)
        else None
    )


def _finite(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    return number if isfinite(number) else None
