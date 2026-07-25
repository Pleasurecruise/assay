from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pandas as pd

from panda_adapter.engine.artifacts import (
    DAILY_RETURNS_REF_PREFIX,
    daily_returns_artifact_path,
)
from panda_adapter.engine.constants import PARAMETER_GRID_ARTIFACT_DIRECTORY
from panda_adapter.engine.experiments import run_grid


class GridDailyReturnArtifactTest(unittest.TestCase):
    def test_baseline_and_every_variant_are_stable_content_artifacts(
        self,
    ) -> None:
        dates = pd.bdate_range("2026-01-02", periods=70)
        positions = np.arange(len(dates), dtype=float)
        prices = pd.DataFrame(
            {
                "A": 100.0 * np.power(1.001, positions),
                "B": 100.0 * np.power(1.002, positions),
            },
            index=dates,
        )
        baseline = {"window": 5, "topN": 1, "costModel": "none"}
        variants = [
            {"variantId": "w3-n1", "window": 3, "topN": 1},
            {"variantId": "w7-n1", "window": 7, "topN": 1},
        ]

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = run_grid(
                prices,
                baseline=baseline,
                variants=variants,
                artifact_root=root,
            )
            references = [
                first["baseline"]["params"]["dailyReturnsRef"],
                *[
                    row["params"]["dailyReturnsRef"]
                    for row in first["variants"]
                ],
            ]
            self.assertEqual(len(set(references)), 3)
            self.assertTrue(
                all(
                    reference.startswith(DAILY_RETURNS_REF_PREFIX)
                    for reference in references
                )
            )
            self.assertTrue(
                all(str(root) not in reference for reference in references)
            )
            paths = [
                daily_returns_artifact_path(reference, root=root)
                for reference in references
            ]
            before = {path: path.read_bytes() for path in paths}
            for path in paths:
                payload = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(
                    set(payload),
                    {
                        "schemaVersion",
                        "engineVersion",
                        "kind",
                        "variantId",
                        "params",
                        "dailyReturns",
                    },
                )
                self.assertEqual(payload["kind"], "parameter_grid")
                self.assertEqual(len(payload["dailyReturns"]), len(dates))

            second = run_grid(
                prices,
                baseline=baseline,
                variants=variants,
                artifact_root=root,
            )
            repeated_references = [
                second["baseline"]["params"]["dailyReturnsRef"],
                *[
                    row["params"]["dailyReturnsRef"]
                    for row in second["variants"]
                ],
            ]

            self.assertEqual(repeated_references, references)
            self.assertEqual(
                {path: path.read_bytes() for path in paths},
                before,
            )
            self.assertEqual(
                len(
                    list(
                        (
                            root / PARAMETER_GRID_ARTIFACT_DIRECTORY
                        ).glob("*.json")
                    )
                ),
                3,
            )


if __name__ == "__main__":
    unittest.main()
