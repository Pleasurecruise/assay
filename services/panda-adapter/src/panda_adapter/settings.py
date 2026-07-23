from __future__ import annotations

from dataclasses import dataclass
import os


class PandaDataConfigurationError(RuntimeError):
    """Raised when required PandaData configuration is unavailable."""


@dataclass(frozen=True, slots=True)
class PandaDataSettings:
    username: str
    password: str

    @classmethod
    def from_environment(cls) -> "PandaDataSettings":
        username = os.environ.get("PANDA_DATA_USERNAME", "").strip()
        password = os.environ.get("PANDA_DATA_PASSWORD", "")

        missing = [
            name
            for name, value in (
                ("PANDA_DATA_USERNAME", username),
                ("PANDA_DATA_PASSWORD", password),
            )
            if not value
        ]
        if missing:
            names = ", ".join(missing)
            raise PandaDataConfigurationError(
                f"Missing required environment variables: {names}"
            )

        return cls(username=username, password=password)
