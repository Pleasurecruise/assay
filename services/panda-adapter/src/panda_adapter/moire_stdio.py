"""Sanitized stdin/stdout boundary for host-only Moiré experiments."""

from __future__ import annotations

import json
import sys
from typing import Any

from .moire_audit import run_moire_request


def main() -> int:
    try:
        request: Any = json.load(sys.stdin)
        response = run_moire_request(request)
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
