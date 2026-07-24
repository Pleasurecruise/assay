from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
from io import StringIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd


SCRIPT_PATH = (
    Path(__file__).parents[1] / "scripts" / "prepare_csi300_cache.py"
)
SPEC = importlib.util.spec_from_file_location(
    "prepare_csi300_cache_test_subject",
    SCRIPT_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load cache builder script: {SCRIPT_PATH}")
cache_builder = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cache_builder
SPEC.loader.exec_module(cache_builder)


def _factor_rows(
    symbols: list[str],
    start_date: str,
    end_date: str,
    *,
    dates: list[str] | None = None,
) -> pd.DataFrame:
    if dates is None:
        date_values = pd.date_range(
            pd.to_datetime(start_date, format="%Y%m%d"),
            pd.to_datetime(end_date, format="%Y%m%d"),
            freq="D",
        ).strftime("%Y%m%d")
    else:
        date_values = dates
    return pd.DataFrame(
        [
            {
                "date": date,
                "symbol": symbol,
                "close": 100.0 + symbol_index,
            }
            for date in date_values
            for symbol_index, symbol in enumerate(symbols)
        ]
    )


def _status_rows(
    symbols: list[str],
    start_date: str,
) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "date": start_date,
                "symbol": symbol,
                "trade_status": 0,
            }
            for symbol in symbols
        ]
    )


class FakeClient:
    def __init__(self) -> None:
        self.factor_calls: list[dict[str, object]] = []
        self.status_calls: list[dict[str, object]] = []
        self.factor_handler = (
            lambda values: _factor_rows(
                list(values["symbol"]),
                str(values["start_date"]),
                str(values["end_date"]),
            )
        )
        self.status_handler = (
            lambda values: _status_rows(
                list(values["symbol"]),
                str(values["start_date"]),
            )
        )

    def get_factor(self, **values: object) -> pd.DataFrame:
        self.factor_calls.append(values)
        return self.factor_handler(values)

    def get_market_data(self, **values: object) -> pd.DataFrame:
        self.status_calls.append(values)
        return self.status_handler(values)


