"""Strict readers for the operator-prepared v9 audit cache."""

from __future__ import annotations

import json
import math
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Final, Literal

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


@dataclass(frozen=True, slots=True)
class PitMembershipCache:
    snapshots: Mapping[pd.Timestamp, frozenset[str]]
    cache_version: str


@dataclass(frozen=True, slots=True)
class HistoricalMembersPolicy:
    mode: Literal["full_pit", "remove_only"]
    cache_version: str
    reason_code: str | None


def load_historical_members_policy(
    root: Path,
    *,
    pit_cache_root: Path,
    base_symbols: Sequence[str],
    panel_dates: Sequence[pd.Timestamp],
) -> HistoricalMembersPolicy:
    """Read a promoted P1 policy bound to the panel and PIT cache in use."""

    cache_root, manifest = _read_ready_manifest(root)
    if manifest is None:
        raise RuntimeError("configured v9 cache manifest is missing")
    if manifest.get("cacheVersion") != V9_CACHE_VERSION:
        raise RuntimeError("v9 cache manifest version cannot govern availability")
    if manifest.get("promoted") is not True:
        raise RuntimeError("v9 cache manifest is not promoted")
    state = manifest.get("state")
    if state not in {"ready", "degraded"}:
        raise RuntimeError("v9 cache manifest state cannot govern availability")

    _validate_manifest_panel_identity(
        manifest,
        base_symbols=base_symbols,
        panel_dates=panel_dates,
    )
    datasets = manifest["datasets"]
    base_panel = datasets.get("basePanel")
    if not isinstance(base_panel, Mapping) or base_panel.get("status") != "ready":
        raise RuntimeError("v9 cache base panel is not ready")
    timeline = datasets.get("pitTimeline")
    if not isinstance(timeline, Mapping) or timeline.get("status") != "ready":
        raise RuntimeError("v9 cache PIT timeline is not ready")
    _validate_pit_root_binding(
        cache_root=cache_root,
        pit_cache_root=pit_cache_root,
        dataset=timeline,
    )
    historical = datasets.get("historicalMembers")
    if not isinstance(historical, Mapping):
        raise RuntimeError("v9 historical-members policy is missing")
    if historical.get("columns") != [
        "date",
        "symbol",
        "adjClose",
        "tradeStatus",
    ]:
        raise RuntimeError("v9 historical-members columns are invalid")

    status = historical.get("status")
    mode = historical.get("mode")
    if status == "ready" and mode == "full_pit":
        _dataset_path(cache_root, historical)
        return HistoricalMembersPolicy(
            mode="full_pit",
            cache_version=V9_CACHE_VERSION,
            reason_code=None,
        )
    assumptions = historical.get("assumptions")
    quality = historical.get("quality")
    if (
        state == "degraded"
        and status == "degraded"
        and mode == "remove_only"
        and historical.get("reasonCode")
        == "HISTORICAL_MEMBER_DATA_UNAVAILABLE"
        and historical.get("path") is None
        and isinstance(assumptions, list)
        and assumptions
        and all(isinstance(item, str) and item.strip() for item in assumptions)
        and all(
            type(historical.get(name)) is int and historical.get(name) == 0
            for name in ("rowCount", "tradingDates", "symbols")
        )
        and isinstance(quality, Mapping)
        and quality.get("primaryKeysValid") is False
        and quality.get("verified") is False
    ):
        return HistoricalMembersPolicy(
            mode="remove_only",
            cache_version=V9_CACHE_VERSION,
            reason_code="HISTORICAL_MEMBER_DATA_UNAVAILABLE",
        )
    raise RuntimeError("v9 historical-members policy is not authorized")


def _validate_manifest_panel_identity(
    manifest: Mapping[str, Any],
    *,
    base_symbols: Sequence[str],
    panel_dates: Sequence[pd.Timestamp],
) -> None:
    symbols = tuple(sorted(str(value).strip().upper() for value in base_symbols))
    if (
        not symbols
        or any(not symbol for symbol in symbols)
        or len(set(symbols)) != len(symbols)
    ):
        raise RuntimeError("availability panel symbol identity is invalid")
    universe = manifest.get("universe")
    if not isinstance(universe, Mapping):
        raise RuntimeError("v9 cache universe identity is missing")
    universe_hash = sha256("\n".join(symbols).encode("utf-8")).hexdigest()[:16]
    if (
        universe.get("indexSymbol") != INDEX_SYMBOL
        or universe.get("baseSymbols") != len(symbols)
        or universe.get("baseUniverseHash") != universe_hash
    ):
        raise RuntimeError("v9 cache universe does not match the availability panel")

    dates = pd.DatetimeIndex(pd.to_datetime(list(panel_dates), errors="coerce"))
    if dates.empty or dates.isna().any():
        raise RuntimeError("availability panel date identity is invalid")
    window = manifest.get("window")
    if not isinstance(window, Mapping):
        raise RuntimeError("v9 cache window identity is missing")
    start = _canonical_manifest_date(window.get("start"), "start")
    end = _canonical_manifest_date(window.get("end"), "end")
    if start > dates.min() or end < dates.max():
        raise RuntimeError("v9 cache window does not cover the availability panel")


def _canonical_manifest_date(value: Any, name: str) -> pd.Timestamp:
    if not isinstance(value, str):
        raise RuntimeError(f"v9 cache window {name} is invalid")
    parsed = pd.to_datetime(value, errors="coerce")
    if pd.isna(parsed) or pd.Timestamp(parsed).strftime("%Y-%m-%d") != value:
        raise RuntimeError(f"v9 cache window {name} is invalid")
    return pd.Timestamp(parsed)


