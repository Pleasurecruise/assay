from __future__ import annotations

from http.client import IncompleteRead
import unittest
from urllib.error import HTTPError

from panda_adapter.data_transport import (
    DataTransportError,
    RetryPolicy,
    retry_transport,
)


class DataTransportRetryTest(unittest.TestCase):
    def test_retries_nested_incomplete_reads_with_bounded_backoff(self) -> None:
        attempts = 0
        delays: list[float] = []

        def operation() -> str:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                try:
                    raise IncompleteRead(b"partial", 2)
                except IncompleteRead as transport_error:
                    raise RuntimeError("vendor wrapper") from transport_error
            return "ok"

        result = retry_transport(
            "prices",
            operation,
            policy=RetryPolicy(
                max_attempts=4,
                initial_delay_seconds=1,
                max_delay_seconds=2,
            ),
            sleeper=delays.append,
        )

        self.assertEqual(result, "ok")
        self.assertEqual(attempts, 3)
        self.assertEqual(delays, [1, 2])

    def test_does_not_retry_non_transport_errors(self) -> None:
        attempts = 0

        def operation() -> None:
            nonlocal attempts
            attempts += 1
            raise ValueError("bad response shape")

        with self.assertRaisesRegex(ValueError, "bad response shape"):
            retry_transport("prices", operation, sleeper=lambda _: None)

        self.assertEqual(attempts, 1)

    def test_retries_only_retryable_http_statuses(self) -> None:
        for status, expected in ((404, False), (429, True), (503, True)):
            with self.subTest(status=status):
                error = HTTPError(
                    "https://data.invalid",
                    status,
                    "provider response",
                    {},
                    None,
                )
                attempts = 0

                def operation() -> str:
                    nonlocal attempts
                    attempts += 1
                    if attempts == 1:
                        raise error
                    return "ok"

                if expected:
                    self.assertEqual(
                        retry_transport(
                            "prices",
                            operation,
                            sleeper=lambda _: None,
                        ),
                        "ok",
                    )
                    self.assertEqual(attempts, 2)
                else:
                    with self.assertRaises(HTTPError):
                        retry_transport(
                            "prices",
                            operation,
                            sleeper=lambda _: None,
                        )
                    self.assertEqual(attempts, 1)

    def test_retries_retryable_service_codes_embedded_only_in_message(self) -> None:
        attempts = 0

        def operation() -> str:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("[错误码 500004 : 服务降级中]")
            return "ok"

        self.assertEqual(
            retry_transport("prices", operation, sleeper=lambda _: None),
            "ok",
        )
        self.assertEqual(attempts, 2)

    def test_reports_exhausted_transport_budget_without_vendor_detail(self) -> None:
        def operation() -> None:
            raise ConnectionResetError("vendor response detail")

        with self.assertRaisesRegex(
            DataTransportError,
            "^prices transport failed after 2 attempts$",
        ):
            retry_transport(
                "prices",
                operation,
                policy=RetryPolicy(max_attempts=2),
                sleeper=lambda _: None,
            )


if __name__ == "__main__":
    unittest.main()
