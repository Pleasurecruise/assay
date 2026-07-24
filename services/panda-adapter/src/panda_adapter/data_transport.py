"""Bounded retry policy for PandaData's recurrent transport failures."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from http.client import IncompleteRead, RemoteDisconnected
import re
from time import sleep
from typing import TypeVar
from urllib.error import HTTPError, URLError

T = TypeVar("T")


class DataTransportError(RuntimeError):
    """Raised after a retryable data transport operation exhausts its budget."""


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 5
    initial_delay_seconds: float = 1.0
    max_delay_seconds: float = 8.0


DEFAULT_RETRY_POLICY = RetryPolicy()
_RETRYABLE_TYPES = (
    BrokenPipeError,
    ConnectionError,
    IncompleteRead,
    RemoteDisconnected,
    TimeoutError,
)
_RETRYABLE_TEXT = (
    "incompleteread",
    "remote end closed connection",
    "connection reset",
    "connection aborted",
    "timed out",
    "http 500",
    "http 429",
    "http 502",
    "http 503",
    "http 504",
)
_RETRYABLE_SERVICE_CODES = {
    400002,
    500001,
    500002,
    500003,
    500004,
    500005,
    500006,
    600001,
    900001,
}
_SERVICE_CODE_PATTERN = re.compile(r"(?:错误码|error code)\D*(\d{6})", re.IGNORECASE)


def is_retryable_transport_error(error: BaseException) -> bool:
    """Inspect an exception chain for a transient network/HTTP failure."""

    current: BaseException | None = error
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(current, HTTPError):
            if current.code == 429 or 500 <= current.code < 600:
                return True
            current = current.__cause__ or current.__context__
            continue
        if isinstance(current, URLError):
            return True
        if isinstance(current, _RETRYABLE_TYPES):
            return True
        if getattr(current, "code", None) in _RETRYABLE_SERVICE_CODES:
            return True
        message = str(current).lower()
        message_codes = {
            int(value) for value in _SERVICE_CODE_PATTERN.findall(message)
        }
        if message_codes & _RETRYABLE_SERVICE_CODES:
            return True
        if any(marker in message for marker in _RETRYABLE_TEXT):
            return True
        current = current.__cause__ or current.__context__
    return False


def retry_transport(
    label: str,
    operation: Callable[[], T],
    *,
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
    sleeper: Callable[[float], None] = sleep,
) -> T:
    """Retry only classified transport failures with bounded exponential delay."""

    if policy.max_attempts <= 0:
        raise ValueError("retry max_attempts must be positive")
    last_error: BaseException | None = None
    for attempt in range(1, policy.max_attempts + 1):
        try:
            return operation()
        except Exception as error:
            if not is_retryable_transport_error(error):
                raise
            last_error = error
            if attempt < policy.max_attempts:
                delay = min(
                    policy.initial_delay_seconds * (2 ** (attempt - 1)),
                    policy.max_delay_seconds,
                )
                sleeper(delay)
    raise DataTransportError(
        f"{label} transport failed after {policy.max_attempts} attempts"
    ) from last_error
