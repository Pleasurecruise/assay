"""Atomic content-addressed artifacts produced by deterministic experiments."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Final

from .constants import (
    DAILY_RETURNS_ARTIFACT_SCHEMA_VERSION,
    ENGINE_VERSION,
)

DEFAULT_BACKTEST_ARTIFACT_ROOT: Final = Path(
    ".cache/assay/backtest-artifacts-v1"
)
DAILY_RETURNS_REF_PREFIX: Final = (
    "artifact:backtest/param-grid/daily-returns/sha256-"
)


def persist_grid_daily_returns(
    *,
    variant_id: str,
    parameters: Mapping[str, Any],
    daily_returns: Sequence[Mapping[str, Any]],
    root: Path | None = None,
) -> str:
    """Persist one grid series and return a path-free content URI."""

    if not isinstance(variant_id, str) or not variant_id:
        raise ValueError("daily-return artifact variant_id must be non-empty")
    rows = [dict(row) for row in daily_returns]
    if not rows:
        raise ValueError("daily-return artifact requires at least one row")
    for row in rows:
        if set(row) != {"date", "return", "equity"}:
            raise ValueError(
                "daily-return artifact rows require date, return, and equity"
            )

    payload = {
        "schemaVersion": DAILY_RETURNS_ARTIFACT_SCHEMA_VERSION,
        "engineVersion": ENGINE_VERSION,
        "kind": "parameter_grid",
        "variantId": variant_id,
        "params": dict(parameters),
        "dailyReturns": rows,
    }
    content = json.dumps(
        payload,
        allow_nan=False,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    digest = sha256(content).hexdigest()
    artifact_root = root or Path(
        os.environ.get(
            "ASSAY_BACKTEST_ARTIFACT_ROOT",
            str(DEFAULT_BACKTEST_ARTIFACT_ROOT),
        )
    )
    path = artifact_root / "param-grid" / f"sha256-{digest}.json"
    _write_content_addressed(path, content)
    return f"{DAILY_RETURNS_REF_PREFIX}{digest}"


def daily_returns_artifact_path(reference: str, *, root: Path) -> Path:
    """Resolve a trusted content URI for internal consumers and tests."""

    if not reference.startswith(DAILY_RETURNS_REF_PREFIX):
        raise ValueError("daily-return artifact reference is invalid")
    digest = reference.removeprefix(DAILY_RETURNS_REF_PREFIX)
    if len(digest) != 64 or any(
        character not in "0123456789abcdef" for character in digest
    ):
        raise ValueError("daily-return artifact digest is invalid")
    return root / "param-grid" / f"sha256-{digest}.json"


def _write_content_addressed(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        if path.read_bytes() != content:
            raise RuntimeError("content-addressed artifact digest collision")
        return

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        try:
            os.replace(temporary_path, path)
        except OSError:
            if not path.is_file() or path.read_bytes() != content:
                raise
        temporary_path = None
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
