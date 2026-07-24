from __future__ import annotations

from datetime import datetime, timedelta
from hashlib import sha256
import json
import math
from typing import Any

import pandas as pd

from .client import PandaDataClient

COST_BPS = {
    "none": 0.0,
    "standard": 10.0,
    "realistic": 25.0,
    "pessimistic": 37.5,
}


class BacktestValidationError(ValueError):
    """Raised when a strategy or provider frame cannot support a backtest."""


def _source_ref(operation: str, parameters: dict[str, Any]) -> str:
    canonical = json.dumps(
        {"operation": operation, "params": parameters},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = sha256(canonical.encode("utf-8")).hexdigest()[:20]
    return f"pandadata:{operation}:{digest}"


def _normalize_frame(value: Any) -> pd.DataFrame:
    if isinstance(value, pd.DataFrame):
        frame = value.copy()
    elif isinstance(value, list):
        frame = pd.DataFrame.from_records(value)
    else:
        raise BacktestValidationError("Backtest input is not tabular")
    frame.columns = [str(column).strip().lower() for column in frame.columns]
    return frame


def _normalize_dates(frame: pd.DataFrame, column: str = "date") -> pd.DataFrame:
    if column not in frame.columns:
        raise BacktestValidationError(f'Provider data is missing required "{column}" field')
    normalized = frame.copy()
    normalized[column] = (
        normalized[column].astype(str).str.replace("-", "", regex=False).str[:8]
    )
    return normalized


def _required_mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BacktestValidationError(f"{name} must be an object")
    return value


def _validate_spec(value: Any) -> dict[str, Any]:
    spec = _required_mapping(value, "spec")
    universe = _required_mapping(spec.get("universe"), "spec.universe")
    signal = _required_mapping(spec.get("signal"), "spec.signal")
    selection = _required_mapping(spec.get("selection"), "spec.selection")
    rebalance = _required_mapping(spec.get("rebalance"), "spec.rebalance")
    window = _required_mapping(spec.get("window"), "spec.window")

    index = universe.get("index")
    start = window.get("start")
    end = window.get("end")
    top_n = selection.get("topN")
    frequency = rebalance.get("frequency")
    if not isinstance(index, str) or not index:
        raise BacktestValidationError("spec.universe.index is required")
    if not isinstance(start, str) or not isinstance(end, str):
        raise BacktestValidationError("spec.window start and end are required")
    if not isinstance(top_n, int) or isinstance(top_n, bool) or not 1 <= top_n <= 200:
        raise BacktestValidationError("spec.selection.topN must be between 1 and 200")
    if frequency not in {"weekly", "monthly"}:
        raise BacktestValidationError("spec.rebalance.frequency is unsupported")
    if signal.get("kind") not in {"template", "library"}:
        raise BacktestValidationError("spec.signal.kind is unsupported")
    return spec


def _rebalance_dates(dates: pd.Series, frequency: str) -> set[str]:
    calendar = pd.DataFrame({"date": sorted(dates.unique())})
    calendar["timestamp"] = pd.to_datetime(calendar["date"], format="%Y%m%d")
    if frequency == "monthly":
        periods = calendar["timestamp"].dt.to_period("M")
    else:
        periods = calendar["timestamp"].dt.to_period("W")
    return set(calendar.groupby(periods, sort=True)["date"].last().tolist())


def _signal_frame(
    market: pd.DataFrame,
    signal: dict[str, Any],
    window_override: int | None,
    factor: pd.DataFrame | None,
) -> pd.DataFrame:
    frame = _normalize_dates(market)
    required = {"date", "symbol", "close", "pre_close"}
    missing = required.difference(frame.columns)
    if missing:
        raise BacktestValidationError(
            f"Market data is missing required fields: {', '.join(sorted(missing))}"
        )
    frame["symbol"] = frame["symbol"].astype(str).str.upper()
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    frame["pre_close"] = pd.to_numeric(frame["pre_close"], errors="coerce")
    frame["daily_return"] = frame["close"] / frame["pre_close"] - 1
    frame.loc[~frame["daily_return"].map(math.isfinite), "daily_return"] = float("nan")
    frame = frame.sort_values(["symbol", "date"]).reset_index(drop=True)

    if signal["kind"] == "library":
        if factor is None:
            raise BacktestValidationError("Library strategy requires factor data")
        factors = _normalize_dates(factor)
        if "symbol" not in factors.columns:
            raise BacktestValidationError("Factor data is missing symbol")
        factor_columns = [
            column for column in factors.columns if column not in {"date", "symbol"}
        ]
        if not factor_columns:
            raise BacktestValidationError("Factor data has no value column")
        factor_name = str(signal.get("name", "")).lower()
        factor_column = factor_name if factor_name in factor_columns else factor_columns[0]
        factors = factors[["date", "symbol", factor_column]].rename(
            columns={factor_column: "signal"}
        )
        factors["symbol"] = factors["symbol"].astype(str).str.upper()
        factors["signal"] = pd.to_numeric(factors["signal"], errors="coerce")
        return frame.merge(factors, on=["date", "symbol"], how="left")

    template = signal.get("template")
    params = _required_mapping(signal.get("params", {}), "spec.signal.params")
    default_windows = {
        "momentum": 20,
        "reversal": 5,
        "volatility": 20,
        "turnover_rate": 20,
    }
    if template not in default_windows:
        raise BacktestValidationError("Template signal is unsupported")
    signal_window = window_override or params.get("window") or default_windows[template]
    if (
        not isinstance(signal_window, int)
        or isinstance(signal_window, bool)
        or not 2 <= signal_window <= 252
    ):
        raise BacktestValidationError("Signal window must be between 2 and 252")

    grouped = frame.groupby("symbol", sort=False)
    if template in {"momentum", "reversal"}:
        price_index = (1 + frame["daily_return"].fillna(0)).groupby(frame["symbol"]).cumprod()
        raw_signal = price_index / price_index.groupby(frame["symbol"]).shift(signal_window) - 1
        frame["signal"] = raw_signal if template == "momentum" else -raw_signal
    elif template == "volatility":
        frame["signal"] = (
            grouped["daily_return"]
            .rolling(signal_window, min_periods=signal_window)
            .std()
            .reset_index(level=0, drop=True)
        )
    else:
        if "turnover_rate" not in frame.columns:
            raise BacktestValidationError("Turnover-rate strategy requires turnover_rate")
        frame["turnover_rate"] = pd.to_numeric(
            frame["turnover_rate"], errors="coerce"
        )
        frame["signal"] = (
            grouped["turnover_rate"]
            .rolling(signal_window, min_periods=signal_window)
            .mean()
            .reset_index(level=0, drop=True)
        )

    direction = params.get("direction", "low" if template in {"volatility", "turnover_rate"} else "high")
    if direction == "low":
        frame["signal"] = -frame["signal"]
    return frame


def run_backtest_frames(
    spec_value: Any,
    market_value: Any,
    index_weights_value: Any,
    *,
    factor_value: Any | None = None,
    window_override: int | None = None,
    cost_bps: float | None = None,
) -> dict[str, Any]:
    spec = _validate_spec(spec_value)
    signal = _required_mapping(spec["signal"], "spec.signal")
    selection = _required_mapping(spec["selection"], "spec.selection")
    rebalance = _required_mapping(spec["rebalance"], "spec.rebalance")
    strategy_window = _required_mapping(spec["window"], "spec.window")
    costs = _required_mapping(spec.get("costs", {"model": "standard"}), "spec.costs")

    market = _signal_frame(
        _normalize_frame(market_value),
        signal,
        window_override,
        None if factor_value is None else _normalize_frame(factor_value),
    )
    weights = _normalize_dates(_normalize_frame(index_weights_value))
    if "stock_symbol" not in weights.columns:
        raise BacktestValidationError("Index weights are missing stock_symbol")
    weights["stock_symbol"] = weights["stock_symbol"].astype(str).str.upper()
    start = str(strategy_window["start"])
    end = str(strategy_window["end"])
    market = market[(market["date"] >= start) & (market["date"] <= end)]
    if market.empty:
        raise BacktestValidationError("No market observations exist inside the strategy window")

    dates = sorted(market["date"].unique())
    rebalance_dates = _rebalance_dates(market["date"], str(rebalance["frequency"]))
    weight_dates = sorted(weights["date"].unique())
    universe_by_date = {
        day: set(weights.loc[weights["date"] == day, "stock_symbol"]) for day in weight_dates
    }
    top_n = int(selection["topN"])
    requested_cost_bps = (
        float(cost_bps)
        if cost_bps is not None
        else COST_BPS.get(str(costs.get("model", "standard")), COST_BPS["standard"])
    )
    if not 0 <= requested_cost_bps <= 1_000:
        raise BacktestValidationError("costBps must be between 0 and 1000")

    rows_by_date = {
        day: frame.set_index("symbol")
        for day, frame in market.groupby("date", sort=True)
    }
    current_weights: dict[str, float] = {}
    portfolio_returns: list[float] = []
    total_turnover = 0.0
    rebalance_count = 0

    for day in dates:
        daily = rows_by_date[day]
        gross_return = sum(
            weight * float(daily.at[symbol, "daily_return"])
            for symbol, weight in current_weights.items()
            if symbol in daily.index and pd.notna(daily.at[symbol, "daily_return"])
        )
        if current_weights and gross_return > -1:
            drifted = {
                symbol: weight
                * (
                    1
                    + (
                        float(daily.at[symbol, "daily_return"])
                        if symbol in daily.index
                        and pd.notna(daily.at[symbol, "daily_return"])
                        else 0.0
                    )
                )
                / (1 + gross_return)
                for symbol, weight in current_weights.items()
            }
            current_weights = drifted

        cost = 0.0
        if day in rebalance_dates:
            eligible_weight_dates = [weight_day for weight_day in weight_dates if weight_day <= day]
            if eligible_weight_dates:
                universe = universe_by_date[eligible_weight_dates[-1]]
                candidates = daily.loc[daily.index.intersection(universe)].dropna(
                    subset=["signal"]
                )
                selected = candidates.sort_values("signal", ascending=False).head(top_n)
                if not selected.empty:
                    new_weight = 1 / len(selected)
                    target = {str(symbol): new_weight for symbol in selected.index}
                    symbols = set(current_weights) | set(target)
                    turnover = sum(
                        abs(target.get(symbol, 0.0) - current_weights.get(symbol, 0.0))
                        for symbol in symbols
                    )
                    total_turnover += turnover
                    rebalance_count += 1
                    cost = turnover * requested_cost_bps / 10_000
                    current_weights = target
        portfolio_returns.append(gross_return - cost)

    returns = pd.Series(portfolio_returns, dtype="float64")
    if returns.empty or not current_weights:
        raise BacktestValidationError("Backtest could not form a portfolio")
    equity = (1 + returns).cumprod()
    years = len(returns) / 252
    annual_return = float(equity.iloc[-1] ** (1 / years) - 1) if years > 0 else 0.0
    volatility = float(returns.std(ddof=1))
    sharpe = (
        float(returns.mean() / volatility * math.sqrt(252))
        if volatility > 0 and math.isfinite(volatility)
        else 0.0
    )
    drawdown = equity / equity.cummax() - 1
    annual_turnover = total_turnover / years if years > 0 else 0.0
    break_even_cost_bps = (
        max(0.0, annual_return / annual_turnover * 10_000)
        if annual_turnover > 0
        else None
    )
    return {
        "annualReturn": annual_return,
        "sharpe": sharpe,
        "maxDrawdown": float(drawdown.min()),
        "annualTurnover": annual_turnover,
        "breakEvenCostBps": break_even_cost_bps,
        "costBps": requested_cost_bps,
        "window": window_override,
        "observations": len(returns),
        "rebalanceCount": rebalance_count,
    }


def run_panda_backtest(client: PandaDataClient, request: dict[str, Any]) -> dict[str, Any]:
    spec = _validate_spec(request.get("spec"))
    signal = _required_mapping(spec["signal"], "spec.signal")
    strategy_window = _required_mapping(spec["window"], "spec.window")
    params = _required_mapping(signal.get("params", {}), "spec.signal.params")
    base_window = params.get("window", 20)
    variants = request.get("windowVariants", [base_window])
    costs = request.get("costBps", [None])
    if (
        not isinstance(variants, list)
        or not 1 <= len(variants) <= 9
        or not all(isinstance(item, int) and not isinstance(item, bool) for item in variants)
    ):
        raise BacktestValidationError("windowVariants must contain 1 to 9 integer windows")
    if (
        not isinstance(costs, list)
        or not 1 <= len(costs) <= 8
        or not all(
            item is None
            or (
                isinstance(item, (int, float))
                and not isinstance(item, bool)
                and math.isfinite(item)
            )
            for item in costs
        )
    ):
        raise BacktestValidationError("costBps must contain 1 to 8 finite numbers")

    start = str(strategy_window["start"])
    end = str(strategy_window["end"])
    expanded_start = (
        datetime.strptime(start, "%Y%m%d")
        - timedelta(days=max(variants) * 3 + 14)
    ).strftime("%Y%m%d")
    index_symbol = str(_required_mapping(spec["universe"], "spec.universe")["index"])
    market_common = {
        "symbol": "",
        "type": "stock",
        "fields": [
            "date",
            "symbol",
            "close",
            "pre_close",
            "turnover_rate",
        ],
        "indicator": index_symbol.split(".")[0],
        "st": True,
    }
    warmup_end = (
        datetime.strptime(start, "%Y%m%d") - timedelta(days=1)
    ).strftime("%Y%m%d")
    market_queries = [
        {
            **market_common,
            "start_date": expanded_start,
            "end_date": warmup_end,
        },
        {
            **market_common,
            "start_date": start,
            "end_date": end,
        },
    ]
    index_params = {
        "index_symbol": index_symbol,
        "start_date": start,
        "end_date": end,
        "fields": ["index_symbol", "stock_symbol", "date", "weight"],
    }
    market = pd.concat(
        [client.query("market_data", parameters) for parameters in market_queries],
        ignore_index=True,
    )
    index_weights = client.query("index_weights", index_params)
    factor = None
    factor_queries: list[dict[str, Any]] = []
    if signal["kind"] == "library":
        factor_common: dict[str, Any] = {
            "symbol": "",
            "type": "stock",
            "factors": str(signal["name"]),
            "index_component": index_symbol.split(".")[0],
        }
        factor_queries = [
            {
                **factor_common,
                "start_date": expanded_start,
                "end_date": warmup_end,
            },
            {
                **factor_common,
                "start_date": start,
                "end_date": end,
            },
        ]
        factor = pd.concat(
            [client.query("factor", parameters) for parameters in factor_queries],
            ignore_index=True,
        )

    results = [
        run_backtest_frames(
            spec,
            market,
            index_weights,
            factor_value=factor,
            window_override=variant,
            cost_bps=cost,
        )
        for variant in variants
        for cost in costs
    ]
    data_sources = [
        _source_ref("market_data", parameters) for parameters in market_queries
    ]
    data_sources.append(_source_ref("index_weights", index_params))
    data_sources.extend(
        _source_ref("factor", parameters) for parameters in factor_queries
    )
    return {
        "variants": results,
        "dataSources": data_sources,
        "assumptions": [
            "Daily total-return proxy uses close/pre_close from PandaData.",
            "Signals observed at close affect holdings after that close.",
            "Historical index weights are selected from the latest date not after each rebalance.",
            "Cost is charged on one-way absolute portfolio weight turnover.",
        ],
    }
