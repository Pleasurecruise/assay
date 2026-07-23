from __future__ import annotations

import argparse
from importlib import import_module

from .client import PandaDataInitializationError, create_initialized_client
from .settings import PandaDataConfigurationError


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate or initialize the PandaData SDK boundary."
    )
    parser.add_argument(
        "command",
        choices=("doctor", "initialize"),
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

    print("PandaData SDK initialization completed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
