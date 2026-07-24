from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import pandas as pd


class ExperimentStdioIntegrationTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
