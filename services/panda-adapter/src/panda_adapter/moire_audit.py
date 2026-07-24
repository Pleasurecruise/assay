"""Host-only deterministic Moiré experiments.

The public boundary accepts only a host-frozen StrategySpec and one approved
experiment kind. Independent agent results, sibling evidence, filesystem
paths, and caller-selected variants are deliberately absent.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
import json
from math import isfinite, sqrt
import os
from pathlib import Path
from statistics import median
import tempfile
from typing import Any, Final, Literal

import numpy as np
import pandas as pd

from .audit_cache import (
    IndexDailyCache,
    PitMembershipCache,
    V9_CACHE_VERSION,
    load_index_daily_cache,
    load_pit_membership_cache,
)
from .availability_audit import PIT_DATASET_VERSION
from .engine.artifacts import (
    DAILY_RETURNS_REF_PREFIX,
    DEFAULT_BACKTEST_ARTIFACT_ROOT,
    daily_returns_artifact_path,
)
from .engine.constants import (
    DAILY_RETURNS_ARTIFACT_SCHEMA_VERSION,
    ENGINE_VERSION,
    TRADING_DAYS_PER_YEAR,
)
from .engine.experiments import run_cost_ladder, run_grid
from .engine.strategy import parse_momentum_strategy
from .market_panel import MarketPanel, load_cached_market_panel
from .regime_audit import (
    _constituent_equal_weight_proxy,
    label_regimes,
    split_returns_by_regime,
)

MOIRE_ARTIFACT_SCHEMA_VERSION: Final = "moire-evidence-artifact-v1"
CORRECTED_CONTEXT_SCHEMA_VERSION: Final = "moire-corrected-backtest-context-v1"
GRID_CONTEXT_SCHEMA_VERSION: Final = "moire-grid-context-v1"
DEFAULT_MOIRE_ARTIFACT_ROOT: Final = Path(".cache/assay/moire-artifacts-v1")
DEFAULT_PIT_CACHE_ROOT: Final = Path(".cache/assay/pit-availability-v1")
CORRECTED_CONTEXT_DIRECTORY: Final = "host-corrected-context-v1"
GRID_CONTEXT_DIRECTORY: Final = "host-grid-context-v1"
M1_SOURCE_REF_PREFIX: Final = "artifact:moire/M1/sha256-"
M2_SOURCE_REF_PREFIX: Final = "artifact:moire/M2/sha256-"

# Cross-language mirror of SPRINT_PARAMETER_GRID. The host owns this list;
# neither the model nor the subprocess caller may add or remove variants.
MOIRE_GRID_WINDOWS: Final = (14, 17, 20, 23, 26)
MOIRE_GRID_TOP_NS: Final = (30, 50, 70)
MOIRE_GRID_VARIANT_COUNT: Final = 15
MOIRE_M2_PESSIMISTIC_FAIL_THRESHOLD: Final = 0.0

AvailabilityMode = Literal["full_pit", "degraded_remove_only"]
GridRunner = Callable[..., dict[str, Any]]
CostLadderRunner = Callable[..., dict[str, Any]]
IndexLoader = Callable[[], IndexDailyCache | None]
MembershipLoader = Callable[[], PitMembershipCache]


@dataclass(frozen=True, slots=True)
class CorrectedBacktestContext:
    panel: MarketPanel
    eligible: pd.DataFrame
    availability_mode: AvailabilityMode
    cache_version: str
    pit_dataset_version: str
    context_digest: str


def run_moire_request(
    request: Mapping[str, Any],
    *,
    panel_loader: Callable[[Mapping[str, Any]], MarketPanel] = (
        load_cached_market_panel
    ),
    index_loader: IndexLoader = load_index_daily_cache,
    membership_loader: MembershipLoader = load_pit_membership_cache,
    grid_runner: GridRunner = run_grid,
    cost_ladder_runner: CostLadderRunner = run_cost_ladder,
    backtest_artifact_root: Path | None = None,
    moire_artifact_root: Path | None = None,
    pit_cache_root: Path | None = None,
) -> dict[str, Any]:
    """Execute one approved host-bound Moiré experiment."""

    if not isinstance(request, Mapping):
        raise ValueError("Moiré request must be an object")
    if set(request) != {"kind", "spec"}:
        raise ValueError("Moiré request must contain exactly kind and spec")
    kind = request.get("kind")
    spec = request.get("spec")
    if not isinstance(spec, Mapping):
        raise ValueError("Moiré request spec must be an object")
    if kind == "regime_slice_of_grid":
        return run_regime_slice_of_grid(
            spec,
            panel_loader=panel_loader,
            index_loader=index_loader,
            membership_loader=membership_loader,
            grid_runner=grid_runner,
            backtest_artifact_root=backtest_artifact_root,
            moire_artifact_root=moire_artifact_root,
        )
    if kind == "corrected_cost_ladder":
        return run_corrected_cost_ladder(
            spec,
            cost_ladder_runner=cost_ladder_runner,
            moire_artifact_root=moire_artifact_root,
            pit_cache_root=pit_cache_root,
        )
    raise ValueError("Moiré kind must be regime_slice_of_grid or corrected_cost_ladder")


def run_regime_slice_of_grid(
    spec: Mapping[str, Any],
    *,
    panel_loader: Callable[[Mapping[str, Any]], MarketPanel] = (
        load_cached_market_panel
    ),
    index_loader: IndexLoader = load_index_daily_cache,
    membership_loader: MembershipLoader = load_pit_membership_cache,
    grid_runner: GridRunner = run_grid,
    backtest_artifact_root: Path | None = None,
    moire_artifact_root: Path | None = None,
) -> dict[str, Any]:
    """Calculate per-regime parameter retention from the frozen 15-cell grid."""

    strategy = parse_momentum_strategy(spec)
    panel = panel_loader(spec)
    dates = _normalized_panel_dates(panel.adjusted_close)
    panel_identity = _panel_identity(panel)
    baseline = _public_strategy(strategy)
    variants = _fixed_grid_variants()
    artifact_root = _backtest_artifact_root(backtest_artifact_root)
    loaded, has_bound_context = _load_bound_grid_artifacts(
        spec=spec,
        panel_identity=panel_identity,
        root=artifact_root,
        dates=dates,
        baseline=baseline,
        variants=variants,
    )
    if loaded is None and not has_bound_context:
        loaded = _load_complete_grid_artifacts(
            root=artifact_root,
            dates=dates,
            baseline=baseline,
            variants=variants,
        )
    if loaded is None:
        grid_mode = "fixed_grid_rerun"
        result = grid_runner(
            panel.adjusted_close,
            tradable=panel.tradable,
            baseline=baseline,
            variants=variants,
            artifact_root=artifact_root,
        )
        daily_by_variant, input_refs = _grid_artifacts_from_result(
            result,
            root=artifact_root,
            dates=dates,
            baseline=baseline,
            variants=variants,
        )
    else:
        daily_by_variant, input_refs, grid_mode = loaded
    _persist_grid_context(
        spec=spec,
        panel_identity=panel_identity,
        mode=grid_mode,
        references=input_refs,
        root=artifact_root,
    )

    cached_index = index_loader()
    if cached_index is None:
        membership_cache = membership_loader()
        index_close = _constituent_equal_weight_proxy(
            panel.adjusted_close,
            membership_cache.snapshots,
        )
        label_assumption = (
            "The prepared index cache was unavailable; labels use the "
            f"authorized {membership_cache.cache_version} PIT-constituent "
            "equal-weight proxy. A snapshot becomes eligible only after its "
            "effective date, so future constituents cannot enter earlier "
            "proxy returns."
        )
        index_identity = f"constituent_proxy:{membership_cache.cache_version}"
    else:
        index_close = cached_index.close
        label_assumption = (
            "Regime labels use prepared index cache version "
            f"{cached_index.cache_version}."
        )
        index_identity = cached_index.cache_version

    labels = label_regimes(index_close, dates)
    environments, _, unlabeled_nonzero_days = split_returns_by_regime(
        daily_by_variant["baseline"],
        labels,
    )
    dominant = sorted(
        environments,
        key=lambda value: (-float(value["pnlShare"]), str(value["id"])),
    )[0]
    dominant_id = str(dominant["id"])
    retention_details = calculate_environment_retentions(
        daily_by_variant,
        labels=labels,
        environment_ids=[str(value["id"]) for value in environments],
    )
    detail_by_id = {str(value["environmentId"]): value for value in retention_details}
    dominant_retention = float(detail_by_id[dominant_id]["retention"])
    other_retention = [
        {
            "environmentId": environment_id,
            "retention": float(detail_by_id[environment_id]["retention"]),
        }
        for environment_id in sorted(detail_by_id)
        if environment_id != dominant_id
    ]
    outcome_without_ref = {
        "id": "M1",
        "kind": "regime_slice_of_grid",
        "dominantEnvironmentId": dominant_id,
        "dominantRetention": dominant_retention,
        "otherEnvironmentRetentions": other_retention,
    }
    evidence = {
        "schemaVersion": MOIRE_ARTIFACT_SCHEMA_VERSION,
        "engineVersion": ENGINE_VERSION,
        **outcome_without_ref,
        "grid": {
            "mode": grid_mode,
            "specHash": _spec_hash(spec),
            "panelIdentity": panel_identity,
            "windows": list(MOIRE_GRID_WINDOWS),
            "topN": list(MOIRE_GRID_TOP_NS),
            "variantCount": MOIRE_GRID_VARIANT_COUNT,
            "dailyReturnRefs": input_refs,
        },
        "regime": {
            "indexIdentity": index_identity,
            "unlabeledNonzeroDays": unlabeled_nonzero_days,
        },
        "retentionDetails": retention_details,
        "assumptions": [
            (
                "Environment retention equals the median Sharpe of all 15 "
                "frozen grid variant entries divided by the separately "
                "reported baseline Sharpe in the same regime."
            ),
            (
                (
                    "A complete, unambiguous, hash-verified artifact set from "
                    "the host context was reused."
                )
                if grid_mode == "existing_grid_artifacts"
                else (
                    "The host grid context was absent or ambiguous, so the "
                    "authorized fixed 15-variant grid was deterministically "
                    "rerun before slicing."
                )
            ),
            (
                "A return dated t uses the same t-1 MA200/vol60 historical "
                "two-thirds-quantile label as the regime audit."
            ),
            label_assumption,
        ],
    }
    source_ref = _persist_moire_artifact(
        evidence,
        dispute_id="M1",
        root=moire_artifact_root,
    )
    return {
        "id": "M1",
        "kind": "regime_slice_of_grid",
        "sourceRef": source_ref,
        "dominantEnvironmentId": dominant_id,
        "dominantRetention": dominant_retention,
        "otherEnvironmentRetentions": other_retention,
    }


def calculate_environment_retentions(
    daily_by_variant: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    labels: pd.DataFrame,
    environment_ids: Sequence[str],
) -> list[dict[str, Any]]:
    """Return strict known-answer details for all observed environments."""

    if set(daily_by_variant) != {
        "baseline",
        *[
            f"w{window}-n{top_n}"
            for window in MOIRE_GRID_WINDOWS
            for top_n in MOIRE_GRID_TOP_NS
        ],
    }:
        raise RuntimeError("M1 requires baseline and exactly 15 grid variants")
    variant_ids = [
        f"w{window}-n{top_n}"
        for window in MOIRE_GRID_WINDOWS
        for top_n in MOIRE_GRID_TOP_NS
    ]
    unique_environment_ids = sorted(set(environment_ids))
    if (
        not unique_environment_ids
        or len(unique_environment_ids) != len(environment_ids)
        or any(not value for value in unique_environment_ids)
    ):
        raise RuntimeError("M1 environment ids are invalid")

    result: list[dict[str, Any]] = []
    for environment_id in unique_environment_ids:
        baseline_sharpe = _environment_sharpe(
            daily_by_variant["baseline"],
            labels=labels,
            environment_id=environment_id,
        )
        if baseline_sharpe is None or baseline_sharpe <= 0:
            raise RuntimeError("M1 baseline regime Sharpe must be positive and finite")
        variant_sharpes = [
            _environment_sharpe(
                daily_by_variant[variant_id],
                labels=labels,
                environment_id=environment_id,
            )
            for variant_id in variant_ids
        ]
        if any(value is None for value in variant_sharpes):
            raise RuntimeError("M1 every frozen variant needs a finite regime Sharpe")
        finite_variant_sharpes = [
            float(value) for value in variant_sharpes if value is not None
        ]
        median_variant_sharpe = float(median(finite_variant_sharpes))
        retention = median_variant_sharpe / baseline_sharpe
        if not isfinite(retention):
            raise RuntimeError("M1 regime retention is nonfinite")
        result.append(
            {
                "environmentId": environment_id,
                "baselineSharpe": baseline_sharpe,
                "medianVariantSharpe": median_variant_sharpe,
                "variantCount": len(finite_variant_sharpes),
                "retention": retention,
            }
        )
    return result


def run_corrected_cost_ladder(
    spec: Mapping[str, Any],
    *,
    cost_ladder_runner: CostLadderRunner = run_cost_ladder,
    moire_artifact_root: Path | None = None,
    pit_cache_root: Path | None = None,
) -> dict[str, Any]:
    """Run the fixed ladder once on the host-only PIT-corrected context."""

    strategy = parse_momentum_strategy(spec)
    context = load_corrected_backtest_context(
        spec,
        pit_cache_root=pit_cache_root,
    )
    ladder = cost_ladder_runner(
        context.panel.adjusted_close,
        tradable=context.panel.tradable,
        eligible=context.eligible,
        strategy=_public_strategy(strategy),
    )
    pessimistic = _pessimistic_variant(ladder)
    pessimistic_annual_return = pessimistic.get("annualReturn")
    if (
        isinstance(pessimistic_annual_return, bool)
        or not isinstance(pessimistic_annual_return, (int, float))
        or not isfinite(float(pessimistic_annual_return))
    ):
        raise RuntimeError("M2 pessimistic annual return is invalid")
    conclusion = (
        "fail"
        if (float(pessimistic_annual_return) <= MOIRE_M2_PESSIMISTIC_FAIL_THRESHOLD)
        else "pass_with_reservations"
    )
    evidence = {
        "schemaVersion": MOIRE_ARTIFACT_SCHEMA_VERSION,
        "engineVersion": ENGINE_VERSION,
        "id": "M2",
        "kind": "corrected_cost_ladder",
        "correctedCostConclusion": conclusion,
        "pessimisticAnnualReturn": float(pessimistic_annual_return),
        "correctedContextDigest": context.context_digest,
        "correctedContextCacheVersion": context.cache_version,
        "correctedContextPitDatasetVersion": context.pit_dataset_version,
        "availabilityMode": context.availability_mode,
        "ladder": ladder,
        "assumptions": [
            (
                "The fixed standard/realistic/pessimistic ladder is run once "
                "on the host-only PIT-corrected panel and eligibility mask."
            ),
            (
                "Frozen minimum rule: pessimistic annualReturn <= 0 maps to "
                "fail; a positive value maps to pass_with_reservations. The "
                "pass tier is intentionally unreachable in this minimum v9 "
                "instrument."
            ),
        ],
    }
    source_ref = _persist_moire_artifact(
        evidence,
        dispute_id="M2",
        root=moire_artifact_root,
    )
    return {
        "id": "M2",
        "kind": "corrected_cost_ladder",
        "sourceRef": source_ref,
        "correctedCostConclusion": conclusion,
    }


def persist_corrected_backtest_context(
    *,
    spec: Mapping[str, Any],
    panel: MarketPanel,
    eligible: pd.DataFrame,
    availability_mode: AvailabilityMode,
    cache_version: str,
    pit_dataset_version: str,
    pit_cache_root: Path | None = None,
) -> str:
    """Persist PIT-corrected inputs below the host cache boundary."""

    if availability_mode not in {"full_pit", "degraded_remove_only"}:
        raise ValueError("corrected context availability mode is invalid")
    if not isinstance(cache_version, str) or not cache_version:
        raise ValueError("corrected context cache version is invalid")
    if not isinstance(pit_dataset_version, str) or not pit_dataset_version:
        raise ValueError("corrected context PIT dataset version is invalid")
    prices, tradable, eligibility = _normalize_corrected_context(
        panel,
        eligible,
    )
    dates = [pd.Timestamp(value).strftime("%Y-%m-%d") for value in prices.index]
    symbols = [str(value) for value in prices.columns]
    core = {
        "schemaVersion": CORRECTED_CONTEXT_SCHEMA_VERSION,
        "specHash": _spec_hash(spec),
        "availabilityMode": availability_mode,
        "cacheVersion": cache_version,
        "pitDatasetVersion": pit_dataset_version,
        "dates": dates,
        "symbols": symbols,
        "adjustedClose": [
            [None if pd.isna(value) else float(value) for value in row]
            for row in prices.to_numpy(dtype=float)
        ],
        "tradable": tradable.to_numpy(dtype=bool).tolist(),
        "eligible": eligibility.to_numpy(dtype=bool).tolist(),
    }
    context_digest = f"sha256:{sha256(_canonical_bytes(core)).hexdigest()}"
    payload = {**core, "contextDigest": context_digest}
    root = _corrected_context_root(pit_cache_root)
    path = root / f"{core['specHash'].removeprefix('sha256:')}.json"
    _write_atomic(path, _canonical_bytes(payload))
    return context_digest


def load_corrected_backtest_context(
    spec: Mapping[str, Any],
    *,
    pit_cache_root: Path | None = None,
) -> CorrectedBacktestContext:
    """Load and authenticate the corrected context for one frozen spec."""

    expected_spec_hash = _spec_hash(spec)
    root = _corrected_context_root(pit_cache_root)
    path = root / f"{expected_spec_hash.removeprefix('sha256:')}.json"
    if not path.is_file():
        raise RuntimeError("M2 corrected host context is unavailable")
    if path.is_symlink():
        raise RuntimeError("M2 corrected host context identity is invalid")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("M2 corrected host context is unreadable") from error
    expected_keys = {
        "schemaVersion",
        "specHash",
        "contextDigest",
        "availabilityMode",
        "cacheVersion",
        "pitDatasetVersion",
        "dates",
        "symbols",
        "adjustedClose",
        "tradable",
        "eligible",
    }
    if not isinstance(payload, Mapping) or set(payload) != expected_keys:
        raise RuntimeError("M2 corrected host context shape is invalid")
    core = {key: value for key, value in payload.items() if key != "contextDigest"}
    expected_digest = f"sha256:{sha256(_canonical_bytes(core)).hexdigest()}"
    if (
        payload.get("schemaVersion") != CORRECTED_CONTEXT_SCHEMA_VERSION
        or payload.get("specHash") != expected_spec_hash
        or payload.get("contextDigest") != expected_digest
    ):
        raise RuntimeError("M2 corrected host context identity is invalid")
    mode = payload.get("availabilityMode")
    if mode not in {"full_pit", "degraded_remove_only"}:
        raise RuntimeError("M2 corrected host context mode is invalid")
    cache_version = payload.get("cacheVersion")
    if cache_version != V9_CACHE_VERSION:
        raise RuntimeError("M2 corrected host context cache version is invalid")
    pit_dataset_version = payload.get("pitDatasetVersion")
    if pit_dataset_version != PIT_DATASET_VERSION:
        raise RuntimeError("M2 corrected host context PIT dataset version is invalid")
    dates = _context_dates(payload.get("dates"))
    symbols = _context_symbols(payload.get("symbols"))
    adjusted_close = _numeric_context_matrix(
        payload.get("adjustedClose"),
        rows=len(dates),
        columns=len(symbols),
    )
    tradable = _boolean_context_matrix(
        payload.get("tradable"),
        rows=len(dates),
        columns=len(symbols),
    )
    eligible = _boolean_context_matrix(
        payload.get("eligible"),
        rows=len(dates),
        columns=len(symbols),
    )
    return CorrectedBacktestContext(
        panel=MarketPanel(
            adjusted_close=pd.DataFrame(
                adjusted_close,
                index=dates,
                columns=symbols,
                dtype=float,
            ),
            tradable=pd.DataFrame(
                tradable,
                index=dates,
                columns=symbols,
                dtype=bool,
            ),
        ),
        eligible=pd.DataFrame(
            eligible,
            index=dates,
            columns=symbols,
            dtype=bool,
        ),
        availability_mode=mode,
        cache_version=cache_version,
        pit_dataset_version=pit_dataset_version,
        context_digest=expected_digest,
    )


def moire_artifact_path(reference: str, *, root: Path) -> Path:
    """Resolve a trusted Moiré content reference for internal readers/tests."""

    for dispute_id, prefix in (
        ("M1", M1_SOURCE_REF_PREFIX),
        ("M2", M2_SOURCE_REF_PREFIX),
    ):
        if reference.startswith(prefix):
            digest = reference.removeprefix(prefix)
            if len(digest) != 64 or any(
                value not in "0123456789abcdef" for value in digest
            ):
                break
            return root / dispute_id / f"sha256-{digest}.json"
    raise ValueError("Moiré artifact reference is invalid")


def _public_strategy(strategy: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "window": strategy["window"],
        "topN": strategy["top_n"],
        "costModel": strategy["cost_model"],
    }


def _fixed_grid_variants() -> list[dict[str, Any]]:
    return [
        {
            "variantId": f"w{window}-n{top_n}",
            "window": window,
            "topN": top_n,
        }
        for window in MOIRE_GRID_WINDOWS
        for top_n in MOIRE_GRID_TOP_NS
    ]


def _normalized_panel_dates(values: pd.DataFrame) -> pd.DatetimeIndex:
    if not isinstance(values, pd.DataFrame) or values.empty:
        raise ValueError("M1 requires a non-empty market panel")
    dates = pd.DatetimeIndex(pd.to_datetime(values.index)).sort_values()
    if dates.has_duplicates:
        raise ValueError("M1 market panel dates must be unique")
    return dates


def _expected_grid_parameters(
    baseline: Mapping[str, Any],
    variants: Sequence[Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    result = {"baseline": dict(baseline)}
    for variant in variants:
        variant_id = str(variant["variantId"])
        result[variant_id] = {
            "variantId": variant_id,
            "window": variant["window"],
            "topN": variant["topN"],
            "costModel": baseline["costModel"],
        }
    return result


def _load_bound_grid_artifacts(
    *,
    spec: Mapping[str, Any],
    panel_identity: str,
    root: Path,
    dates: pd.DatetimeIndex,
    baseline: Mapping[str, Any],
    variants: Sequence[Mapping[str, Any]],
) -> tuple[
    tuple[
        dict[str, list[dict[str, Any]]],
        list[str],
        Literal["existing_grid_artifacts", "fixed_grid_rerun"],
    ]
    | None,
    bool,
]:
    path = _grid_context_path(spec, root)
    if not path.is_file():
        return None, False
    if path.is_symlink():
        return None, True
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping) or set(payload) != {
            "schemaVersion",
            "specHash",
            "panelIdentity",
            "mode",
            "dailyReturnRefs",
            "manifestDigest",
        }:
            raise RuntimeError("M1 host grid context shape is invalid")
        core = {key: value for key, value in payload.items() if key != "manifestDigest"}
        expected_digest = f"sha256:{sha256(_canonical_bytes(core)).hexdigest()}"
        mode = payload.get("mode")
        references = payload.get("dailyReturnRefs")
        if (
            payload.get("schemaVersion") != GRID_CONTEXT_SCHEMA_VERSION
            or payload.get("specHash") != _spec_hash(spec)
            or payload.get("panelIdentity") != panel_identity
            or payload.get("manifestDigest") != expected_digest
            or mode
            not in {
                "existing_grid_artifacts",
                "fixed_grid_rerun",
            }
            or not isinstance(references, list)
            or len(references) != MOIRE_GRID_VARIANT_COUNT + 1
            or any(not isinstance(value, str) for value in references)
        ):
            raise RuntimeError("M1 host grid context identity is invalid")
        expected = _expected_grid_parameters(baseline, variants)
        ordered_ids = [
            "baseline",
            *[str(value["variantId"]) for value in variants],
        ]
        daily_by_variant: dict[str, list[dict[str, Any]]] = {}
        for variant_id, reference in zip(
            ordered_ids,
            references,
            strict=True,
        ):
            payload = _read_grid_artifact_reference(reference, root=root)
            if (
                payload["variantId"] != variant_id
                or payload["params"] != expected[variant_id]
            ):
                raise RuntimeError("M1 bound grid artifact is invalid")
            daily_by_variant[variant_id] = _validated_daily_rows(
                payload["dailyReturns"],
                dates,
            )
        return (
            daily_by_variant,
            list(references),
            mode,
        ), True
    except (
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        ValueError,
        RuntimeError,
    ):
        # A present but invalid binding must never fall through to an
        # unbound directory scan. The authorized deterministic rerun replaces
        # it with a new exact binding.
        return None, True


def _persist_grid_context(
    *,
    spec: Mapping[str, Any],
    panel_identity: str,
    mode: Literal["existing_grid_artifacts", "fixed_grid_rerun"],
    references: Sequence[str],
    root: Path,
) -> None:
    if len(references) != MOIRE_GRID_VARIANT_COUNT + 1 or any(
        not isinstance(reference, str)
        or not reference.startswith(DAILY_RETURNS_REF_PREFIX)
        for reference in references
    ):
        raise RuntimeError("M1 grid context references are invalid")
    core = {
        "schemaVersion": GRID_CONTEXT_SCHEMA_VERSION,
        "specHash": _spec_hash(spec),
        "panelIdentity": panel_identity,
        "mode": mode,
        "dailyReturnRefs": list(references),
    }
    payload = {
        **core,
        "manifestDigest": (f"sha256:{sha256(_canonical_bytes(core)).hexdigest()}"),
    }
    _write_atomic(
        _grid_context_path(spec, root),
        _canonical_bytes(payload),
    )


def _grid_context_path(
    spec: Mapping[str, Any],
    root: Path,
) -> Path:
    digest = _spec_hash(spec).removeprefix("sha256:")
    return root / GRID_CONTEXT_DIRECTORY / f"{digest}.json"


def _load_complete_grid_artifacts(
    *,
    root: Path,
    dates: pd.DatetimeIndex,
    baseline: Mapping[str, Any],
    variants: Sequence[Mapping[str, Any]],
) -> (
    tuple[
        dict[str, list[dict[str, Any]]],
        list[str],
        Literal["existing_grid_artifacts"],
    ]
    | None
):
    expected = _expected_grid_parameters(baseline, variants)
    candidates: dict[
        str,
        list[tuple[str, list[dict[str, Any]]]],
    ] = {variant_id: [] for variant_id in expected}
    directory = root / "param-grid"
    if not directory.is_dir():
        return None
    for path in sorted(directory.glob("sha256-*.json")):
        try:
            reference, payload = _read_grid_artifact_file(path, root=root)
            variant_id = payload["variantId"]
            if variant_id not in expected or payload["params"] != expected[variant_id]:
                continue
            rows = _validated_daily_rows(payload["dailyReturns"], dates)
        except (OSError, UnicodeError, ValueError, RuntimeError):
            continue
        candidates[variant_id].append((reference, rows))
    if any(len(value) != 1 for value in candidates.values()):
        return None
    ordered_ids = ["baseline", *[str(value["variantId"]) for value in variants]]
    return (
        {variant_id: candidates[variant_id][0][1] for variant_id in ordered_ids},
        [candidates[variant_id][0][0] for variant_id in ordered_ids],
        "existing_grid_artifacts",
    )


def _grid_artifacts_from_result(
    result: Mapping[str, Any],
    *,
    root: Path,
    dates: pd.DatetimeIndex,
    baseline: Mapping[str, Any],
    variants: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, list[dict[str, Any]]], list[str]]:
    if not isinstance(result, Mapping):
        raise RuntimeError("M1 grid reconstruction returned an invalid result")
    summaries = [result.get("baseline")]
    variant_summaries = result.get("variants")
    if (
        not isinstance(variant_summaries, list)
        or len(variant_summaries) != MOIRE_GRID_VARIANT_COUNT
    ):
        raise RuntimeError("M1 grid reconstruction is incomplete")
    summaries.extend(variant_summaries)
    expected = _expected_grid_parameters(baseline, variants)
    ordered_ids = ["baseline", *[str(value["variantId"]) for value in variants]]
    daily_by_variant: dict[str, list[dict[str, Any]]] = {}
    references: list[str] = []
    for variant_id, summary in zip(ordered_ids, summaries, strict=True):
        if not isinstance(summary, Mapping):
            raise RuntimeError("M1 grid summary is invalid")
        parameters = summary.get("params")
        if not isinstance(parameters, Mapping):
            raise RuntimeError("M1 grid summary params are invalid")
        reference = parameters.get("dailyReturnsRef")
        if not isinstance(reference, str):
            raise RuntimeError("M1 grid summary lacks a daily-return reference")
        payload = _read_grid_artifact_reference(reference, root=root)
        if (
            payload["variantId"] != variant_id
            or payload["params"] != expected[variant_id]
        ):
            raise RuntimeError("M1 grid artifact identity is invalid")
        daily_by_variant[variant_id] = _validated_daily_rows(
            payload["dailyReturns"],
            dates,
        )
        references.append(reference)
    return daily_by_variant, references


def _read_grid_artifact_reference(
    reference: str,
    *,
    root: Path,
) -> Mapping[str, Any]:
    path = daily_returns_artifact_path(reference, root=root)
    parsed_reference, payload = _read_grid_artifact_file(path, root=root)
    if parsed_reference != reference:
        raise RuntimeError("M1 grid artifact reference does not match content")
    return payload


def _read_grid_artifact_file(
    path: Path,
    *,
    root: Path,
) -> tuple[str, Mapping[str, Any]]:
    if path.is_symlink():
        raise RuntimeError("M1 grid artifact identity is invalid")
    try:
        content = path.read_bytes()
        payload = json.loads(content.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("M1 grid artifact is unreadable") from error
    digest = sha256(content).hexdigest()
    expected_path = root / "param-grid" / f"sha256-{digest}.json"
    if path.resolve() != expected_path.resolve():
        raise RuntimeError("M1 grid artifact content hash is invalid")
    if not isinstance(payload, Mapping) or set(payload) != {
        "schemaVersion",
        "engineVersion",
        "kind",
        "variantId",
        "params",
        "dailyReturns",
    }:
        raise RuntimeError("M1 grid artifact shape is invalid")
    if (
        payload.get("schemaVersion") != DAILY_RETURNS_ARTIFACT_SCHEMA_VERSION
        or payload.get("engineVersion") != ENGINE_VERSION
        or payload.get("kind") != "parameter_grid"
        or not isinstance(payload.get("variantId"), str)
        or not isinstance(payload.get("params"), Mapping)
    ):
        raise RuntimeError("M1 grid artifact identity is invalid")
    return f"{DAILY_RETURNS_REF_PREFIX}{digest}", payload


def _validated_daily_rows(
    value: Any,
    dates: pd.DatetimeIndex,
) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) != len(dates):
        raise RuntimeError("M1 daily-return rows do not match panel dates")
    expected_dates = [pd.Timestamp(date).strftime("%Y-%m-%d") for date in dates]
    rows: list[dict[str, Any]] = []
    for expected_date, raw_row in zip(expected_dates, value, strict=True):
        if not isinstance(raw_row, Mapping) or set(raw_row) != {
            "date",
            "return",
            "equity",
        }:
            raise RuntimeError("M1 daily-return row shape is invalid")
        if raw_row.get("date") != expected_date:
            raise RuntimeError("M1 daily-return dates are invalid")
        row: dict[str, Any] = {"date": expected_date}
        for name in ("return", "equity"):
            number = raw_row.get(name)
            if (
                isinstance(number, bool)
                or not isinstance(number, (int, float))
                or not isfinite(float(number))
            ):
                raise RuntimeError("M1 daily-return value is nonfinite")
            row[name] = float(number)
        rows.append(row)
    prior_equity = 1.0
    for row in rows:
        expected_equity = prior_equity * (1.0 + float(row["return"]))
        actual_equity = float(row["equity"])
        if (
            actual_equity <= 0
            or not isfinite(expected_equity)
            or not np.isclose(
                actual_equity,
                expected_equity,
                rtol=1e-10,
                atol=1e-12,
            )
        ):
            raise RuntimeError("M1 daily-return equity path is invalid")
        prior_equity = actual_equity
    return rows


def _environment_sharpe(
    daily_rows: Sequence[Mapping[str, Any]],
    *,
    labels: pd.DataFrame,
    environment_id: str,
) -> float | None:
    frame = pd.DataFrame([dict(value) for value in daily_rows])
    if set(frame) != {"date", "return", "equity"}:
        raise RuntimeError("M1 daily-return series is invalid")
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame["return"] = pd.to_numeric(frame["return"], errors="coerce")
    if frame[["date", "return"]].isna().any().any():
        raise RuntimeError("M1 daily-return series is invalid")
    frame = frame.set_index("date").sort_index()
    joined = frame.join(labels[["id"]], how="left")
    returns = joined.loc[joined["id"].eq(environment_id), "return"]
    if len(returns) < 2:
        return None
    standard_deviation = float(returns.std(ddof=1))
    if not isfinite(standard_deviation) or standard_deviation <= 0:
        return None
    value = float(returns.mean()) / standard_deviation * sqrt(TRADING_DAYS_PER_YEAR)
    return value if isfinite(value) else None


def _pessimistic_variant(
    ladder: Mapping[str, Any],
) -> Mapping[str, Any]:
    variants = ladder.get("variants") if isinstance(ladder, Mapping) else None
    if not isinstance(variants, list) or len(variants) != 3:
        raise RuntimeError("M2 corrected cost ladder is incomplete")
    matches = [
        value
        for value in variants
        if isinstance(value, Mapping)
        and isinstance(value.get("params"), Mapping)
        and value["params"].get("costModel") == "pessimistic"
    ]
    if len(matches) != 1:
        raise RuntimeError("M2 pessimistic cost variant is missing")
    return matches[0]


def _panel_identity(panel: MarketPanel) -> str:
    prices, tradable, _ = _normalize_corrected_context(
        panel,
        pd.DataFrame(
            True,
            index=panel.adjusted_close.index,
            columns=panel.adjusted_close.columns,
            dtype=bool,
        ),
    )
    payload = {
        "dates": [pd.Timestamp(value).strftime("%Y-%m-%d") for value in prices.index],
        "symbols": [str(value) for value in prices.columns],
        "adjustedClose": [
            [None if pd.isna(value) else float(value) for value in row]
            for row in prices.to_numpy(dtype=float)
        ],
        "tradable": tradable.to_numpy(dtype=bool).tolist(),
    }
    return f"sha256:{sha256(_canonical_bytes(payload)).hexdigest()}"


def _normalize_corrected_context(
    panel: MarketPanel,
    eligible: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    if not isinstance(panel.adjusted_close, pd.DataFrame) or panel.adjusted_close.empty:
        raise ValueError("corrected context requires a non-empty panel")
    prices = panel.adjusted_close.copy()
    prices.index = pd.DatetimeIndex(pd.to_datetime(prices.index))
    prices.columns = [str(value) for value in prices.columns]
    if prices.index.has_duplicates or prices.columns.has_duplicates:
        raise ValueError("corrected context panel keys must be unique")
    prices = prices.sort_index().sort_index(axis=1)
    prices = prices.apply(pd.to_numeric, errors="coerce").astype(float)
    if (
        np.isinf(prices.to_numpy(dtype=float)).any()
        or (prices.dropna(how="all") <= 0).to_numpy().any()
    ):
        raise ValueError("corrected context prices are invalid")
    tradable = (
        panel.tradable.reindex(
            index=prices.index,
            columns=prices.columns,
        )
        .fillna(False)
        .astype(bool)
    )
    eligibility = (
        eligible.reindex(
            index=prices.index,
            columns=prices.columns,
        )
        .fillna(False)
        .astype(bool)
    )
    return prices, tradable, eligibility


def _context_dates(value: Any) -> pd.DatetimeIndex:
    if not isinstance(value, list) or not value:
        raise RuntimeError("M2 corrected host context dates are invalid")
    parsed = pd.DatetimeIndex(pd.to_datetime(value, errors="coerce"))
    canonical = [date.strftime("%Y-%m-%d") for date in parsed]
    if (
        parsed.isna().any()
        or parsed.has_duplicates
        or canonical != value
        or not parsed.is_monotonic_increasing
    ):
        raise RuntimeError("M2 corrected host context dates are invalid")
    return parsed


def _context_symbols(value: Any) -> list[str]:
    if (
        not isinstance(value, list)
        or not value
        or any(not isinstance(item, str) or not item for item in value)
        or value != sorted(set(value))
    ):
        raise RuntimeError("M2 corrected host context symbols are invalid")
    return value


def _numeric_context_matrix(
    value: Any,
    *,
    rows: int,
    columns: int,
) -> list[list[float | None]]:
    if (
        not isinstance(value, list)
        or len(value) != rows
        or any(not isinstance(row, list) or len(row) != columns for row in value)
    ):
        raise RuntimeError("M2 corrected price matrix is invalid")
    result: list[list[float | None]] = []
    for row in value:
        parsed_row: list[float | None] = []
        for item in row:
            if item is None:
                parsed_row.append(None)
            elif (
                isinstance(item, bool)
                or not isinstance(item, (int, float))
                or not isfinite(float(item))
                or float(item) <= 0
            ):
                raise RuntimeError("M2 corrected price matrix is invalid")
            else:
                parsed_row.append(float(item))
        result.append(parsed_row)
    return result


def _boolean_context_matrix(
    value: Any,
    *,
    rows: int,
    columns: int,
) -> list[list[bool]]:
    if (
        not isinstance(value, list)
        or len(value) != rows
        or any(
            not isinstance(row, list)
            or len(row) != columns
            or any(not isinstance(item, bool) for item in row)
            for row in value
        )
    ):
        raise RuntimeError("M2 corrected boolean matrix is invalid")
    return value


def _spec_hash(spec: Mapping[str, Any]) -> str:
    try:
        content = _canonical_bytes(dict(spec))
    except (TypeError, ValueError) as error:
        raise ValueError("Moiré spec must be canonical JSON data") from error
    return f"sha256:{sha256(content).hexdigest()}"


def _backtest_artifact_root(value: Path | None) -> Path:
    return value or Path(
        os.environ.get(
            "ASSAY_BACKTEST_ARTIFACT_ROOT",
            str(DEFAULT_BACKTEST_ARTIFACT_ROOT),
        )
    )


def _corrected_context_root(value: Path | None) -> Path:
    pit_root = value or Path(
        os.environ.get("ASSAY_PIT_CACHE_ROOT", str(DEFAULT_PIT_CACHE_ROOT))
    )
    return pit_root / CORRECTED_CONTEXT_DIRECTORY


def _persist_moire_artifact(
    payload: Mapping[str, Any],
    *,
    dispute_id: Literal["M1", "M2"],
    root: Path | None,
) -> str:
    content = _canonical_bytes(dict(payload))
    digest = sha256(content).hexdigest()
    artifact_root = root or Path(
        os.environ.get(
            "ASSAY_MOIRE_ARTIFACT_ROOT",
            str(DEFAULT_MOIRE_ARTIFACT_ROOT),
        )
    )
    path = artifact_root / dispute_id / f"sha256-{digest}.json"
    _write_content_addressed(path, content)
    prefix = M1_SOURCE_REF_PREFIX if dispute_id == "M1" else M2_SOURCE_REF_PREFIX
    return f"{prefix}{digest}"


def _canonical_bytes(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        dict(value),
        allow_nan=False,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _write_content_addressed(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise RuntimeError("Moiré artifact target is invalid")
    if path.is_file():
        if path.read_bytes() != content:
            raise RuntimeError("Moiré content-addressed artifact collision")
        return
    temporary_path = _write_temporary(path, content)
    try:
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _write_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise RuntimeError("Moiré host context target is invalid")
    if path.is_file() and path.read_bytes() == content:
        return
    temporary_path = _write_temporary(path, content)
    try:
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _write_temporary(path: Path, content: bytes) -> Path:
    with tempfile.NamedTemporaryFile(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as temporary:
        temporary.write(content)
        temporary.flush()
        os.fsync(temporary.fileno())
        return Path(temporary.name)
