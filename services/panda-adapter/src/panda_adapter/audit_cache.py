"""Strict readers for the operator-prepared v9 audit cache."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
from typing import Any, Final

import pandas as pd

from .market_panel import INDEX_SYMBOL

V9_CACHE_VERSION: Final = "assay-v9-p1-v1"
V9_CACHE_MANIFEST_SCHEMA_VERSION: Final = "assay-p1-cache-manifest-v1"
DEFAULT_V9_CACHE_ROOT: Final = Path(".cache/assay/v9-p1-v1")


@dataclass(frozen=True, slots=True)
class IndexDailyCache:
    close: pd.Series
    cache_version: str


@dataclass(frozen=True, slots=True)
class ComparatorFactorCache:
    values: Mapping[str, pd.DataFrame]
    cache_version: str


def load_index_daily_cache(
    root: Path | None = None,
) -> IndexDailyCache | None:
    cache_root, manifest = _read_ready_manifest(root)
    if manifest is None:
        return None
    dataset = _ready_dataset(manifest, "indexDaily")
    if dataset is None:
        return None
    path = _dataset_path(cache_root, dataset)
    frame = pd.read_csv(path)
    expected = ["date", "symbol", "close"]
    if list(frame.columns) != expected:
        raise RuntimeError("index-daily cache columns are invalid")
    if frame.empty:
        raise RuntimeError("index-daily cache is empty")
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame["symbol"] = frame["symbol"].astype(str)
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    if (
        frame["date"].isna().any()
        or frame["symbol"].ne(INDEX_SYMBOL).any()
        or frame.duplicated(["date", "symbol"]).any()
        or not frame["close"].map(
            lambda value: math.isfinite(float(value)) and float(value) > 0
        ).all()
    ):
        raise RuntimeError("index-daily cache canonical values are invalid")
    close = (
        frame.set_index("date")["close"]
        .astype(float)
        .sort_index()
    )
    return IndexDailyCache(
        close=close,
        cache_version=_cache_version(manifest),
    )


def load_comparator_factor_cache(
    root: Path | None = None,
) -> ComparatorFactorCache | None:
    cache_root, manifest = _read_ready_manifest(root)
    if manifest is None:
        return None
    dataset = _ready_dataset(manifest, "comparatorFactors")
    if dataset is None:
        return None
    path = _dataset_path(cache_root, dataset)
    frame = pd.read_csv(path)
    expected = ["date", "symbol", "ratio_pe_ttm", "market_cap"]
    if list(frame.columns) != expected:
        raise RuntimeError("comparator-factor cache columns are invalid")
    if frame.empty:
        raise RuntimeError("comparator-factor cache is empty")
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame["symbol"] = frame["symbol"].astype(str).str.strip().str.upper()
    if (
        frame["date"].isna().any()
        or frame["symbol"].eq("").any()
        or frame.duplicated(["date", "symbol"]).any()
    ):
        raise RuntimeError("comparator-factor cache keys are invalid")
    for column in ("ratio_pe_ttm", "market_cap"):
        raw_values = frame[column]
        numeric_values = pd.to_numeric(raw_values, errors="coerce")
        invalid_values = (
            raw_values.notna()
            & raw_values.astype(str).str.strip().ne("")
            & numeric_values.isna()
        )
        if invalid_values.any():
            raise RuntimeError(
                f"comparator-factor cache {column} contains invalid values"
            )
        frame[column] = numeric_values
        if frame[column].map(
            lambda value: pd.isna(value) or math.isfinite(float(value))
        ).eq(False).any():
            raise RuntimeError(
                f"comparator-factor cache {column} contains nonfinite values"
            )
    values = {
        column: (
            frame.pivot(index="date", columns="symbol", values=column)
            .sort_index()
            .sort_index(axis=1)
        )
        for column in ("ratio_pe_ttm", "market_cap")
    }
    return ComparatorFactorCache(
        values=values,
        cache_version=_cache_version(manifest),
    )


def _read_ready_manifest(
    root: Path | None,
) -> tuple[Path, Mapping[str, Any] | None]:
    cache_root = root or Path(
        os.environ.get("ASSAY_V9_CACHE_ROOT", str(DEFAULT_V9_CACHE_ROOT))
    )
    path = cache_root / "manifest.json"
    if not path.is_file():
        return cache_root, None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("v9 cache manifest is unreadable") from error
    if not isinstance(value, Mapping):
        raise RuntimeError("v9 cache manifest must be an object")
    if value.get("schemaVersion") != V9_CACHE_MANIFEST_SCHEMA_VERSION:
        raise RuntimeError("v9 cache manifest schema is unsupported")
    datasets = value.get("datasets")
    if not isinstance(datasets, Mapping):
        raise RuntimeError("v9 cache manifest datasets are invalid")
    _cache_version(value)
    return cache_root, value


def _cache_version(manifest: Mapping[str, Any]) -> str:
    value = manifest.get("cacheVersion", manifest.get("datasetVersion"))
    if not isinstance(value, str) or not value:
        # The v9 cache root itself is versioned; retain compatibility with the
        # first P1 manifest while still returning an explicit identity.
        value = V9_CACHE_VERSION
    return value


def _ready_dataset(
    manifest: Mapping[str, Any],
    name: str,
) -> Mapping[str, Any] | None:
    datasets = manifest["datasets"]
    value = datasets.get(name)
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise RuntimeError(f"v9 cache dataset {name} is invalid")
    if value.get("status") != "ready":
        return None
    return value


def _dataset_path(
    root: Path,
    dataset: Mapping[str, Any],
) -> Path:
    value = dataset.get("path")
    if not isinstance(value, str) or not value:
        raise RuntimeError("v9 cache dataset path is missing")
    relative = Path(value)
    if relative.is_absolute():
        raise RuntimeError("v9 cache dataset path must be relative")
    resolved_root = root.resolve()
    # P1 records paths relative to the common `.cache/assay` root, while the
    # consumer is rooted at its version directory. Accept that canonical
    # `v9-p1-v1/...` prefix as well as a version-root-relative test fixture.
    base = root.parent if relative.parts[:1] == (root.name,) else root
    resolved = (base / relative).resolve()
    if resolved_root != resolved.parent and resolved_root not in resolved.parents:
        raise RuntimeError("v9 cache dataset path escapes its root")
    if not resolved.is_file():
        raise RuntimeError("v9 cache ready dataset file is missing")
    return resolved
