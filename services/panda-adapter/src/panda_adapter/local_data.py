"""Verified readers for immutable, strategy-selected local data packages."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
from typing import Any, Final

import pandas as pd

from .audit_cache import (
    ComparatorFactorCache,
    HistoricalMembersPolicy,
    IndexDailyCache,
    PitMembershipCache,
    V9_CACHE_MANIFEST_SCHEMA_VERSION,
    load_comparator_factor_cache,
    load_historical_members_policy,
    load_index_daily_cache,
    load_pit_membership_cache,
)
from .market_panel import INDEX_SYMBOL, MarketPanel, _read_cache

LOCAL_DATA_REF_VERSION: Final = "assay-local-data-v1"
LOCAL_DATA_PACKAGE_SCHEMA_VERSION: Final = "assay-local-data-package-v1"
LOCAL_DATA_PACKAGE_ROOT_ENV: Final = "ASSAY_LOCAL_DATA_PACKAGE_ROOT"
LOCAL_DATA_DERIVED_ROOT_ENV: Final = "ASSAY_AUDIT_OUTPUT_ROOT"

_AUDIT_IDENTIFIER_PATTERN = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"
_PACKAGE_IDENTIFIER_PATTERN = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"
_DATA_REF_PATTERN = re.compile(
    rf"^{LOCAL_DATA_REF_VERSION}:"
    rf"(?P<audit_id>{_AUDIT_IDENTIFIER_PATTERN}):"
    rf"(?P<package_id>{_PACKAGE_IDENTIFIER_PATTERN}):"
    r"(?P<digest>sha256-[a-f0-9]{64})$"
)
_DIGEST_PATTERN = re.compile(r"^sha256-[a-f0-9]{64}$")
_PLAN_DATE_PATTERN = re.compile(r"^\d{8}$")
_STORAGE_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CAPABILITIES: Final = {
    "trade_calendar",
    "pit_membership",
    "adjusted_close",
    "trade_status",
    "index_daily",
    "comparator_factors",
}
_REQUIRED_READY_CAPABILITIES: Final = {
    "trade_calendar",
    "pit_membership",
    "adjusted_close",
    "trade_status",
}
_MANIFEST_KEYS: Final = {
    "schemaVersion",
    "packageId",
    "strategyKey",
    "universe",
    "window",
    "coverage",
    "capabilities",
    "paths",
    "checksums",
}


@dataclass(frozen=True, slots=True)
class ParsedLocalDataRef:
    audit_id: str
    package_id: str
    manifest_digest: str


@dataclass(frozen=True, slots=True)
class LocalAuditData:
    """A verified local package exposed through the deterministic audit interface."""

    data_ref: str
    root: Path
    audit_id: str
    package_id: str
    manifest_digest: str
    manifest: Mapping[str, Any]
    market_data_path: Path
    audit_support_root: Path
    pit_membership_root: Path
    audit_manifest: Mapping[str, Any]

    @property
    def cache_version(self) -> str:
        value = self.audit_manifest.get("cacheVersion")
        if not isinstance(value, str) or not value:
            raise RuntimeError("local data audit cache version is invalid")
        return value

    @property
    def derived_root(self) -> Path:
        """Return a task-scoped mutable area outside the immutable package."""

        raw = os.environ.get(LOCAL_DATA_DERIVED_ROOT_ENV)
        if raw is None or not raw.strip():
            raise RuntimeError(
                f"{LOCAL_DATA_DERIVED_ROOT_ENV} must configure the derived-data root"
            )
        runtime_root = Path(raw)
        if runtime_root.is_symlink():
            raise RuntimeError("local derived-data runtime root must not be a symbolic link")
        runtime_root.mkdir(parents=True, exist_ok=True)
        runtime_root = runtime_root.resolve()
        root = runtime_root / "local-derived"
        audit_root = root / self.audit_id
        package_root = audit_root / self.manifest_digest
        for candidate, boundary, label in (
            (root, runtime_root, "local derived-data root"),
            (audit_root, root, "local derived-data audit root"),
            (package_root, audit_root, "local derived-data package"),
        ):
            if candidate.is_symlink():
                raise RuntimeError(f"{label} must not be a symbolic link")
            candidate.mkdir(exist_ok=True)
            _require_directory_within(candidate, boundary=boundary, label=label)
        return package_root.resolve()

    def require_spec_identity(self, spec: Mapping[str, Any]) -> None:
        if not isinstance(spec, Mapping):
            raise ValueError("local data requires a strategy spec object")
        universe = spec.get("universe")
        window = spec.get("window")
        manifest_universe = self.manifest["universe"]
        manifest_window = self.manifest["window"]
        if (
            not isinstance(universe, Mapping)
            or universe.get("index") != manifest_universe["indexSymbol"]
            or not isinstance(window, Mapping)
            or set(window) != {"start", "end"}
            or window.get("start") != manifest_window["start"]
            or window.get("end") != manifest_window["end"]
            or _strategy_key(spec) != self.manifest["strategyKey"]
        ):
            raise ValueError(
                "local dataRef strategy identity does not match the frozen strategy spec"
            )

    def full_market_panel(self, spec: Mapping[str, Any]) -> MarketPanel:
        self.require_spec_identity(spec)
        return _read_cache(self.market_data_path, spec)

    def as_of_market_panel(self, spec: Mapping[str, Any]) -> MarketPanel:
        panel = self.full_market_panel(spec)
        coverage = self.manifest["coverage"]
        snapshots = self.pit_membership_cache().snapshots
        symbols = snapshots.get(pd.Timestamp(coverage["asOf"]))
        if symbols is None or not symbols:
            raise RuntimeError("local data package has no as-of membership snapshot")
        missing = sorted(set(symbols) - set(panel.adjusted_close.columns))
        if missing:
            raise RuntimeError(
                "local market panel does not cover every as-of constituent"
            )
        ordered = sorted(symbols)
        return MarketPanel(
            adjusted_close=panel.adjusted_close.reindex(columns=ordered),
            tradable=panel.tradable.reindex(columns=ordered).fillna(False).astype(bool),
        )

    def pit_membership_cache(self) -> PitMembershipCache:
        return load_pit_membership_cache(self.audit_support_root)

    def index_daily_cache(self) -> IndexDailyCache | None:
        return load_index_daily_cache(self.audit_support_root)

    def comparator_factor_cache(self) -> ComparatorFactorCache | None:
        return load_comparator_factor_cache(self.audit_support_root)

    def historical_members_policy(
        self,
        spec: Mapping[str, Any],
    ) -> HistoricalMembersPolicy:
        panel = self.full_market_panel(spec)
        return load_historical_members_policy(
            self.audit_support_root,
            pit_cache_root=self.pit_membership_root,
            base_symbols=tuple(str(value) for value in panel.adjusted_close.columns),
            panel_dates=tuple(pd.Timestamp(value) for value in panel.adjusted_close.index),
        )


def parse_local_data_ref(value: Any) -> ParsedLocalDataRef:
    if not isinstance(value, str):
        raise ValueError("dataRef must be a string")
    match = _DATA_REF_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError("dataRef is not a valid Assay local-data reference")
    return ParsedLocalDataRef(
        audit_id=match.group("audit_id"),
        package_id=match.group("package_id"),
        manifest_digest=match.group("digest"),
    )


def local_data_package_root(root: Path | None = None) -> Path:
    configured = root
    if configured is None:
        raw = os.environ.get(LOCAL_DATA_PACKAGE_ROOT_ENV)
        if raw is None or not raw.strip():
            raise RuntimeError(
                f"{LOCAL_DATA_PACKAGE_ROOT_ENV} must configure the local-data package root"
            )
        configured = Path(raw)
    if configured.is_symlink():
        raise RuntimeError("local data package root must not be a symbolic link")
    resolved = configured.resolve()
    if not resolved.is_dir():
        raise RuntimeError("local data package root is unavailable")
    return resolved


def load_local_audit_data(
    data_ref: str,
    *,
    root: Path | None = None,
) -> LocalAuditData:
    parsed = parse_local_data_ref(data_ref)
    registry_root = local_data_package_root(root)
    package_root = _resolve_directory(
        registry_root,
        parsed.package_id,
        "local data package",
    )
    manifest_path = package_root / "manifest.json"
    manifest_bytes = _read_regular_file(
        manifest_path,
        boundary=package_root,
        label="local data package manifest",
    )
    observed_manifest_digest = f"sha256-{sha256(manifest_bytes).hexdigest()}"
    if observed_manifest_digest != parsed.manifest_digest:
        raise RuntimeError("local data package manifest digest mismatch")
    try:
        manifest = json.loads(manifest_bytes)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("local data package manifest is unreadable") from error
    if not isinstance(manifest, Mapping):
        raise RuntimeError("local data package manifest must be an object")
    _validate_manifest(manifest, package_id=parsed.package_id)

    paths = manifest["paths"]
    market_data_path = _resolve_file(
        package_root,
        paths["marketData"],
        "local market data",
    )
    audit_support_root = _resolve_directory(
        package_root,
        paths["auditSupport"],
        "local audit-support root",
    )
    pit_membership_root = _resolve_directory(
        package_root,
        paths["pitMembership"],
        "local PIT-membership root",
    )
    audit_manifest_path = audit_support_root / "manifest.json"
    market_bytes = _read_regular_file(
        market_data_path,
        boundary=package_root,
        label="local market data",
    )
    audit_manifest_bytes = _read_regular_file(
        audit_manifest_path,
        boundary=audit_support_root,
        label="local audit-support manifest",
    )
    checksums = manifest["checksums"]
    if f"sha256-{sha256(market_bytes).hexdigest()}" != checksums["marketData"]:
        raise RuntimeError("local market-data digest mismatch")
    audit_support_digest = (
        f"sha256-{_tree_digest(audit_support_root, label='local audit-support')}"
    )
    if audit_support_digest != checksums["auditSupport"]:
        raise RuntimeError("local audit-support digest mismatch")

    universe = manifest["universe"]
    pit_membership_digest = (
        f"sha256-{_tree_digest(pit_membership_root, label='local PIT-membership')}"
    )
    if pit_membership_digest != checksums["pitMembership"]:
        raise RuntimeError("local PIT-membership digest mismatch")

    try:
        audit_manifest = json.loads(audit_manifest_bytes)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("local audit-support manifest is unreadable") from error
    if not isinstance(audit_manifest, Mapping):
        raise RuntimeError("local audit-support manifest must be an object")
    _validate_audit_binding(manifest, audit_manifest)

    local_data = LocalAuditData(
        data_ref=data_ref,
        root=package_root,
        audit_id=parsed.audit_id,
        package_id=parsed.package_id,
        manifest_digest=parsed.manifest_digest,
        manifest=manifest,
        market_data_path=market_data_path,
        audit_support_root=audit_support_root,
        pit_membership_root=pit_membership_root,
        audit_manifest=audit_manifest,
    )
    # Parse the complete immutable boundary once. Downstream calls may parse
    # again, but they cannot be the first place corruption is discovered.
    panel = _read_cache(
        market_data_path,
        {
            "universe": {"index": universe["indexSymbol"]},
            "window": manifest["window"],
        },
    )
    local_data.pit_membership_cache()
    local_data.index_daily_cache()
    local_data.comparator_factor_cache()
    load_historical_members_policy(
        audit_support_root,
        pit_cache_root=pit_membership_root,
        base_symbols=tuple(str(value) for value in panel.adjusted_close.columns),
        panel_dates=tuple(pd.Timestamp(value) for value in panel.adjusted_close.index),
    )
    return local_data


def _validate_manifest(
    value: Mapping[str, Any],
    *,
    package_id: str,
) -> None:
    universe = value.get("universe")
    window = value.get("window")
    coverage = value.get("coverage")
    capabilities = value.get("capabilities")
    paths = value.get("paths")
    checksums = value.get("checksums")
    if (
        set(value) != _MANIFEST_KEYS
        or value.get("schemaVersion") != LOCAL_DATA_PACKAGE_SCHEMA_VERSION
        or value.get("packageId") != package_id
        or not isinstance(value.get("strategyKey"), str)
        or not _DIGEST_PATTERN.fullmatch(str(value.get("strategyKey")))
        or not isinstance(universe, Mapping)
        or set(universe) != {"indexSymbol", "membershipMode"}
        or universe.get("indexSymbol") != INDEX_SYMBOL
        or universe.get("membershipMode") != "point_in_time"
        or not isinstance(window, Mapping)
        or set(window) != {"start", "end"}
        or not isinstance(coverage, Mapping)
        or set(coverage) != {"start", "end", "asOf"}
        or not isinstance(capabilities, Mapping)
        or set(capabilities) != _CAPABILITIES
        or not all(status in {"ready", "degraded"} for status in capabilities.values())
        or any(
            capabilities[capability] != "ready"
            for capability in _REQUIRED_READY_CAPABILITIES
        )
        or not isinstance(paths, Mapping)
        or set(paths) != {"marketData", "auditSupport", "pitMembership"}
        or not all(isinstance(path, str) and path for path in paths.values())
        or not isinstance(checksums, Mapping)
        or set(checksums) != {"marketData", "auditSupport", "pitMembership"}
        or not all(
            isinstance(digest, str) and _DIGEST_PATTERN.fullmatch(digest)
            for digest in checksums.values()
        )
    ):
        raise RuntimeError("local data package manifest is invalid")
    start = _plan_date(window["start"], "local package window start")
    end = _plan_date(window["end"], "local package window end")
    coverage_start = _storage_date(
        coverage["start"],
        "local package coverage start",
    )
    coverage_end = _storage_date(coverage["end"], "local package coverage end")
    coverage_as_of = _storage_date(
        coverage["asOf"],
        "local package coverage as-of",
    )
    if (
        start > end
        or coverage_start > coverage_end
        or coverage_as_of < coverage_end
        or coverage_start > start
        or coverage_end < end
    ):
        raise RuntimeError("local data package window or coverage is invalid")


def _validate_audit_binding(
    package_manifest: Mapping[str, Any],
    audit_manifest: Mapping[str, Any],
) -> None:
    universe = package_manifest["universe"]
    coverage = package_manifest["coverage"]
    capabilities = package_manifest["capabilities"]
    manifest_universe = audit_manifest.get("universe")
    manifest_window = audit_manifest.get("window")
    datasets = audit_manifest.get("datasets")
    if (
        audit_manifest.get("schemaVersion") != V9_CACHE_MANIFEST_SCHEMA_VERSION
        or audit_manifest.get("promoted") is not True
        or audit_manifest.get("state") not in {"ready", "degraded"}
        or not isinstance(manifest_universe, Mapping)
        or manifest_universe.get("indexSymbol") != universe["indexSymbol"]
        or not isinstance(manifest_window, Mapping)
        or set(manifest_window) != {"start", "end"}
        or not isinstance(datasets, Mapping)
    ):
        raise RuntimeError("local data package audit-support identity is invalid")
    manifest_start = _storage_date(
        manifest_window["start"],
        "local audit-support window start",
    )
    manifest_end = _storage_date(
        manifest_window["end"],
        "local audit-support window end",
    )
    coverage_start = _storage_date(coverage["start"], "local package coverage start")
    coverage_end = _storage_date(coverage["end"], "local package coverage end")
    base_panel = datasets.get("basePanel")
    if (
        manifest_start < coverage_start
        or manifest_end != coverage_end
        or not isinstance(base_panel, Mapping)
        or base_panel.get("status") != "ready"
        or base_panel.get("factorWindowAnchor") != coverage["start"]
    ):
        raise RuntimeError("local data package audit-support coverage is invalid")

    pit_timeline = datasets.get("pitTimeline")
    historical = datasets.get("historicalMembers")
    index_daily = datasets.get("indexDaily")
    comparators = datasets.get("comparatorFactors")
    if (
        capabilities["trade_calendar"] != "ready"
        or capabilities["pit_membership"] != "ready"
        or capabilities["adjusted_close"] != "ready"
        or capabilities["trade_status"] != "ready"
        or not isinstance(pit_timeline, Mapping)
        or pit_timeline.get("status") != "ready"
        or not isinstance(historical, Mapping)
        or not (
            (
                historical.get("status") == "ready"
                and historical.get("mode") == "full_pit"
            )
            or (
                historical.get("status") == "degraded"
                and historical.get("mode") == "remove_only"
                and historical.get("reasonCode")
                == "HISTORICAL_MEMBER_DATA_UNAVAILABLE"
            )
        )
        or not _optional_capability_matches(
            capabilities["index_daily"],
            index_daily,
            ready_mode="official_index",
            degraded_mode="constituent_proxy",
            degraded_reason="INDEX_DAILY_UNAVAILABLE",
        )
        or not _optional_capability_matches(
            capabilities["comparator_factors"],
            comparators,
            ready_mode="library_and_classic",
            degraded_mode="classic_only",
            degraded_reason="COMPARATOR_FACTORS_UNAVAILABLE",
        )
    ):
        raise RuntimeError(
            "local data package capabilities do not match audit support"
        )


def _optional_capability_matches(
    expected: Any,
    dataset: Any,
    *,
    ready_mode: str,
    degraded_mode: str,
    degraded_reason: str,
) -> bool:
    if not isinstance(dataset, Mapping):
        return False
    if expected == "ready":
        return dataset.get("status") == "ready" and dataset.get("mode") == ready_mode
    return (
        expected == "degraded"
        and dataset.get("status") == "degraded"
        and dataset.get("mode") == degraded_mode
        and dataset.get("reasonCode") == degraded_reason
    )


def _strategy_key(spec: Mapping[str, Any]) -> str:
    universe = spec.get("universe")
    signal = spec.get("signal")
    selection = spec.get("selection")
    rebalance = spec.get("rebalance")
    window = spec.get("window")
    if (
        not isinstance(spec.get("specVersion"), str)
        or not isinstance(universe, Mapping)
        or not isinstance(signal, Mapping)
        or not isinstance(selection, Mapping)
        or not isinstance(rebalance, Mapping)
        or not isinstance(window, Mapping)
    ):
        raise ValueError("local data requires a canonical strategy spec")
    kind = signal.get("kind")
    if kind == "library":
        canonical_signal: Mapping[str, Any] = {
            "kind": kind,
            "name": signal.get("name"),
        }
    elif kind == "template":
        params = signal.get("params")
        if not isinstance(params, Mapping):
            raise ValueError("local data requires a canonical strategy spec")
        canonical_signal = {
            "kind": kind,
            "template": signal.get("template"),
            "params": {
                "window": params.get("window"),
                **(
                    {}
                    if "direction" not in params
                    else {"direction": params.get("direction")}
                ),
            },
        }
    else:
        raise ValueError("local data requires a canonical strategy spec")
    strategy = {
        "specVersion": spec["specVersion"],
        "universe": {"index": universe.get("index")},
        "signal": canonical_signal,
        "selection": {
            "topN": selection.get("topN"),
            "weighting": selection.get("weighting"),
        },
        "rebalance": {
            "frequency": rebalance.get("frequency"),
            "at": rebalance.get("at"),
        },
        "window": {
            "start": window.get("start"),
            "end": window.get("end"),
        },
    }
    try:
        canonical = json.dumps(
            strategy,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError("local data requires a canonical strategy spec") from error
    return f"sha256-{sha256(canonical).hexdigest()}"


def _tree_digest(root: Path, *, label: str) -> str:
    resolved_root = _resolve_directory(root.parent, root.name, label)
    paths: list[tuple[bytes, str, Path]] = []
    for candidate in resolved_root.rglob("*"):
        relative = candidate.relative_to(resolved_root).as_posix()
        try:
            status = candidate.lstat()
        except OSError as error:
            raise RuntimeError(f"{label} is unreadable") from error
        if stat.S_ISLNK(status.st_mode):
            raise RuntimeError(f"{label} must not contain symbolic links")
        if stat.S_ISREG(status.st_mode):
            paths.append((relative.encode("utf-8"), relative, candidate))
        elif not stat.S_ISDIR(status.st_mode):
            raise RuntimeError(f"{label} contains an unsupported entry")
    if not paths:
        raise RuntimeError(f"{label} is empty")
    digest = sha256()
    for relative_bytes, _relative, candidate in sorted(
        paths,
        key=lambda item: item[0],
    ):
        content = _read_regular_file(
            candidate,
            boundary=resolved_root,
            label=f"{label} file",
        )
        digest.update(relative_bytes)
        digest.update(b"\0")
        digest.update(content)
    return digest.hexdigest()


def _resolve_file(root: Path, value: str, label: str) -> Path:
    candidate = _safe_candidate(root, value, label)
    _read_regular_file(candidate, boundary=root, label=label)
    return candidate.resolve()


def _resolve_directory(root: Path, value: str, label: str) -> Path:
    candidate = _safe_candidate(root, value, label)
    _require_directory_within(candidate, boundary=root, label=label)
    return candidate.resolve()


def _safe_candidate(root: Path, value: str, label: str) -> Path:
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise RuntimeError(f"{label} path is invalid")
    candidate = root / relative
    if candidate.is_symlink():
        raise RuntimeError(f"{label} must not be a symbolic link")
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise RuntimeError(f"{label} escapes the local data package root")
    return candidate


def _read_regular_file(
    path: Path,
    *,
    boundary: Path,
    label: str,
) -> bytes:
    if path.is_symlink():
        raise RuntimeError(f"{label} must not be a symbolic link")
    resolved = path.resolve()
    if not resolved.is_relative_to(boundary.resolve()):
        raise RuntimeError(f"{label} escapes its package boundary")
    try:
        status = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(status.st_mode):
            raise RuntimeError(f"{label} is unavailable")
        return path.read_bytes()
    except OSError as error:
        raise RuntimeError(f"{label} is unreadable") from error


def _require_directory_within(
    path: Path,
    *,
    boundary: Path,
    label: str,
) -> None:
    if path.is_symlink():
        raise RuntimeError(f"{label} must not be a symbolic link")
    resolved = path.resolve()
    if not resolved.is_relative_to(boundary.resolve()) or not resolved.is_dir():
        raise RuntimeError(f"{label} is unavailable")


def _plan_date(value: Any, label: str) -> pd.Timestamp:
    if not isinstance(value, str) or _PLAN_DATE_PATTERN.fullmatch(value) is None:
        raise RuntimeError(f"{label} is invalid")
    parsed = pd.to_datetime(value, format="%Y%m%d", errors="coerce")
    if pd.isna(parsed):
        raise RuntimeError(f"{label} is invalid")
    return pd.Timestamp(parsed)


def _storage_date(value: Any, label: str) -> pd.Timestamp:
    if (
        not isinstance(value, str)
        or _STORAGE_DATE_PATTERN.fullmatch(value) is None
    ):
        raise RuntimeError(f"{label} is invalid")
    parsed = pd.to_datetime(value, format="%Y-%m-%d", errors="coerce")
    if pd.isna(parsed):
        raise RuntimeError(f"{label} is invalid")
    return pd.Timestamp(parsed)
