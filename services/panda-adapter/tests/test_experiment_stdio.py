from __future__ import annotations

import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import pandas as pd


class ExperimentStdioIntegrationTest(unittest.TestCase):
    def test_availability_audit_uses_only_preseeded_offline_caches(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache_path = root / "panel.csv"
            pit_root = root / "pit"
            dates = pd.bdate_range("2026-01-01", periods=70)
            symbols = ["A", "B"]
            rows = pd.MultiIndex.from_product(
                [dates, symbols],
                names=["date", "symbol"],
            ).to_frame(index=False)
            rows["adjClose"] = [
                100.0
                * (
                    (1.001 if symbol == "A" else 1.002)
                    ** int(dates.get_loc(date))
                )
                for date, symbol in zip(
                    rows["date"],
                    rows["symbol"],
                    strict=True,
                )
            ]
            rows["tradeStatus"] = 0
            rows.to_csv(cache_path, index=False)

            periods = dates.to_period("M")
            signal_dates = [
                dates[position]
                for position in range(len(dates) - 1)
                if periods[position] != periods[position + 1]
            ]
            snapshot_root = pit_root / "index-weights" / "000300_SH"
            snapshot_root.mkdir(parents=True)
            for date in signal_dates:
                (snapshot_root / f"{date.strftime('%Y%m%d')}.json").write_text(
                    json.dumps(
                        {
                            "schemaVersion": "pit-index-snapshot-v1",
                            "indexSymbol": "000300.SH",
                            "requestedDate": date.strftime("%Y-%m-%d"),
                            "effectiveDate": date.strftime("%Y-%m-%d"),
                            "symbols": symbols,
                        }
                    ),
                    encoding="utf-8",
                )

            source_root = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "src")
            )
            environment = {
                **os.environ,
                "PYTHONPATH": source_root,
                "ASSAY_MARKET_DATA_CACHE": str(cache_path),
                "ASSAY_PIT_CACHE_ROOT": str(pit_root),
            }
            request = {
                "kind": "availability_audit",
                "spec": {
                    "specVersion": "1",
                    "universe": {"index": "000300.SH"},
                    "signal": {
                        "kind": "template",
                        "template": "momentum",
                        "params": {"window": 5},
                    },
                    "selection": {"topN": 1, "weighting": "equal"},
                    "rebalance": {"frequency": "monthly", "at": "close"},
                    "window": {
                        "start": dates[0].strftime("%Y%m%d"),
                        "end": dates[-1].strftime("%Y%m%d"),
                    },
                    "costs": {"model": "standard"},
                },
                "budget": {"maxVariants": 1},
            }
            completed = subprocess.run(
                [sys.executable, "-m", "panda_adapter.experiment_stdio"],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            response = json.loads(completed.stdout)
            self.assertEqual(response["mode"], "full_pit")
            self.assertEqual(response["futureConstituentCount"], 0)
            self.assertEqual(response["affectedRebalances"], [])
            self.assertEqual(response["sampleSymbols"], [])
            self.assertEqual(response["contaminatedSelectionRate"], 0.0)

    def test_reads_cache_and_returns_the_s0_shape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / "panel.csv"
            dates = pd.bdate_range("2026-01-01", periods=70)
            rows = pd.MultiIndex.from_product(
                [dates, ["A", "B"]],
                names=["date", "symbol"],
            ).to_frame(index=False)
            rows["adjClose"] = 100.0
            rows["tradeStatus"] = 0
            rows.to_csv(cache_path, index=False)

            source_root = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "src")
            )
            environment = {
                **os.environ,
                "PYTHONPATH": source_root,
                "ASSAY_MARKET_DATA_CACHE": str(cache_path),
            }
            request = {
                "kind": "grid",
                "spec": {
                    "specVersion": "1",
                    "universe": {"index": "000300.SH"},
                    "signal": {
                        "kind": "template",
                        "template": "momentum",
                        "params": {"window": 20},
                    },
                    "selection": {"topN": 1, "weighting": "equal"},
                    "rebalance": {"frequency": "monthly", "at": "close"},
                    "window": {
                        "start": dates[0].strftime("%Y%m%d"),
                        "end": dates[-1].strftime("%Y%m%d"),
                    },
                    "costs": {"model": "standard"},
                },
                "grid": {
                    "signalParams": {"window": [14, 20]},
                    "topN": [1],
                },
                "budget": {"maxVariants": 2},
            }
            completed = subprocess.run(
                [sys.executable, "-m", "panda_adapter.experiment_stdio"],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            response = json.loads(completed.stdout)
            self.assertEqual(
                set(response),
                {"engineVersion", "baseline", "variants"},
            )
            self.assertEqual(len(response["variants"]), 2)

    def test_regime_and_homogeneity_use_prepared_caches_over_stdio(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache_path = root / "panel.csv"
            v9_root = root / "v9"
            materialized = v9_root / "materialized"
            materialized.mkdir(parents=True)
            index_dates = pd.bdate_range("2023-01-02", periods=760)
            dates = index_dates[-520:]
            symbols = ["A", "B", "C", "D"]
            rows = pd.MultiIndex.from_product(
                [dates, symbols],
                names=["date", "symbol"],
            ).to_frame(index=False)
            growth = {"A": 1.0005, "B": 1.0008, "C": 1.0011, "D": 1.0014}
            rows["adjClose"] = [
                100.0 * growth[symbol] ** int(dates.get_loc(date))
                for date, symbol in zip(
                    rows["date"],
                    rows["symbol"],
                    strict=True,
                )
            ]
            rows["tradeStatus"] = 0
            rows.to_csv(cache_path, index=False)
            pd.DataFrame(
                {
                    "date": index_dates,
                    "symbol": "000300.SH",
                    "close": [
                        100.0
                        * 1.0004**position
                        * (1.0 + 0.01 * math.sin(position / 4.0))
                        for position in range(len(index_dates))
                    ],
                }
            ).to_csv(materialized / "index-daily.csv", index=False)
            factor_rows = rows[["date", "symbol"]].copy()
            factor_rows["ratio_pe_ttm"] = [
                float(symbols.index(symbol) + 1)
                for symbol in factor_rows["symbol"]
            ]
            factor_rows["market_cap"] = [
                float((symbols.index(symbol) + 1) * 1000)
                for symbol in factor_rows["symbol"]
            ]
            factor_rows.to_csv(
                materialized / "comparator-factors.csv",
                index=False,
            )
            (v9_root / "manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": "assay-p1-cache-manifest-v1",
                        "cacheVersion": "stdio-known-answer",
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
            spec = {
                "specVersion": "1",
                "universe": {"index": "000300.SH"},
                "signal": {
                    "kind": "template",
                    "template": "momentum",
                    "params": {"window": 20},
                },
                "selection": {"topN": 2, "weighting": "equal"},
                "rebalance": {"frequency": "monthly", "at": "close"},
                "window": {
                    "start": dates[0].strftime("%Y%m%d"),
                    "end": dates[-1].strftime("%Y%m%d"),
                },
                "costs": {"model": "none"},
            }
            source_root = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "src")
            )
            environment = {
                **os.environ,
                "PYTHONPATH": source_root,
                "ASSAY_MARKET_DATA_CACHE": str(cache_path),
                "ASSAY_V9_CACHE_ROOT": str(v9_root),
            }

            responses: dict[str, dict[str, object]] = {}
            for kind in ("regime_split", "homogeneity"):
                completed = subprocess.run(
                    [sys.executable, "-m", "panda_adapter.experiment_stdio"],
                    input=json.dumps(
                        {
                            "kind": kind,
                            "spec": spec,
                            "budget": {"maxVariants": 1},
                        }
                    ),
                    text=True,
                    capture_output=True,
                    check=False,
                    env=environment,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                responses[kind] = json.loads(completed.stdout)

            self.assertEqual(responses["regime_split"]["kind"], "regime_split")
            self.assertEqual(responses["regime_split"]["mode"], "index_daily")
            self.assertEqual(responses["homogeneity"]["kind"], "homogeneity")
            self.assertEqual(
                responses["homogeneity"]["mode"],
                "full_factor_library",
            )


if __name__ == "__main__":
    unittest.main()