def _validate_pit_root_binding(
    *,
    cache_root: Path,
    pit_cache_root: Path,
    dataset: Mapping[str, Any],
) -> None:
    value = dataset.get("path")
    if not isinstance(value, str) or not value:
        raise RuntimeError("v9 cache PIT timeline path is missing")
    relative = Path(value)
    if relative.is_absolute():
        raise RuntimeError("v9 cache PIT timeline path must be relative")
    observed = (cache_root.parent / relative).resolve()
    expected = (
        pit_cache_root
        / "index-weights"
        / INDEX_SYMBOL.replace(".", "_")
    ).resolve()
    if observed != expected:
        raise RuntimeError("v9 cache PIT timeline is bound to another cache root")


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


def load_pit_membership_cache(
    root: Path | None = None,
) -> PitMembershipCache:
    """Read the promoted P1 PIT membership timeline without any live fallback."""

    cache_root, manifest = _read_ready_manifest(root)
    if manifest is None:
        raise RuntimeError("PIT constituent proxy requires the prepared v9 cache")
    if manifest.get("cacheVersion") != V9_CACHE_VERSION:
        raise RuntimeError("PIT constituent proxy cache version is invalid")
    if manifest.get("promoted") is not True:
        raise RuntimeError("PIT constituent proxy cache is not promoted")
    datasets = manifest["datasets"]
    dataset = datasets.get("pitTimeline")
    if not isinstance(dataset, Mapping) or dataset.get("status") != "ready":
        raise RuntimeError("PIT constituent proxy timeline is not ready")
    if dataset.get("columns") != [
        "requestedDate",
        "effectiveDate",
        "symbols",
    ]:
        raise RuntimeError("PIT constituent proxy timeline columns are invalid")

    directory = _dataset_directory(cache_root, dataset)
    paths = sorted(directory.glob("*.json"))
    if not paths:
        raise RuntimeError("PIT constituent proxy timeline is empty")

    snapshots: dict[pd.Timestamp, frozenset[str]] = {}
    member_counts: dict[str, int] = {}
    union: set[str] = set()
    row_count = 0
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeError("PIT constituent proxy snapshot is unreadable") from error
        if not isinstance(payload, Mapping):
            raise RuntimeError("PIT constituent proxy snapshot must be an object")
        requested_text = payload.get("requestedDate")
        effective_text = payload.get("effectiveDate")
        symbols = payload.get("symbols")
        requested = pd.to_datetime(requested_text, errors="coerce")
        effective = pd.to_datetime(effective_text, errors="coerce")
        if (
            payload.get("schemaVersion") != "pit-index-snapshot-v1"
            or payload.get("indexSymbol") != INDEX_SYMBOL
            or not isinstance(requested_text, str)
            or pd.isna(requested)
            or pd.Timestamp(requested).strftime("%Y-%m-%d") != requested_text
            or path.stem != pd.Timestamp(requested).strftime("%Y%m%d")
            or not isinstance(effective_text, str)
            or pd.isna(effective)
            or pd.Timestamp(effective).strftime("%Y-%m-%d") != effective_text
            or pd.Timestamp(effective) > pd.Timestamp(requested)
            or not isinstance(symbols, list)
            or not symbols
            or any(
                not isinstance(symbol, str)
                or re.fullmatch(r"\d{6}\.(?:SH|SZ)", symbol) is None
                for symbol in symbols
            )
            or symbols != sorted(set(symbols))
        ):
            raise RuntimeError("PIT constituent proxy snapshot identity is invalid")
        requested_date = pd.Timestamp(requested)
        if requested_date in snapshots:
            raise RuntimeError("PIT constituent proxy dates are duplicated")
        members = frozenset(symbols)
        snapshots[requested_date] = members
        member_counts[requested_text] = len(members)
        union.update(members)
        row_count += len(members)

    quality = dataset.get("quality")
    if (
        type(dataset.get("downloaded")) is not int
        or dataset.get("downloaded") != len(snapshots)
        or type(dataset.get("tradingDates")) is not int
        or dataset.get("tradingDates") != len(snapshots)
        or type(dataset.get("rowCount")) is not int
        or dataset.get("rowCount") != row_count
        or type(dataset.get("symbols")) is not int
        or dataset.get("symbols") != len(union)
        or not isinstance(quality, Mapping)
        or quality.get("pointCount") != len(snapshots)
        or quality.get("memberCounts") != member_counts
        or quality.get("primaryKeysValid") is not True
    ):
        raise RuntimeError("PIT constituent proxy timeline does not reconcile")
    return PitMembershipCache(
        snapshots=dict(sorted(snapshots.items())),
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


def _dataset_directory(
    root: Path,
    dataset: Mapping[str, Any],
) -> Path:
    value = dataset.get("path")
    if not isinstance(value, str) or not value:
        raise RuntimeError("v9 cache dataset path is missing")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError("v9 cache dataset path must be a contained relative path")
    candidates = [
        candidate
        for candidate in ((root / relative).resolve(), (root.parent / relative).resolve())
        if candidate.is_dir()
    ]
    unique = list(dict.fromkeys(candidates))
    if len(unique) != 1:
        raise RuntimeError("v9 cache dataset directory is missing or ambiguous")
    return unique[0]
