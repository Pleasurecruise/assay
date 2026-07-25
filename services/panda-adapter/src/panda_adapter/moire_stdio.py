"""Sanitized stdin/stdout boundary for host-only Moiré experiments."""

from __future__ import annotations

import json
import sys
from typing import Any

from .availability_audit import PIT_DATASET_VERSION
from .local_data import (
    LOCAL_DATA_REF_VERSION,
    load_local_audit_data,
)
from .moire_audit import run_moire_request


def main() -> int:
    try:
        request: Any = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError("Moiré request must be an object")
        data_ref = request.get("dataRef")
        if data_ref is not None and (
            not isinstance(data_ref, str) or not data_ref.strip()
        ):
            raise ValueError("Moiré request dataRef must be a non-empty string")
        if (
            isinstance(data_ref, str)
            and data_ref.startswith(f"{LOCAL_DATA_REF_VERSION}:")
        ):
            spec = request.get("spec")
            if not isinstance(spec, dict):
                raise ValueError("Moiré request spec must be an object")
            local_data = load_local_audit_data(data_ref)
            local_data.require_spec_identity(spec)
            response = run_moire_request(
                {
                    "kind": request.get("kind"),
                    "spec": spec,
                },
                panel_loader=local_data.as_of_market_panel,
                index_loader=local_data.index_daily_cache,
                membership_loader=local_data.pit_membership_cache,
                pit_cache_root=local_data.derived_root,
                corrected_cache_version=local_data.cache_version,
                corrected_pit_dataset_version=PIT_DATASET_VERSION,
            )
        elif data_ref is None or data_ref == "legacy-cache:offline-moire-fixture":
            # Unit-test and cache-preparation callers without a host dataRef
            # retain the existing environment-backed loaders. The exact
            # legacy-cache sentinel is reserved for the checked-in offline
            # Moiré mechanism fixture; production never emits it.
            legacy_request = {
                key: value
                for key, value in request.items()
                if key != "dataRef"
            }
            response = run_moire_request(legacy_request)
        else:
            raise ValueError(
                "Moiré request dataRef must be an Assay local-data reference"
            )
        sys.stdout.write(
            json.dumps(response, allow_nan=False, separators=(",", ":")) + "\n"
        )
        return 0
    except Exception as error:
        # Never forward provider errors, local paths, or corrected context.
        message = (
            str(error)
            if isinstance(error, (ValueError, TypeError))
            else "Moiré experiment execution failed"
        )
        sys.stderr.write(
            json.dumps(
                {"error": type(error).__name__, "message": message},
                allow_nan=False,
                separators=(",", ":"),
            )
            + "\n"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
