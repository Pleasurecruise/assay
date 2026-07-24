"""Minimal deterministic momentum backtester for the S1a vertical slice."""

from __future__ import annotations

from math import isfinite, sqrt
from typing import Any

import numpy as np
import pandas as pd

from .constants import COST_MODELS, ENGINE_VERSION, TRADING_DAYS_PER_YEAR


def momentum_signal(adjusted_close: pd.DataFrame, window: int) -> pd.DataFrame:
    """Return momentum[t] = adjClose[t] / adjClose[t-window] - 1."""

    if isinstance(window, bool) or not isinstance(window, int) or window <= 0:
        raise ValueError("window must be a positive integer")
    _, valuation_prices = _normalize_prices(adjusted_close)
    return valuation_prices.div(valuation_prices.shift(window)).sub(1.0)


def order_cost_rate(side: str, model: str) -> float:
    """Return the complete linear cost rate for one buy or sell order."""

    if side not in {"buy", "sell"}:
        raise ValueError("side must be buy or sell")
    try:
        parameters = COST_MODELS[model]
    except KeyError as error:
        raise ValueError(f"unknown cost model: {model}") from error
    base = (
        parameters["commissionPerSide"]
        + parameters["impactPerSide"]
        + (parameters["stampDutyOnSell"] if side == "sell" else 0.0)
    )
    return base * parameters["totalMultiplier"]


def run_momentum_backtest(
    adjusted_close: pd.DataFrame,
    *,
    tradable: pd.DataFrame | None = None,
    eligible: pd.DataFrame | None = None,
    window: int,
    top_n: int,
    cost_model: str = "standard",
    initial_capital: float = 1_000_000.0,
) -> dict[str, Any]:
    """Run month-end momentum with execution at the next trading day's close.

    The signal is observed at month-end t.  Trades occur at t+1 close, so the
    new portfolio's first return is t+1 close to t+2 close.  Every selected
    name targets exactly ``1 / top_n``; unavailable names leave cash and are
    not replaced.
    """

    if isinstance(top_n, bool) or not isinstance(top_n, int) or top_n <= 0:
        raise ValueError("top_n must be a positive integer")
    if not isfinite(initial_capital) or initial_capital <= 0:
        raise ValueError("initial_capital must be finite and positive")
    if cost_model not in COST_MODELS:
        raise ValueError(f"unknown cost model: {cost_model}")

    raw_prices, prices = _normalize_prices(adjusted_close)
    tradable_mask = _normalize_tradable(tradable, raw_prices)
    eligible_mask = _normalize_eligible(eligible, raw_prices)
    signal = prices.div(prices.shift(window)).sub(1.0)
    dates = prices.index
    symbols = list(prices.columns)
    signal_to_execution = {
        signal_position + 1: signal_position
        for signal_position in _month_end_positions(dates)
        if signal_position + 1 < len(dates)
    }

    asset_returns = (
        prices.pct_change(fill_method=None)
        .replace([np.inf, -np.inf], np.nan)
        .fillna(0.0)
        .to_numpy(dtype=float)
    )
    raw_available = raw_prices.notna().to_numpy(dtype=bool)
    tradable_values = tradable_mask.to_numpy(dtype=bool)
    eligible_values = eligible_mask.to_numpy(dtype=bool)
    signal_values = signal.to_numpy(dtype=float)

    weights = np.zeros(len(symbols), dtype=float)
    nav = float(initial_capital)
    previous_nav = nav
    total_traded_notional = 0.0
    daily_rows: list[dict[str, Any]] = []

    for position, date in enumerate(dates):
        gross_return = float(np.dot(weights, asset_returns[position]))
        nav *= 1.0 + gross_return
        denominator = 1.0 + gross_return
        if denominator > 0:
            weights = weights * (1.0 + asset_returns[position]) / denominator
        else:
            weights.fill(0.0)

        signal_position = signal_to_execution.get(position)
        if signal_position is not None and nav > 0:
            selected = _select_top_n(
                signal_values[signal_position],
                symbols,
                top_n,
                eligible=eligible_values[signal_position],
            )
            target = _target_weights_without_backfill(
                selected=selected,
                current_weights=weights,
                signal_available=(
                    raw_available[signal_position]
                    & tradable_values[signal_position]
                ),
                execution_available=(
                    raw_available[position] & tradable_values[position]
                ),
                top_n=top_n,
            )
            transaction_cost = 0.0
            for symbol_position, delta in enumerate(target - weights):
                if abs(delta) <= 1e-15:
                    continue
                notional = abs(float(delta)) * nav
                side = "buy" if delta > 0 else "sell"
                transaction_cost += notional * order_cost_rate(side, cost_model)
                total_traded_notional += notional
            nav = max(0.0, nav - transaction_cost)
            weights = target

        daily_return = nav / previous_nav - 1.0 if previous_nav > 0 else -1.0
        daily_rows.append(
            {
                "date": date.strftime("%Y-%m-%d"),
                "return": _finite_float(daily_return),
                "equity": _finite_float(nav / initial_capital),
            }
        )
        previous_nav = nav

    daily_returns = pd.Series(
        [row["return"] for row in daily_rows],
        index=dates,
        dtype=float,
    )
    equity = pd.Series(
        [row["equity"] for row in daily_rows],
        index=dates,
        dtype=float,
    )
    metrics = calculate_metrics(
        daily_returns,
        equity,
        total_traded_notional=total_traded_notional,
        initial_capital=initial_capital,
    )
    return {
        "engineVersion": ENGINE_VERSION,
        "strategy": {
            "name": "momentum",
            "window": window,
            "topN": top_n,
            "rebalance": "month_end",
            "execution": "next_close",
        },
        "costModel": cost_model,
        "metrics": metrics,
        "dailyReturns": daily_rows,
    }


