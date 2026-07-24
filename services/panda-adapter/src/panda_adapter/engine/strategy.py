"""Shared validation for the frozen momentum StrategySpec subset."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..market_panel import INDEX_SYMBOL


def parse_momentum_strategy(
    spec: Mapping[str, Any],
    *,
    require_index: bool = True,
) -> dict[str, Any]:
    if not isinstance(spec, Mapping):
        raise ValueError("strategy spec must be an object")
    universe = spec.get("universe")
    signal = spec.get("signal")
    selection = spec.get("selection")
    rebalance = spec.get("rebalance")
    costs = spec.get("costs", {})
    if require_index and (
        not isinstance(universe, Mapping)
        or universe.get("index") != INDEX_SYMBOL
    ):
        raise ValueError(f"spec.universe.index must equal {INDEX_SYMBOL}")
    if (
        not isinstance(signal, Mapping)
        or signal.get("kind") != "template"
        or signal.get("template") != "momentum"
    ):
        raise ValueError("audit engine supports only template momentum")
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
        raise ValueError("audit engine supports only equal weighting")
    if (
        not isinstance(rebalance, Mapping)
        or rebalance.get("frequency") != "monthly"
        or rebalance.get("at", "close") != "close"
    ):
        raise ValueError("audit engine supports month-end close rebalancing")
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