class PrepareCsi300CacheTest(unittest.TestCase):
    SYMBOLS = ["000001.SZ", "000002.SZ", "600000.SH", "600001.SH"]

    def _constituents(
        self,
        directory: str,
        symbols: list[str] | None = None,
    ) -> Path:
        path = Path(directory) / "constituents.csv"
        pd.DataFrame(
            [
                {"date": "2026-01-31", "symbol": symbol}
                for symbol in (symbols or self.SYMBOLS)
            ]
        ).to_csv(path, index=False)
        return path

    def _build(
        self,
        client: FakeClient,
        directory: str,
        *,
        start: str = "20260101",
        end: str = "20260104",
        symbols: list[str] | None = None,
    ) -> Path:
        output = Path(directory) / "panel.csv"
        with patch.object(
            cache_builder,
            "create_initialized_client",
            return_value=client,
        ):
            cache_builder.build_cache(
                start,
                end,
                output,
                batch_size=1,
                constituents_from_cache=self._constituents(
                    directory,
                    symbols,
                ),
            )
        return output

    def test_factor_base_windows_are_seven_calendar_days(self) -> None:
        values = list(
            cache_builder._factor_windows(
                pd.Timestamp("2026-01-03"),
                pd.Timestamp("2026-01-18"),
            )
        )

        self.assertEqual(
            values,
            [
                (pd.Timestamp("2026-01-03"), pd.Timestamp("2026-01-09")),
                (pd.Timestamp("2026-01-10"), pd.Timestamp("2026-01-16")),
                (pd.Timestamp("2026-01-17"), pd.Timestamp("2026-01-18")),
            ],
        )

    def test_build_uses_full_universe_windows_then_factor_dates(self) -> None:
        client = FakeClient()

        def factor_handler(values: dict[str, object]) -> pd.DataFrame:
            return _factor_rows(
                list(values["symbol"]),
                str(values["start_date"]),
                str(values["end_date"]),
                dates=[str(values["start_date"])],
            )

        client.factor_handler = factor_handler

        with tempfile.TemporaryDirectory() as directory:
            output = self._build(
                client,
                directory,
                start="20260101",
                end="20260110",
            )
            result = pd.read_csv(output)

        self.assertEqual(
            [
                (
                    call["start_date"],
                    call["end_date"],
                    call["symbol"],
                )
                for call in client.factor_calls
            ],
            [
                ("20260101", "20260107", self.SYMBOLS),
                ("20260108", "20260110", self.SYMBOLS),
            ],
        )
        self.assertEqual(
            [
                (call["start_date"], call["end_date"], call["symbol"])
                for call in client.status_calls
            ],
            [
                ("20260101", "20260101", self.SYMBOLS),
                ("20260108", "20260108", self.SYMBOLS),
            ],
        )
        self.assertEqual(len(result), 2 * len(self.SYMBOLS))

    def test_factor_date_split_resumes_only_the_missing_child(self) -> None:
        client = FakeClient()
        right_child_available = False

        def factor_handler(values: dict[str, object]) -> pd.DataFrame:
            nonlocal right_child_available
            window = (values["start_date"], values["end_date"])
            if window == ("20260101", "20260104"):
                raise cache_builder.DataTransportError("transport exhausted")
            if window == ("20260103", "20260104") and not right_child_available:
                raise RuntimeError("simulated process interruption")
            return _factor_rows(
                list(values["symbol"]),
                str(values["start_date"]),
                str(values["end_date"]),
            )

        client.factor_handler = factor_handler

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(
                RuntimeError,
                "simulated process interruption",
            ):
                self._build(client, directory)

            right_child_available = True
            progress = StringIO()
            with redirect_stderr(progress), redirect_stdout(progress):
                output = self._build(client, directory)
            result = pd.read_csv(output)

            factor_windows = [
                (call["start_date"], call["end_date"])
                for call in client.factor_calls
            ]
            self.assertEqual(
                factor_windows,
                [
                    ("20260101", "20260104"),
                    ("20260101", "20260102"),
                    ("20260103", "20260104"),
                    ("20260103", "20260104"),
                ],
            )
            self.assertEqual(len(result), 4 * len(self.SYMBOLS))
            self.assertEqual(len(client.status_calls), 4)
            self.assertIn("reused=1 split=1", progress.getvalue())
            parts_root = cache_builder._parts_root(
                output,
                cache_builder._universe_hash(self.SYMBOLS),
                len(self.SYMBOLS),
            )
            self.assertIn(
                cache_builder.DATASET_VERSION,
                str(parts_root),
            )
            self.assertTrue(parts_root.exists())
            fragment_payloads = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in parts_root.rglob("*.part.json")
            ]
            self.assertTrue(fragment_payloads)
            self.assertTrue(
                all(
                    payload["request"]["universeHash"]
                    == cache_builder._universe_hash(self.SYMBOLS)
                    for payload in fragment_payloads
                )
            )

    def test_single_day_factor_failure_splits_the_symbol_list(self) -> None:
        client = FakeClient()

        def factor_handler(values: dict[str, object]) -> pd.DataFrame:
            symbols = list(values["symbol"])
            if len(symbols) == len(self.SYMBOLS):
                raise cache_builder.DataTransportError("transport exhausted")
            return _factor_rows(
                symbols,
                str(values["start_date"]),
                str(values["end_date"]),
            )

        client.factor_handler = factor_handler

        with tempfile.TemporaryDirectory() as directory:
            output = self._build(
                client,
                directory,
                start="20260102",
                end="20260102",
            )
            result = pd.read_csv(output)

        self.assertEqual(
            [len(call["symbol"]) for call in client.factor_calls],
            [4, 2, 2],
        )
        self.assertEqual(len(client.status_calls), 1)
        self.assertEqual(len(result), len(self.SYMBOLS))

    def test_status_failure_splits_symbols_on_the_factor_trading_date(
        self,
    ) -> None:
        client = FakeClient()

        def factor_handler(values: dict[str, object]) -> pd.DataFrame:
            return _factor_rows(
                list(values["symbol"]),
                str(values["start_date"]),
                str(values["end_date"]),
                dates=[str(values["start_date"])],
            )

        def status_handler(values: dict[str, object]) -> pd.DataFrame:
            symbols = list(values["symbol"])
            if len(symbols) == len(self.SYMBOLS):
                raise cache_builder.DataTransportError("transport exhausted")
            return _status_rows(symbols, str(values["start_date"]))

        client.factor_handler = factor_handler
        client.status_handler = status_handler

        with tempfile.TemporaryDirectory() as directory:
            output = self._build(client, directory)
            result = pd.read_csv(output)

        self.assertEqual(len(client.factor_calls), 1)
        self.assertEqual(
            [len(call["symbol"]) for call in client.status_calls],
            [4, 2, 2],
        )
        self.assertEqual(len(result), len(self.SYMBOLS))

    def test_factor_fragment_survives_status_source_failure(self) -> None:
        client = FakeClient()
        status_available = False

        def status_handler(values: dict[str, object]) -> pd.DataFrame:
            if not status_available:
                raise RuntimeError("status endpoint unavailable")
            return _status_rows(
                list(values["symbol"]),
                str(values["start_date"]),
            )

        client.status_handler = status_handler

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(
                RuntimeError,
                "status endpoint unavailable",
            ):
                self._build(
                    client,
                    directory,
                    start="20260102",
                    end="20260102",
                )

            status_available = True
            output = self._build(
                client,
                directory,
                start="20260102",
                end="20260102",
            )

            self.assertEqual(len(client.factor_calls), 1)
            self.assertEqual(len(client.status_calls), 2)
            self.assertTrue(output.exists())

    def test_price_left_join_drops_and_diagnoses_status_only_keys(self) -> None:
        client = FakeClient()
        symbols = self.SYMBOLS[:2]

        def factor_handler(values: dict[str, object]) -> pd.DataFrame:
            requested = list(values["symbol"])
            return pd.DataFrame(
                [
                    {
                        "date": "20260101",
                        "symbol": requested[0],
                        "close": 100,
                    },
                    {
                        "date": "20260102",
                        "symbol": requested[1],
                        "close": 101,
                    },
                ]
            )

        client.factor_handler = factor_handler

        with tempfile.TemporaryDirectory() as directory:
            progress = StringIO()
            with redirect_stderr(progress), redirect_stdout(progress):
                output = self._build(
                    client,
                    directory,
                    start="20260101",
                    end="20260102",
                    symbols=symbols,
                )
            result = pd.read_csv(output)

        self.assertEqual(len(result), 2)
        self.assertEqual(
            set(zip(result["date"], result["symbol"], strict=True)),
            {
                ("2026-01-01", symbols[0]),
                ("2026-01-02", symbols[1]),
            },
        )
        self.assertIn("status-only keys dropped: 2", progress.getvalue())
        self.assertIn("statusOnlyDropped=2", progress.getvalue())

    def test_rejects_duplicate_fragment_keys(self) -> None:
        request = cache_builder.FragmentRequest(
            source="factor-close",
            start_date=pd.Timestamp("2026-01-01"),
            end_date=pd.Timestamp("2026-01-02"),
            symbols=tuple(self.SYMBOLS),
            universe_hash=cache_builder._universe_hash(self.SYMBOLS),
            universe_size=len(self.SYMBOLS),
        )
        duplicate = pd.DataFrame(
            [
                {
                    "date": "20260101",
                    "symbol": self.SYMBOLS[0],
                    "close": 10,
                },
                {
                    "date": "20260101",
                    "symbol": self.SYMBOLS[0],
                    "close": 11,
                },
            ]
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "duplicate symbol/date keys",
        ):
            cache_builder._normalize_source_frame(
                duplicate,
                request,
                context="fake factor",
            )


if __name__ == "__main__":
    unittest.main()