def calculate_metrics(
    daily_returns: pd.Series,
    equity: pd.Series,
    *,
    total_traded_notional: float,
    initial_capital: float,
) -> dict[str, float | None]:
    periods = max(len(daily_returns) - 1, 0)
    final_equity = float(equity.iloc[-1])
    annual_return = (
        final_equity ** (TRADING_DAYS_PER_YEAR / periods) - 1.0
        if periods > 0 and final_equity > 0
        else None
    )
    standard_deviation = (
        float(daily_returns.std(ddof=1)) if len(daily_returns) > 1 else 0.0
    )
    sharpe = (
        float(daily_returns.mean())
        / standard_deviation
        * sqrt(TRADING_DAYS_PER_YEAR)
        if standard_deviation > 0
        else None
    )
    max_drawdown = float(equity.div(equity.cummax()).sub(1.0).min())
    years = max(periods / TRADING_DAYS_PER_YEAR, 1 / TRADING_DAYS_PER_YEAR)
    # Half of two-sided traded notional is the one-way turnover convention.
    annual_turnover = (
        0.5 * total_traded_notional / initial_capital / years
    )
    return {
        "annualReturn": _finite_float(annual_return),
        "sharpe": _finite_float(sharpe),
        "maxDrawdown": _finite_float(max_drawdown),
        "annualTurnover": _finite_float(annual_turnover),
    }


def _normalize_prices(
    adjusted_close: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    if not isinstance(adjusted_close, pd.DataFrame):
        raise TypeError("adjusted_close must be a pandas DataFrame")
    if adjusted_close.empty:
        raise ValueError("adjusted_close must not be empty")
    if adjusted_close.index.has_duplicates or adjusted_close.columns.has_duplicates:
        raise ValueError("dates and symbols must be unique")
    raw = adjusted_close.copy()
    raw.index = pd.DatetimeIndex(pd.to_datetime(raw.index))
    raw.columns = [str(column) for column in raw.columns]
    raw = raw.sort_index().reindex(sorted(raw.columns), axis=1)
    raw = raw.apply(pd.to_numeric, errors="coerce").astype(float)
    raw = raw.replace([np.inf, -np.inf], np.nan)
    if (raw.dropna(how="all") <= 0).to_numpy().any():
        raise ValueError("adjusted close must be positive when present")
    # MVP bias: suspension/delisting/data holes stay flat at the last quote.
    return raw, raw.ffill()


def _normalize_tradable(
    tradable: pd.DataFrame | None,
    raw_prices: pd.DataFrame,
) -> pd.DataFrame:
    if tradable is None:
        return raw_prices.notna()
    if not isinstance(tradable, pd.DataFrame):
        raise TypeError("tradable must be a pandas DataFrame")
    if tradable.index.has_duplicates or tradable.columns.has_duplicates:
        raise ValueError("tradable dates and symbols must be unique")
    mask = tradable.copy()
    mask.index = pd.DatetimeIndex(pd.to_datetime(mask.index))
    mask.columns = [str(column) for column in mask.columns]
    mask = mask.reindex(index=raw_prices.index, columns=raw_prices.columns)
    return mask.fillna(False).astype(bool)


def _normalize_eligible(
    eligible: pd.DataFrame | None,
    raw_prices: pd.DataFrame,
) -> pd.DataFrame:
    """Normalize point-in-time selection membership.

    Eligibility is deliberately separate from tradability: a constituent that
    leaves the index remains sellable at the next rebalance, while a suspended
    holding remains locked by the existing execution mask.
    """

    if eligible is None:
        return pd.DataFrame(
            True,
            index=raw_prices.index,
            columns=raw_prices.columns,
            dtype=bool,
        )
    if not isinstance(eligible, pd.DataFrame):
        raise TypeError("eligible must be a pandas DataFrame")
    if eligible.index.has_duplicates or eligible.columns.has_duplicates:
        raise ValueError("eligible dates and symbols must be unique")
    mask = eligible.copy()
    mask.index = pd.DatetimeIndex(pd.to_datetime(mask.index))
    mask.columns = [str(column) for column in mask.columns]
    mask = mask.reindex(index=raw_prices.index, columns=raw_prices.columns)
    return mask.fillna(False).astype(bool)


def _month_end_positions(dates: pd.DatetimeIndex) -> list[int]:
    periods = dates.to_period("M")
    return [
        position
        for position in range(len(dates))
        if position == len(dates) - 1 or periods[position] != periods[position + 1]
    ]


def _select_top_n(
    signal_row: np.ndarray,
    symbols: list[str],
    top_n: int,
    *,
    eligible: np.ndarray | None = None,
) -> list[int]:
    valid_mask = np.isfinite(signal_row)
    if eligible is not None:
        valid_mask &= eligible
    valid = np.flatnonzero(valid_mask).tolist()
    ranked = sorted(
        valid,
        key=lambda position: (-float(signal_row[position]), symbols[position]),
    )
    return ranked[:top_n]


def _target_weights_without_backfill(
    *,
    selected: list[int],
    current_weights: np.ndarray,
    signal_available: np.ndarray,
    execution_available: np.ndarray,
    top_n: int,
) -> np.ndarray:
    target = np.zeros_like(current_weights)
    locked = (~execution_available) & (current_weights > 0)
    target[locked] = current_weights[locked]
    remaining = max(0.0, 1.0 - float(target.sum()))
    target_weight = 1.0 / top_n
    for position in selected:
        if not signal_available[position] or not execution_available[position]:
            # Deliberate S1a deviation: do not substitute the next-ranked name.
            continue
        if remaining + 1e-12 < target_weight:
            break
        target[position] = target_weight
        remaining -= target_weight
    return target


def _finite_float(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    return number if isfinite(number) else None
