"""Production stdio entry point for the sprint backtest experiment tool."""

from __future__ import annotations

import json
import sys
from typing import Any

from .engine import run_request
from .market_panel import load_market_panel


def main() -> int:
    try:
        request: Any = json.load(sys.stdin)
        response = run_request(request, panel_loader=load_market_panel)
        sys.stdout.write(
            json.dumps(response, allow_nan=False, separators=(",", ":")) + "\n"
        )
        return 0
    except Exception as error:
        # Unknown vendor exceptions may include sensitive response details.
        # Only our validation messages are safe enough to cross stderr.
        safe_message = (
            str(error)
            if isinstance(error, (ValueError, TypeError))
            else "experiment execution failed"
        )
        sys.stderr.write(
            json.dumps(
                {"error": type(error).__name__, "message": safe_message},
                allow_nan=False,
                separators=(",", ":"),
            )
            + "\n"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
