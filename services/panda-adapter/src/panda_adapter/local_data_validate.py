"""Offline semantic validation for an installed local-data registry."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from .local_data import (
    LOCAL_DATA_PACKAGE_ROOT_ENV,
    LOCAL_DATA_REF_VERSION,
    load_local_audit_data,
    local_data_package_root,
)

DEFAULT_LOCAL_DATA_PACKAGE_ROOT = Path(".cache/assay/local-packages")


@dataclass(frozen=True, slots=True)
class ValidatedLocalPackage:
    package_id: str
    manifest_digest: str


def validate_local_data_registry(root: Path) -> tuple[ValidatedLocalPackage, ...]:
    registry_root = local_data_package_root(root)
    package_roots = sorted(
        (
            candidate
            for candidate in registry_root.iterdir()
            if not candidate.is_symlink() and candidate.is_dir()
        ),
        key=lambda candidate: candidate.name.encode("utf-8"),
    )
    if not package_roots:
        raise RuntimeError("local data package registry is empty")

    validated: list[ValidatedLocalPackage] = []
    for package_root in package_roots:
        manifest_path = package_root / "manifest.json"
        try:
            manifest_bytes = manifest_path.read_bytes()
        except OSError as error:
            raise RuntimeError("local data package manifest is unreadable") from error
        manifest_digest = f"sha256-{sha256(manifest_bytes).hexdigest()}"
        data_ref = (
            f"{LOCAL_DATA_REF_VERSION}:offline_validation:"
            f"{package_root.name}:{manifest_digest}"
        )
        loaded = load_local_audit_data(data_ref, root=registry_root)
        validated.append(
            ValidatedLocalPackage(
                package_id=loaded.package_id,
                manifest_digest=loaded.manifest_digest,
            )
        )
    return tuple(validated)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate installed Assay local-data packages without PandaData."
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Installed local-data registry (normally .cache/assay/local-packages).",
    )
    args = parser.parse_args()
    configured_root = args.root
    if configured_root is None:
        environment_root = os.environ.get(LOCAL_DATA_PACKAGE_ROOT_ENV, "").strip()
        configured_root = (
            Path(environment_root)
            if environment_root
            else DEFAULT_LOCAL_DATA_PACKAGE_ROOT
        )
    try:
        validated = validate_local_data_registry(configured_root)
    except (OSError, RuntimeError, ValueError) as error:
        parser.error(str(error))
    for package in validated:
        print(f"{package.package_id} {package.manifest_digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
