from __future__ import annotations

from importlib import import_module
from types import ModuleType
from typing import Any

from .settings import PandaDataSettings


class PandaDataNotInitializedError(RuntimeError):
    """Raised when SDK methods are called before token initialization."""


class PandaDataInitializationError(RuntimeError):
    """Raised when the SDK rejects process-level token initialization."""


class PandaDataClient:
    """Owns the process-level PandaData SDK initialization boundary."""

    def __init__(self, sdk_module: ModuleType | Any | None = None) -> None:
        self._sdk_module = sdk_module
        self._is_initialized = False

    @property
    def is_initialized(self) -> bool:
        return self._is_initialized

    def initialize(self, settings: PandaDataSettings) -> None:
        if self._is_initialized:
            return

        sdk_module = self._load_sdk()
        try:
            sdk_module.init_token(
                username=settings.username,
                password=settings.password,
            )
        except Exception as error:
            raise PandaDataInitializationError(
                "PandaData token initialization failed"
            ) from error
        self._is_initialized = True

    def get_market_data(self, **parameters: Any) -> Any:
        if not self._is_initialized:
            raise PandaDataNotInitializedError(
                "PandaData must be initialized before requesting market data"
            )

        return self._load_sdk().get_market_data(**parameters)

    def _load_sdk(self) -> ModuleType | Any:
        if self._sdk_module is None:
            self._sdk_module = import_module("panda_data")
        return self._sdk_module


def create_initialized_client(
    settings: PandaDataSettings | None = None,
) -> PandaDataClient:
    client = PandaDataClient()
    client.initialize(settings or PandaDataSettings.from_environment())
    return client
