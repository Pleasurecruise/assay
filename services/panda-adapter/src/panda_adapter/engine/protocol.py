"""JSON-safe S0 request/response adapter for the pure S1a engine."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import pandas as pd

from ..market_panel import MarketPanel
from .constants import COST_LADDER
from .experiments import run_baseline, run_cost_ladder, run_grid
from .strategy import parse_momentum_strategy

PanelLoader = Callable[[Mapping[str, Any]], MarketPanel]
AvailabilityRunner = Callable[[Mapping[str, Any]], dict[str, Any]]
RegimeRunner = Callable[[Mapping[str, Any]], dict[str, Any]]
HomogeneityRunner = Callable[[Mapping[str, Any]], dict[str, Any]]


def run_request(
    request: Mapping[str, Any],
    *,
    panel_loader: PanelLoader | None = None,
    availability_runner: AvailabilityRunner | None = None,
    regime_runner: RegimeRunner | None = None,
    homogeneity_runner: HomogeneityRunner | None = None,
    artifact_root: Path | None = None,
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
    max_variants = _parse_budget(request.get("budget"))
    if kind == "availability_audit":
        if max_variants != 1:
            raise ValueError(
                "availability_audit budget.maxVariants must equal 1"
            )
        if request.get("grid") is not None:
            raise ValueError("availability_audit does not accept grid")
        if availability_runner is None:
            from ..availability_audit import run_availability_audit

            availability_runner = run_availability_audit
        return availability_runner(spec)
    if kind == "regime_split":
        _require_single_audit_request(
            request,
            max_variants=max_variants,
            kind="regime_split",
        )
        if regime_runner is None:
            from ..regime_audit import run_regime_split

            regime_runner = run_regime_split
        return regime_runner(spec)
    if kind == "homogeneity":
        _require_single_audit_request(
            request,
            max_variants=max_variants,
            kind="homogeneity",
        )
        if homogeneity_runner is None:
            from ..homogeneity_audit import run_homogeneity

            homogeneity_runner = run_homogeneity
        return homogeneity_runner(spec)

    panel = (
        panel_loader(spec)
        if panel_loader is not None
        else _parse_embedded_test_panel(spec)
    )
    baseline = _parse_strategy_spec(spec)
    if kind == "baseline":
        if request.get("universeMode") != "asOf":
            raise ValueError('baseline request universeMode must equal "asOf"')
        if max_variants != 1:
            raise ValueError("baseline request budget.maxVariants must equal 1")
        return run_baseline(
            panel.adjusted_close,
            tradable=panel.tradable,
            strategy=baseline,
        )
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
            artifact_root=artifact_root,
        )
    if kind == "cost_ladder":
        if len(COST_LADDER) > max_variants:
            raise ValueError("cost ladder exceeds budget.maxVariants")
        return run_cost_ladder(
            panel.adjusted_close,
            tradable=panel.tradable,
            strategy=baseline,
        )
    raise ValueError(
        "kind must be baseline, grid, cost_ladder, availability_audit, "
        "regime_split, or homogeneity"
    )


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
    parsed = parse_momentum_strategy(spec, require_index=False)
    return {
        "window": parsed["window"],
        "topN": parsed["top_n"],
        "costModel": parsed["cost_model"],
    }


def _require_single_audit_request(
    request: Mapping[str, Any],
    *,
    max_variants: int,
    kind: str,
) -> None:
    if max_variants != 1:
        raise ValueError(f"{kind} budget.maxVariants must equal 1")
    if request.get("grid") is not None:
        raise ValueError(f"{kind} does not accept grid")
    if request.get("universeMode") is not None:
        raise ValueError(f"{kind} does not accept universeMode")


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
