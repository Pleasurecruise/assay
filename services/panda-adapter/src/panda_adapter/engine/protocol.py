"""JSON-safe S0 request/response adapter for the pure S1a engine."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

import pandas as pd

from ..market_panel import MarketPanel
from .constants import COST_LADDER
from .experiments import run_cost_ladder, run_grid

PanelLoader = Callable[[Mapping[str, Any]], MarketPanel]


def run_request(
    request: Mapping[str, Any],
    *,
    panel_loader: PanelLoader | None = None,
) -> dict[str, Any]:
    """Execute one ``kind/spec/grid?/budget`` JSON request.

    Production supplies ``panel_loader`` to resolve the frozen spec through the
    cache/data boundary.  ``spec.data.panel`` is a controlled test-only seam;
    the market panel is deliberately not a top-level public request field.
    """

    if not isinstance(request, Mapping):
        raise ValueError("request must be an object")
    kind = request.get("kind")
    spec = request.get("spec")
    if not isinstance(spec, Mapping):
        raise ValueError("request requires spec")
    panel = (
        panel_loader(spec)
        if panel_loader is not None
        else _parse_embedded_test_panel(spec)
    )
    baseline = _parse_strategy_spec(spec)
    max_variants = _parse_budget(request.get("budget"))
    if kind == "grid":
        grid = request.get("grid")
        if not isinstance(grid, Mapping):
            raise ValueError("grid request requires grid")
        variants = _expand_grid(grid)
        if len(variants) > max_variants:
            raise ValueError("grid exceeds budget.maxVariants")
        return run_grid(
            panel.adjusted_close,
            tradable=panel.tradable,
            baseline=baseline,
            variants=variants,
        )
    if kind == "cost_ladder":
        if len(COST_LADDER) > max_variants:
            raise ValueError("cost ladder exceeds budget.maxVariants")
        return run_cost_ladder(
            panel.adjusted_close,
            tradable=panel.tradable,
            strategy=baseline,
        )
    raise ValueError("kind must be grid or cost_ladder")


def _parse_embedded_test_panel(spec: Mapping[str, Any]) -> MarketPanel:
    data = spec.get("data")
    if not isinstance(data, Mapping) or "panel" not in data:
        raise ValueError(
            "no panel loader configured (tests may use spec.data.panel)"
        )
    return _parse_panel(data["panel"])


def _parse_panel(value: Any) -> MarketPanel:
    if not isinstance(value, Mapping):
        raise ValueError("request requires panel")
    dates = value.get("dates")
    symbols = value.get("symbols")
    adjusted_close = value.get("adjClose")
    if not isinstance(dates, list) or not isinstance(symbols, list):
        raise ValueError("panel requires dates and symbols arrays")
    if not isinstance(adjusted_close, list):
        raise ValueError("panel requires adjClose matrix")
    if len(adjusted_close) != len(dates):
        raise ValueError("adjClose row count must match dates")
    if any(
        not isinstance(row, list) or len(row) != len(symbols)
        for row in adjusted_close
    ):
        raise ValueError("every adjClose row must match symbols")
    prices = pd.DataFrame(
        adjusted_close,
        index=pd.to_datetime(dates),
        columns=[str(symbol) for symbol in symbols],
        dtype=float,
    )
    tradable_values = value.get("tradable")
    if tradable_values is None:
        tradable = prices.notna()
    else:
        if not isinstance(tradable_values, list) or len(tradable_values) != len(
            dates
        ):
            raise ValueError("tradable row count must match dates")
        if any(
            not isinstance(row, list) or len(row) != len(symbols)
            for row in tradable_values
        ):
            raise ValueError("every tradable row must match symbols")
        if any(
            not isinstance(item, bool)
            for row in tradable_values
            for item in row
        ):
            raise ValueError("tradable matrix values must be booleans")
        tradable = pd.DataFrame(
            tradable_values,
            index=prices.index,
            columns=prices.columns,
            dtype=bool,
        )
    return MarketPanel(adjusted_close=prices, tradable=tradable)


def _parse_strategy_spec(spec: Mapping[str, Any]) -> dict[str, Any]:
    signal = spec.get("signal")
    selection = spec.get("selection")
    rebalance = spec.get("rebalance")
    costs = spec.get("costs", {})
    if not isinstance(signal, Mapping):
        raise ValueError("spec.signal must be an object")
    if signal.get("kind") != "template" or signal.get("template") != "momentum":
        raise ValueError("S1a supports only template momentum")
    signal_parameters = signal.get("params")
    if not isinstance(signal_parameters, Mapping):
        raise ValueError("spec.signal.params must be an object")
    if not isinstance(selection, Mapping):
        raise ValueError("spec.selection must be an object")
    if selection.get("weighting", "equal") != "equal":
        raise ValueError("S1a supports only equal weighting")
    if (
        not isinstance(rebalance, Mapping)
        or rebalance.get("frequency") != "monthly"
        or rebalance.get("at", "close") != "close"
    ):
        raise ValueError("S1a supports only month-end close rebalancing")
    if not isinstance(costs, Mapping):
        raise ValueError("spec.costs must be an object")
    return {
        "window": signal_parameters.get("window"),
        "topN": selection.get("topN"),
        "costModel": costs.get("model", "standard"),
    }


def _expand_grid(value: Mapping[str, Any]) -> list[dict[str, Any]]:
    allowed = {"signalParams", "topN"}
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"unsupported grid fields: {', '.join(unknown)}")
    signal_parameters = value.get("signalParams")
    top_ns = value.get("topN")
    if not isinstance(signal_parameters, Mapping):
        raise ValueError("grid.signalParams must be an object")
    if set(signal_parameters) != {"window"}:
        raise ValueError("grid.signalParams supports only window")
    windows = signal_parameters.get("window")
    if not isinstance(windows, list) or not windows:
        raise ValueError("grid.signalParams.window must be a non-empty array")
    if not isinstance(top_ns, list) or not top_ns:
        raise ValueError("grid.topN must be a non-empty array")
    if any(
        isinstance(window, bool) or not isinstance(window, int) or window <= 0
        for window in windows
    ):
        raise ValueError("every grid window must be a positive integer")
    if any(
        isinstance(top_n, bool)
        or not isinstance(top_n, int)
        or top_n <= 0
        or top_n > 200
        for top_n in top_ns
    ):
        raise ValueError("every grid topN must be an integer from 1 to 200")
    if len(set(windows)) != len(windows) or len(set(top_ns)) != len(top_ns):
        raise ValueError("grid values must be unique")
    return [
        {
            "variantId": f"w{window}-n{top_n}",
            "window": window,
            "topN": top_n,
        }
        for window in windows
        for top_n in top_ns
    ]


def _parse_budget(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("budget must declare a positive maxVariants")
    if isinstance(value, int):
        maximum = value
    elif isinstance(value, Mapping):
        maximum = value.get("maxVariants")
    else:
        maximum = None
    if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum <= 0:
        raise ValueError("budget must declare a positive maxVariants")
    return maximum
