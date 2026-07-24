from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from importlib import import_module
import json
from time import monotonic, sleep
from types import ModuleType
from typing import Any, Callable

from .settings import PandaDataSettings


class PandaDataNotInitializedError(RuntimeError):
    """Raised when SDK methods are called before token initialization."""


class PandaDataInitializationError(RuntimeError):
    """Raised when the SDK rejects process-level token initialization."""


class PandaDataOperationError(RuntimeError):
    """Raised when a caller requests an operation outside the guarded allowlist."""


PANDA_DATA_OPERATIONS = {
    "market_data": "get_market_data",
    "adj_factor": "get_adj_factor",
    "index_weights": "get_index_weights",
    "trade_list": "get_trade_list",
    "stock_status_change": "get_stock_status_change",
    "factor": "get_factor",
    "trade_calendar": "get_trade_cal",
    "financial_forecast": "get_fina_forecast",
    "financial_performance": "get_fina_performance",
    "financial_reports": "get_fina_reports",
}

RETRYABLE_PROVIDER_CODES = {
    "400002",
    "500001",
    "500003",
    "500004",
    "500005",
    "500006",
    "500009",
    "500010",
}


@dataclass(slots=True)
class _CacheEntry:
    expires_at: float
    value: Any


class PandaDataClient:
    """Owns the process-level PandaData SDK initialization boundary."""

    def __init__(
        self,
        sdk_module: ModuleType | Any | None = None,
        *,
        cache_ttl_seconds: float = 300,
        max_cache_entries: int = 128,
        max_attempts: int = 3,
        clock: Callable[[], float] = monotonic,
        sleeper: Callable[[float], None] = sleep,
    ) -> None:
        if cache_ttl_seconds < 0:
            raise ValueError("cache_ttl_seconds must not be negative")
        if max_cache_entries < 1:
            raise ValueError("max_cache_entries must be positive")
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        self._sdk_module = sdk_module
        self._is_initialized = False
        self._cache_ttl_seconds = cache_ttl_seconds
        self._max_cache_entries = max_cache_entries
        self._max_attempts = max_attempts
        self._clock = clock
        self._sleeper = sleeper
        self._cache: OrderedDict[str, _CacheEntry] = OrderedDict()

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
        return self.query("market_data", parameters)

    def get_index_daily(self, **parameters: Any) -> Any:
        return self._query_method(
            operation="index_daily",
            method_name="get_index_daily",
            parameters=parameters,
        )

    def query(self, operation: str, parameters: dict[str, Any]) -> Any:
        if not self._is_initialized:
            raise PandaDataNotInitializedError(
                "PandaData must be initialized before requesting data"
            )
        method_name = PANDA_DATA_OPERATIONS.get(operation)
        if method_name is None:
            raise PandaDataOperationError(
                f'PandaData operation "{operation}" is not allowed'
            )
        return self._query_method(
            operation=operation,
            method_name=method_name,
            parameters=parameters,
        )

    def _query_method(
        self,
        *,
        operation: str,
        method_name: str,
        parameters: dict[str, Any],
    ) -> Any:
        if not self._is_initialized:
            raise PandaDataNotInitializedError(
                "PandaData must be initialized before requesting data"
            )
        cache_key = json.dumps(
            {"operation": operation, "parameters": parameters},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        cached = self._cache.get(cache_key)
        now = self._clock()
        if cached is not None and cached.expires_at >= now:
            self._cache.move_to_end(cache_key)
            return cached.value
        if cached is not None:
            del self._cache[cache_key]

        method = getattr(self._load_sdk(), method_name)
        for attempt in range(1, self._max_attempts + 1):
            try:
                value = method(**parameters)
                break
            except Exception as error:
                if attempt >= self._max_attempts or not _is_retryable(error):
                    raise
                self._sleeper(0.25 * (2 ** (attempt - 1)))

        if self._cache_ttl_seconds > 0:
            self._cache[cache_key] = _CacheEntry(
                expires_at=now + self._cache_ttl_seconds,
                value=value,
            )
            self._cache.move_to_end(cache_key)
            while len(self._cache) > self._max_cache_entries:
                self._cache.popitem(last=False)
        return value

    def get_factor(self, **parameters: Any) -> Any:
        return self.query("factor", parameters)

    def get_adj_factor(self, **parameters: Any) -> Any:
        return self.query("adj_factor", parameters)

    def get_index_weights(self, **parameters: Any) -> Any:
        return self.query("index_weights", parameters)

    def _load_sdk(self) -> ModuleType | Any:
        if self._sdk_module is None:
            self._sdk_module = import_module("panda_data")
        return self._sdk_module


def _is_retryable(error: Exception) -> bool:
    code = getattr(error, "code", None)
    if code is not None and str(code) in RETRYABLE_PROVIDER_CODES:
        return True
    message = str(error).lower()
    return any(marker in message for marker in ("429", "rate limit", "timeout"))


def create_initialized_client(
    settings: PandaDataSettings | None = None,
) -> PandaDataClient:
    client = PandaDataClient()
    client.initialize(settings or PandaDataSettings.from_environment())
    return client
