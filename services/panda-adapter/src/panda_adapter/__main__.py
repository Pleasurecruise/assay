from __future__ import annotations

import argparse
from importlib import import_module
import json
import sys

from .client import (
    PandaDataClient,
    PandaDataInitializationError,
    create_initialized_client,
)
from .protocol import error_response, execute_request
from .settings import PandaDataConfigurationError


def _handle_request(client: PandaDataClient, raw: str) -> dict[str, object]:
    request_id = "unknown"
    try:
        request = json.loads(raw)
        if isinstance(request, dict) and isinstance(request.get("id"), str):
            request_id = request["id"]
        return execute_request(client, request)
    except Exception as error:
        return error_response(request_id, error)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate or initialize the PandaData SDK boundary."
    )
    parser.add_argument(
        "command",
        choices=("doctor", "initialize", "query", "serve"),
        help="Check installation or perform a real credential initialization.",
    )
    args = parser.parse_args()

    try:
        import_module("panda_data")
    except Exception as error:
        parser.error(
            "panda_data is unavailable or incompatible; "
            f"run the SDK sync command first ({type(error).__name__})"
        )

    if args.command == "doctor":
        print("PandaData SDK installation is available.")
        return 0

    try:
        client = create_initialized_client()
    except (PandaDataConfigurationError, PandaDataInitializationError) as error:
        parser.error(str(error))

    if not client.is_initialized:
        parser.error("PandaData SDK initialization did not complete")

    if args.command == "query":
        response = _handle_request(client, sys.stdin.read())
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
        return 0

    if args.command == "serve":
        for line in sys.stdin:
            if not line.strip():
                continue
            response = _handle_request(client, line)
            print(
                json.dumps(response, ensure_ascii=False, separators=(",", ":")),
                flush=True,
            )
        return 0

    print("PandaData SDK initialization completed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
