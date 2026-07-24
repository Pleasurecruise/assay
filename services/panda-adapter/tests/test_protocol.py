from __future__ import annotations

import unittest

from panda_adapter.client import PandaDataClient
from panda_adapter.protocol import ProtocolValidationError, execute_request
from panda_adapter.settings import PandaDataSettings


class FakeFrame:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows

    def to_dict(self, *, orient: str) -> list[dict[str, object]]:
        if orient != "records":
            raise AssertionError("protocol must request record orientation")
        return self.rows


class FakeSdk:
    def __init__(self) -> None:
        self.last_parameters: dict[str, object] | None = None

    def init_token(self, *, username: str, password: str) -> None:
        pass

    def get_market_data(self, **parameters: object) -> FakeFrame:
        self.last_parameters = parameters
        return FakeFrame(
            [
                {"date": "2026-01-02", "symbol": "000001.SZ", "close": 10.0},
                {"date": "2026-01-05", "symbol": "000001.SZ", "close": 10.5},
            ]
        )


class PandaDataProtocolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sdk = FakeSdk()
        self.client = PandaDataClient(self.sdk)
        self.client.initialize(PandaDataSettings("test-user", "test-password"))

    def test_maps_camel_case_and_caps_rows(self) -> None:
        response = execute_request(
            self.client,
            {
                "id": "request-1",
                "operation": "market_data",
                "params": {
                    "symbol": "000001.SZ",
                    "startDate": "20260101",
                    "endDate": "20260131",
                },
                "maxRows": 1,
            },
        )

        self.assertTrue(response["ok"])
        data = response["data"]
        self.assertEqual(data["rowCount"], 2)
        self.assertTrue(data["truncated"])
        self.assertEqual(len(data["rows"]), 1)
        self.assertTrue(data["sourceRef"].startswith("pandadata:market_data:"))
        self.assertEqual(
            self.sdk.last_parameters,
            {
                "symbol": "000001.SZ",
                "start_date": "20260101",
                "end_date": "20260131",
            },
        )

    def test_rejects_unknown_parameters(self) -> None:
        with self.assertRaisesRegex(ProtocolValidationError, "not allowed"):
            execute_request(
                self.client,
                {
                    "id": "request-2",
                    "operation": "market_data",
                    "params": {"password": "must-not-cross"},
                },
            )

    def test_rejects_non_canonical_dates(self) -> None:
        with self.assertRaisesRegex(ProtocolValidationError, "YYYYMMDD"):
            execute_request(
                self.client,
                {
                    "id": "request-3",
                    "operation": "market_data",
                    "params": {"startDate": "2026-01-01"},
                },
            )


if __name__ == "__main__":
    unittest.main()
