from __future__ import annotations

import unittest

from panda_adapter.client import (
    PandaDataClient,
    PandaDataInitializationError,
    PandaDataNotInitializedError,
    PandaDataOperationError,
)
from panda_adapter.settings import PandaDataSettings


class FakePandaDataSdk:
    def __init__(self) -> None:
        self.initialization_count = 0
        self.market_data_call_count = 0
        self.last_market_data_parameters: dict[str, object] | None = None
        self.last_index_daily_parameters: dict[str, object] | None = None
        self.last_factor_parameters: dict[str, object] | None = None
        self.last_adj_factor_parameters: dict[str, object] | None = None
        self.last_index_weights_parameters: dict[str, object] | None = None

    def init_token(self, *, username: str, password: str) -> None:
        if not username or not password:
            raise AssertionError("test credentials must be non-empty")
        self.initialization_count += 1

    def get_market_data(self, **parameters: object) -> dict[str, object]:
        self.market_data_call_count += 1
        self.last_market_data_parameters = parameters
        return {"rows": []}

    def get_index_daily(self, **parameters: object) -> dict[str, object]:
        self.last_index_daily_parameters = parameters
        return {"rows": []}

    def get_factor(self, **parameters: object) -> dict[str, object]:
        self.last_factor_parameters = parameters
        return {"rows": []}

    def get_adj_factor(self, **parameters: object) -> dict[str, object]:
        self.last_adj_factor_parameters = parameters
        return {"rows": []}

    def get_index_weights(self, **parameters: object) -> dict[str, object]:
        self.last_index_weights_parameters = parameters
        return {"rows": []}


class RejectingPandaDataSdk(FakePandaDataSdk):
    def init_token(self, *, username: str, password: str) -> None:
        raise RuntimeError("vendor response that must not cross the boundary")


class PandaDataClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sdk = FakePandaDataSdk()
        self.client = PandaDataClient(self.sdk)
        self.settings = PandaDataSettings(
            username="test-user",
            password="test-password",
        )

    def test_rejects_data_calls_before_initialization(self) -> None:
        with self.assertRaises(PandaDataNotInitializedError):
            self.client.get_market_data(symbol="000001.SZ")

    def test_initializes_exactly_once(self) -> None:
        self.client.initialize(self.settings)
        self.client.initialize(self.settings)

        self.assertTrue(self.client.is_initialized)
        self.assertEqual(self.sdk.initialization_count, 1)

    def test_redacts_vendor_initialization_errors(self) -> None:
        client = PandaDataClient(RejectingPandaDataSdk())

        with self.assertRaisesRegex(
            PandaDataInitializationError,
            "^PandaData token initialization failed$",
        ):
            client.initialize(self.settings)

        self.assertFalse(client.is_initialized)

    def test_forwards_data_calls_after_initialization(self) -> None:
        self.client.initialize(self.settings)

        result = self.client.get_market_data(
            symbol="000001.SZ",
            start_date="2026-01-01",
            end_date="2026-01-31",
        )

        self.assertEqual(result, {"rows": []})
        self.assertEqual(
            self.sdk.last_market_data_parameters,
            {
                "symbol": "000001.SZ",
                "start_date": "2026-01-01",
                "end_date": "2026-01-31",
            },
        )

        self.assertEqual(
            self.client.get_index_daily(
                symbol="000300.SH",
                start_date="20260101",
                end_date="20260131",
                fields=["date", "symbol", "close"],
            ),
            {"rows": []},
        )
        self.assertEqual(
            self.sdk.last_index_daily_parameters,
            {
                "symbol": "000300.SH",
                "start_date": "20260101",
                "end_date": "20260131",
                "fields": ["date", "symbol", "close"],
            },
        )

        self.assertEqual(
            self.client.get_factor(
                symbol=["000001.SZ"],
                start_date="20260101",
                end_date="20260131",
                factors=["close"],
            ),
            {"rows": []},
        )
        self.assertEqual(
            self.sdk.last_factor_parameters,
            {
                "symbol": ["000001.SZ"],
                "start_date": "20260101",
                "end_date": "20260131",
                "factors": ["close"],
            },
        )

        self.assertEqual(
            self.client.get_adj_factor(
                symbol="000001.SZ",
                start_date="20260101",
                end_date="20260131",
            ),
            {"rows": []},
        )
        self.assertEqual(
            self.sdk.last_adj_factor_parameters,
            {
                "symbol": "000001.SZ",
                "start_date": "20260101",
                "end_date": "20260131",
            },
        )

        self.assertEqual(
            self.client.get_index_weights(
                index_symbol="000300.SH",
                start_date="20260131",
                end_date="20260131",
            ),
            {"rows": []},
        )
        self.assertEqual(
            self.sdk.last_index_weights_parameters,
            {
                "index_symbol": "000300.SH",
                "start_date": "20260131",
                "end_date": "20260131",
            },
        )

    def test_caches_identical_immutable_queries(self) -> None:
        self.client.initialize(self.settings)

        first = self.client.get_market_data(symbol="000001.SZ")
        second = self.client.get_market_data(symbol="000001.SZ")

        self.assertIs(first, second)
        self.assertEqual(self.sdk.market_data_call_count, 1)

    def test_index_daily_does_not_expand_the_generic_operation_allowlist(
        self,
    ) -> None:
        self.client.initialize(self.settings)

        with self.assertRaises(PandaDataOperationError):
            self.client.query(
                "index_daily",
                {"symbol": "000300.SH"},
            )


if __name__ == "__main__":
    unittest.main()
