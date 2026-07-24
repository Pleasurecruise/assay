"""The two S1a experiment kinds accepted by the stdin/stdout boundary."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import pandas as pd

from .constants import COST_LADDER, ENGINE_VERSION
from .core import run_momentum_backtest


def run_grid(
    adjusted_close: pd.DataFrame,
    *,
    tradable: pd.DataFrame | None = None,
    baseline: Mapping[str, Any],
    variants: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    if isinstance(variants, (str, bytes)) or not isinstance(variants, Sequence):
        raise ValueError("variants must be an explicit sequence")
    if not variants:
        raise ValueError("variants must not be empty")

    baseline_parameters = _strategy_parameters(baseline)
    baseline_result = run_momentum_backtest(
        adjusted_close,
        tradable=tradable,
        **baseline_parameters,
    )
    seen_ids: set[str] = set()
    results: list[dict[str, Any]] = []
    for value in variants:
        variant = dict(value)
        variant_id = variant.pop("variantId", None)
        if variant_id is not None:
            if not isinstance(variant_id, str) or not variant_id:
                raise ValueError("variantId must be a non-empty string")
            if variant_id in seen_ids:
                raise ValueError(f"duplicate variantId: {variant_id}")
            seen_ids.add(variant_id)
        merged = {**dict(baseline), **variant}
        parameters = _strategy_parameters(merged)
        result = run_momentum_backtest(
            adjusted_close,
            tradable=tradable,
            **parameters,
        )
        public_parameters = _public_parameters(parameters)
        if variant_id is not None:
            public_parameters = {
                "variantId": variant_id,
                **public_parameters,
            }
        results.append(
            _result_summary(public_parameters, result)
        )
    return {
        "engineVersion": ENGINE_VERSION,
        "baseline": _result_summary(
            _public_parameters(baseline_parameters),
            baseline_result,
        ),
        "variants": results,
    }


def run_cost_ladder(
    adjusted_close: pd.DataFrame,
    *,
    tradable: pd.DataFrame | None = None,
    strategy: Mapping[str, Any],
) -> dict[str, Any]:
    baseline_parameters = _strategy_parameters(strategy)
    baseline_result = run_momentum_backtest(
        adjusted_close,
        tradable=tradable,
        **baseline_parameters,
    )
    shared_parameters = {
        key: value
        for key, value in baseline_parameters.items()
        if key != "cost_model"
    }
    results = []
    for model in COST_LADDER:
        result = run_momentum_backtest(
            adjusted_close,
            tradable=tradable,
            cost_model=model,
            **shared_parameters,
        )
        results.append(
            _result_summary(
                _public_parameters(
                    {**shared_parameters, "cost_model": model}
                ),
                result,
            )
        )
    return {
        "engineVersion": ENGINE_VERSION,
        "baseline": _result_summary(
            _public_parameters(baseline_parameters),
            baseline_result,
        ),
        "variants": results,
    }


def _strategy_parameters(
    value: Mapping[str, Any],
) -> dict[str, Any]:
    allowed = {"window", "topN", "costModel"}
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"unsupported strategy fields: {', '.join(unknown)}")
    if "window" not in value or "topN" not in value:
        raise ValueError("strategy requires window and topN")
    result = {
        "window": value["window"],
        "top_n": value["topN"],
        "cost_model": value.get("costModel", "standard"),
    }
    return result


def _public_parameters(value: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "window": value["window"],
        "topN": value["top_n"],
        "costModel": value["cost_model"],
    }


def _result_summary(
    parameters: Mapping[str, Any],
    result: Mapping[str, Any],
) -> dict[str, Any]:
    metrics = result["metrics"]
    return {
        "params": dict(parameters),
        "annualReturn": metrics["annualReturn"],
        "sharpe": metrics["sharpe"],
        "maxDrawdown": metrics["maxDrawdown"],
        "annualTurnover": metrics["annualTurnover"],
    }
