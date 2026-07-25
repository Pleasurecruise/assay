"""The two S1a experiment kinds accepted by the stdin/stdout boundary."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pandas as pd

from .artifacts import persist_grid_daily_returns
from .constants import (
    COST_LADDER,
    COST_STRESS_SOURCE_REF,
    ENGINE_VERSION,
    PARAMETER_GRID_SOURCE_REF,
)
from .core import run_momentum_backtest


def run_baseline(
    adjusted_close: pd.DataFrame,
    *,
    tradable: pd.DataFrame | None = None,
    strategy: Mapping[str, Any],
) -> dict[str, Any]:
    parameters = _strategy_parameters(strategy)
    result = run_momentum_backtest(
        adjusted_close,
        tradable=tradable,
        **parameters,
    )
    return {
        "engineVersion": ENGINE_VERSION,
        "baseline": _result_summary(_public_parameters(parameters), result),
        "variants": [],
    }


def run_grid(
    adjusted_close: pd.DataFrame,
    *,
    tradable: pd.DataFrame | None = None,
    baseline: Mapping[str, Any],
    variants: Sequence[Mapping[str, Any]],
    artifact_root: Path | None = None,
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
    baseline_public_parameters = _public_parameters(baseline_parameters)
    baseline_daily_returns_ref = persist_grid_daily_returns(
        variant_id="baseline",
        parameters=baseline_public_parameters,
        daily_returns=baseline_result["dailyReturns"],
        root=artifact_root,
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
        artifact_variant_id = variant_id or (
            f"w{parameters['window']}-n{parameters['top_n']}"
        )
        daily_returns_ref = persist_grid_daily_returns(
            variant_id=artifact_variant_id,
            parameters=public_parameters,
            daily_returns=result["dailyReturns"],
            root=artifact_root,
        )
        results.append(
            _result_summary(
                public_parameters,
                result,
                daily_returns_ref=daily_returns_ref,
            )
        )
    return {
        "engineVersion": ENGINE_VERSION,
        "baseline": _result_summary(
            baseline_public_parameters,
            baseline_result,
            daily_returns_ref=baseline_daily_returns_ref,
        ),
        "variants": results,
        "summaryRef": PARAMETER_GRID_SOURCE_REF,
    }


def run_cost_ladder(
    adjusted_close: pd.DataFrame,
    *,
    tradable: pd.DataFrame | None = None,
    eligible: pd.DataFrame | None = None,
    strategy: Mapping[str, Any],
) -> dict[str, Any]:
    baseline_parameters = _strategy_parameters(strategy)
    baseline_result = run_momentum_backtest(
        adjusted_close,
        tradable=tradable,
        eligible=eligible,
        **baseline_parameters,
    )
    shared_parameters = {
        key: value for key, value in baseline_parameters.items() if key != "cost_model"
    }
    results = []
    for model in COST_LADDER:
        result = run_momentum_backtest(
            adjusted_close,
            tradable=tradable,
            eligible=eligible,
            cost_model=model,
            **shared_parameters,
        )
        results.append(
            _result_summary(
                _public_parameters({**shared_parameters, "cost_model": model}),
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
        "summaryRef": COST_STRESS_SOURCE_REF,
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
    *,
    daily_returns_ref: str | None = None,
) -> dict[str, Any]:
    metrics = result["metrics"]
    public_parameters = dict(parameters)
    if daily_returns_ref is not None:
        # The sprint TS response parser deliberately leaves params open. Keeping
        # this reference inside params adds the Moiré input without changing the
        # frozen summary key set consumed by existing agents.
        public_parameters["dailyReturnsRef"] = daily_returns_ref
    return {
        "params": public_parameters,
        "annualReturn": metrics["annualReturn"],
        "sharpe": metrics["sharpe"],
        "maxDrawdown": metrics["maxDrawdown"],
        "annualTurnover": metrics["annualTurnover"],
    }
