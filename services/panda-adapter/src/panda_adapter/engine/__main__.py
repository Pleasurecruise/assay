"""Read one S0 JSON request from stdin and write one JSON response to stdout."""

from __future__ import annotations

import json
import sys
from typing import Any

from .protocol import run_request


def main() -> int:
    try:
        request: Any = json.load(sys.stdin)
        response = run_request(request)
        print(json.dumps(response, allow_nan=False, separators=(",", ":")))
        return 0
    except Exception as error:
        response = {
            "error": type(error).__name__,
            "message": str(error),
        }
        print(
            json.dumps(response, allow_nan=False, separators=(",", ":")),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
