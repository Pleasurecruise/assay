from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import pandas as pd

from panda_adapter.audit_cache import (
    V9_CACHE_VERSION,
    V9_CACHE_MANIFEST_SCHEMA_VERSION,
    load_comparator_factor_cache,
    load_index_daily_cache,
    load_pit_membership_cache,
)


class AuditCacheReaderTest(unittest.TestCase):
    def test_reads_only_ready_materialized_datasets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            materialized = root / "materialized"
            materialized.mkdir()
            (materialized / "index-daily.csv").write_text(
                "date,symbol,close\n"
                "2026-01-05,000300.SH,100\n"
                "2026-01-06,000300.SH,101\n",
                encoding="utf-8",
            )
            (materialized / "comparator-factors.csv").write_text(
                "date,symbol,ratio_pe_ttm,market_cap\n"
                "2026-01-05,000001.SZ,10,1000\n"
                "2026-01-05,000002.SZ,,2000\n",
                encoding="utf-8",
            )
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": V9_CACHE_MANIFEST_SCHEMA_VERSION,
                        "cacheVersion": "known-answer",
                        "datasets": {
                            "indexDaily": {
                                "status": "ready",
                                "path": "materialized/index-daily.csv",
                            },
                            "comparatorFactors": {
                                "status": "ready",
                                "path": (
                                    "materialized/comparator-factors.csv"
                                ),
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            index = load_index_daily_cache(root)
            factors = load_comparator_factor_cache(root)

            self.assertIsNotNone(index)
            self.assertEqual(index.cache_version, "known-answer")  # type: ignore[union-attr]
            self.assertEqual(index.close.tolist(), [100.0, 101.0])  # type: ignore[union-attr]
            self.assertIsNotNone(factors)
            self.assertEqual(  # type: ignore[union-attr]
                set(factors.values),
                {"ratio_pe_ttm", "market_cap"},
            )
            self.assertEqual(  # type: ignore[union-attr]
                float(factors.values["market_cap"].loc["2026-01-05", "000002.SZ"]),
                2000.0,
            )

    def test_not_ready_datasets_take_the_authorized_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": V9_CACHE_MANIFEST_SCHEMA_VERSION,
                        "cacheVersion": "known-answer",
                        "datasets": {
                            "indexDaily": {"status": "blocked"},
                            "comparatorFactors": {"status": "degraded"},
                        },
                    }
                ),
                encoding="utf-8",
            )

            self.assertIsNone(load_index_daily_cache(root))
            self.assertIsNone(load_comparator_factor_cache(root))

    def test_ready_but_malformed_dataset_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            materialized = root / "materialized"
            materialized.mkdir()
            (materialized / "index-daily.csv").write_text(
                "date,symbol,close\n"
                "2026-01-05,000300.SH,-1\n",
                encoding="utf-8",
            )
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": V9_CACHE_MANIFEST_SCHEMA_VERSION,
                        "cacheVersion": "known-answer",
                        "datasets": {
                            "indexDaily": {
                                "status": "ready",
                                "path": "materialized/index-daily.csv",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, "canonical values"):
                load_index_daily_cache(root)

    def test_non_numeric_comparator_value_is_not_treated_as_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            materialized = root / "materialized"
            materialized.mkdir()
            (materialized / "comparator-factors.csv").write_text(
                "date,symbol,ratio_pe_ttm,market_cap\n"
                "2026-01-05,000001.SZ,not-a-number,1000\n",
                encoding="utf-8",
            )
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": V9_CACHE_MANIFEST_SCHEMA_VERSION,
                        "cacheVersion": "known-answer",
                        "datasets": {
                            "comparatorFactors": {
                                "status": "ready",
                                "path": (
                                    "materialized/comparator-factors.csv"
                                ),
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, "invalid values"):
                load_comparator_factor_cache(root)

    def test_reads_promoted_pit_membership_timeline_and_reconciles_counts(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            common_root = Path(directory)
            root = common_root / "v9-p1-v1"
            root.mkdir()
            pit_root = (
                common_root
                / "pit-availability-v1"
                / "index-weights"
                / "000300_SH"
            )
            pit_root.mkdir(parents=True)
            snapshots = {
                "2026-01-30": ["000001.SZ", "600000.SH"],
                "2026-02-27": ["000002.SZ", "600000.SH"],
            }
            for date, symbols in snapshots.items():
                (pit_root / f"{date.replace('-', '')}.json").write_text(
                    json.dumps(
                        {
                            "schemaVersion": "pit-index-snapshot-v1",
                            "indexSymbol": "000300.SH",
                            "requestedDate": date,
                            "effectiveDate": date,
                            "symbols": symbols,
                        }
                    ),
                    encoding="utf-8",
                )
            dataset = {
                "status": "ready",
                "path": "pit-availability-v1/index-weights/000300_SH",
                "columns": ["requestedDate", "effectiveDate", "symbols"],
                "downloaded": 2,
                "tradingDates": 2,
                "rowCount": 4,
                "symbols": 3,
                "quality": {
                    "pointCount": 2,
                    "memberCounts": {
                        date: len(symbols)
                        for date, symbols in snapshots.items()
                    },
                    "primaryKeysValid": True,
                },
            }
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": V9_CACHE_MANIFEST_SCHEMA_VERSION,
                        "cacheVersion": V9_CACHE_VERSION,
                        "promoted": True,
                        "datasets": {"pitTimeline": dataset},
                    }
                ),
                encoding="utf-8",
            )

            cache = load_pit_membership_cache(root)

            self.assertEqual(cache.cache_version, V9_CACHE_VERSION)
            self.assertEqual(
                cache.snapshots[pd.Timestamp("2026-01-30")],
                frozenset({"000001.SZ", "600000.SH"}),
            )

            dataset["quality"]["memberCounts"]["2026-02-27"] = 1
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": V9_CACHE_MANIFEST_SCHEMA_VERSION,
                        "cacheVersion": V9_CACHE_VERSION,
                        "promoted": True,
                        "datasets": {"pitTimeline": dataset},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "does not reconcile"):
                load_pit_membership_cache(root)


if __name__ == "__main__":
    unittest.main()
