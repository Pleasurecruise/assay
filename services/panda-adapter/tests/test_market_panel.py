from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd

from panda_adapter.market_panel import (
    ADAPTER_ROOT,
    RESUMABLE_CACHE_BUILDER,
    _download_fixed_universe_cache,
    load_cached_market_panel,
    load_market_panel,
)


class MarketPanelCacheTest(unittest.TestCase):
    def test_availability_loader_requires_existing_cache_without_download(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.csv"
            with (
                patch.dict(
                    os.environ,
                    {"ASSAY_MARKET_DATA_CACHE": str(path)},
                    clear=False,
                ),
                patch(
                    "panda_adapter.market_panel._download_fixed_universe_cache"
                ) as download,
                self.assertRaisesRegex(
                    RuntimeError,
                    "^availability audit requires an existing market cache$",
                ),
            ):
                load_cached_market_panel(
                    {
                        "universe": {"index": "000300.SH"},
                        "window": {
                            "start": "20260101",
                            "end": "20260131",
                        },
                    }
                )
            download.assert_not_called()

    def test_loads_long_csv_and_filters_the_requested_window(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel.csv"
            pd.DataFrame(
                [
                    {
                        "date": "2026-01-01",
                        "symbol": "B",
                        "adjClose": 10,
                        "tradeStatus": 0,
                    },
                    {
                        "date": "2026-01-02",
                        "symbol": "A",
                        "adjClose": 20,
                        "tradeStatus": 0,
                    },
                    {
                        "date": "2026-01-02",
                        "symbol": "B",
                        "adjClose": 11,
                        "tradeStatus": 1,
                    },
                    {
                        "date": "2026-01-03",
                        "symbol": "A",
                        "adjClose": 21,
                        "tradeStatus": 0,
                    },
                ]
            ).to_csv(path, index=False)

            with patch.dict(
                os.environ,
                {"ASSAY_MARKET_DATA_CACHE": str(path)},
                clear=False,
            ):
                market_panel = load_market_panel(
                    {
                        "universe": {"index": "000300.SH"},
                        "window": {
                            "start": "20260102",
                            "end": "20260103",
                        },
                    }
                )

            prices = market_panel.adjusted_close
            self.assertEqual(prices.index.min(), pd.Timestamp("2026-01-02"))
            self.assertEqual(list(prices.columns), ["A", "B"])
            self.assertEqual(prices.loc[pd.Timestamp("2026-01-03"), "A"], 21)
            self.assertTrue(
                market_panel.tradable.loc[pd.Timestamp("2026-01-02"), "A"]
            )
            self.assertFalse(
                market_panel.tradable.loc[pd.Timestamp("2026-01-02"), "B"]
            )

    def test_rejects_missing_or_non_csi300_universe_before_cache_read(
        self,
    ) -> None:
        invalid_specs = [
            {"window": {"start": "20260102", "end": "20260103"}},
            {
                "universe": {},
                "window": {"start": "20260102", "end": "20260103"},
            },
            {
                "universe": {"index": "000905.SH"},
                "window": {"start": "20260102", "end": "20260103"},
            },
            {
                "universe": {"index": "000300.sh"},
                "window": {"start": "20260102", "end": "20260103"},
            },
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel.csv"
            path.touch()
            with (
                patch.dict(
                    os.environ,
                    {"ASSAY_MARKET_DATA_CACHE": str(path)},
                    clear=False,
                ),
                patch("panda_adapter.market_panel._read_cache") as read_cache,
            ):
                for spec in invalid_specs:
                    with (
                        self.subTest(spec=spec),
                        self.assertRaisesRegex(
                            ValueError,
                            r"spec\.universe\.index must equal 000300\.SH",
                        ),
                    ):
                        load_market_panel(spec)

            read_cache.assert_not_called()

    def test_cache_miss_delegates_to_the_resumable_builder(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel.csv"

            def complete(
                command: list[str],
                **_: object,
            ) -> subprocess.CompletedProcess[str]:
                output_index = command.index("--output") + 1
                output = Path(command[output_index])
                pd.DataFrame(
                    [
                        {
                            "date": "2026-01-02",
                            "symbol": "000001.SZ",
                            "adjClose": 10.5,
                            "tradeStatus": 0,
                        }
                    ]
                ).to_csv(output, index=False)
                return subprocess.CompletedProcess(command, 0, "ok", "")

            with patch(
                "panda_adapter.market_panel.subprocess.run",
                side_effect=complete,
            ) as run:
                _download_fixed_universe_cache(
                    {
                        "universe": {"index": "000300.SH"},
                        "window": {
                            "start": "2026-01-01",
                            "end": "2026-01-31",
                        }
                    },
                    path,
                )

            command = run.call_args.args[0]
            self.assertEqual(
                command,
                [
                    command[0],
                    str(RESUMABLE_CACHE_BUILDER),
                    "cache",
                    "--start",
                    "20260101",
                    "--end",
                    "20260131",
                    "--output",
                    str(path.resolve()),
                ],
            )
            self.assertEqual(run.call_args.kwargs["cwd"], ADAPTER_ROOT.parents[1])
            self.assertTrue(run.call_args.kwargs["capture_output"])
            self.assertTrue(path.is_file())

    def test_cache_builder_failure_is_fail_closed_and_sanitized(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel.csv"
            completed = subprocess.CompletedProcess(
                ["builder"],
                1,
                "",
                "Bearer secret at /Users/operator/private/cache.log",
            )
            with (
                patch(
                    "panda_adapter.market_panel.subprocess.run",
                    return_value=completed,
                ),
                self.assertRaisesRegex(
                    RuntimeError,
                    "^resumable market cache builder failed$",
                ),
            ):
                _download_fixed_universe_cache(
                    {
                        "universe": {"index": "000300.SH"},
                        "window": {
                            "start": "2026-01-01",
                            "end": "2026-01-31",
                        },
                    },
                    path,
                )

    def test_rejects_duplicate_cache_keys_instead_of_collapsing_them(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel.csv"
            pd.DataFrame(
                [
                    {
                        "date": "2026-01-02",
                        "symbol": "000001.SZ",
                        "adjClose": 10.5,
                        "tradeStatus": 0,
                    },
                    {
                        "date": "2026-01-02",
                        "symbol": "000001.SZ",
                        "adjClose": 11.0,
                        "tradeStatus": 1,
                    },
                ]
            ).to_csv(path, index=False)
            with (
                patch.dict(
                    os.environ,
                    {"ASSAY_MARKET_DATA_CACHE": str(path)},
                    clear=False,
                ),
                self.assertRaisesRegex(
                    ValueError,
                    "duplicate date/symbol keys",
                ),
            ):
                load_market_panel(
                    {
                        "universe": {"index": "000300.SH"},
                        "window": {
                            "start": "20260101",
                            "end": "20260131",
                        },
                    }
                )

    def test_rejects_nonpositive_prices_and_noninteger_statuses(self) -> None:
        invalid_values = [
            ("adjClose", 0, "adjusted close must be finite and positive"),
            ("tradeStatus", 0.5, "tradeStatus must contain integers"),
        ]
        for column, value, message in invalid_values:
            with self.subTest(column=column), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "panel.csv"
                row = {
                    "date": "2026-01-02",
                    "symbol": "000001.SZ",
                    "adjClose": 10.5,
                    "tradeStatus": 0,
                }
                row[column] = value
                pd.DataFrame([row]).to_csv(path, index=False)
                with (
                    patch.dict(
                        os.environ,
                        {"ASSAY_MARKET_DATA_CACHE": str(path)},
                        clear=False,
                    ),
                    self.assertRaisesRegex(ValueError, message),
                ):
                    load_market_panel(
                        {
                            "universe": {"index": "000300.SH"},
                            "window": {
                                "start": "20260101",
                                "end": "20260131",
                            },
                        }
                    )


if __name__ == "__main__":
    unittest.main()
