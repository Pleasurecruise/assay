from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from panda_adapter.audit_cache import ComparatorFactorCache
from panda_adapter.engine.constants import (
    AUDIT_TOOL_CONTRACT_VERSION,
    HOMOGENEITY_AUDIT_SOURCE_REF,
)
from panda_adapter.engine.protocol import run_request
from panda_adapter.homogeneity_audit import (
    annual_information_coefficients,
    calculate_rank_ic_slope,
    mean_cross_sectional_spearman,
    run_homogeneity,
    spearman_coefficient,
)
from panda_adapter.market_panel import MarketPanel


class HomogeneityKnownAnswerTest(unittest.TestCase):
    def test_spearman_matches_tie_average_known_answers(self) -> None:
        self.assertAlmostEqual(
            spearman_coefficient(
                pd.Series([1.0, 1.0, 3.0, 4.0, np.nan]),
                pd.Series([10.0, 10.0, 30.0, 40.0, 999.0]),
            ),
            1.0,
        )
        self.assertAlmostEqual(
            spearman_coefficient(
                pd.Series([1.0, 2.0, 3.0, 4.0]),
                pd.Series([4.0, 3.0, 2.0, 1.0]),
            ),
            -1.0,
        )
        self.assertIsNone(
            spearman_coefficient(
                pd.Series([1.0, 1.0, 1.0]),
                pd.Series([1.0, 2.0, 3.0]),
            )
        )

    def test_cross_sectional_mean_counts_only_valid_rebalances(self) -> None:
        dates = pd.DatetimeIndex(["2026-01-30", "2026-02-27", "2026-03-31"])
        columns = ["A", "B", "C", "D"]
        left = pd.DataFrame(
            [[1, 2, 3, 4], [1, 2, 3, 4], [1, 1, 1, 1]],
            index=dates,
            columns=columns,
            dtype=float,
        )
        right = pd.DataFrame(
            [[10, 20, 30, 40], [40, 30, 20, 10], [1, 2, 3, 4]],
            index=dates,
            columns=columns,
            dtype=float,
        )

        value, observations = mean_cross_sectional_spearman(
            left,
            right,
            dates=dates,
        )

        self.assertEqual(observations, 2)
        self.assertAlmostEqual(value, 0.0)

    def test_annual_ic_and_rank_slope_are_hand_calculable(self) -> None:
        dates = pd.DatetimeIndex(["2024-01-31", "2024-02-29"])
        columns = ["A", "B", "C", "D"]
        signal = pd.DataFrame(
            [[1.0, 2.0, 3.0, 4.0], [0.0, 0.0, 0.0, 0.0]],
            index=dates,
            columns=columns,
        )
        prices = pd.DataFrame(
            [
                [100.0, 100.0, 100.0, 100.0],
                [101.0, 102.0, 103.0, 104.0],
            ],
            index=dates,
            columns=columns,
        )

        annual = annual_information_coefficients(
            signal,
            prices,
            rebalance_dates=dates,
        )

        self.assertEqual(len(annual), 1)
        self.assertEqual(annual[0]["year"], "2024")
        self.assertEqual(annual[0]["observations"], 1)
        self.assertAlmostEqual(annual[0]["pearsonIc"], 1.0)
        self.assertAlmostEqual(annual[0]["rankIc"], 1.0)
        self.assertAlmostEqual(
            calculate_rank_ic_slope(
                [
                    {"year": "2024", "rankIc": 1.0},
                    {"year": "2025", "rankIc": 0.5},
                    {"year": "2026", "rankIc": 0.0},
                ]
            ),
            -0.5,
        )

    def test_runner_supports_full_and_classic_only_modes(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=520)
        positions = np.arange(len(dates), dtype=float)
        growth = np.asarray([1.0005, 1.0008, 1.0011, 1.0014])
        prices = pd.DataFrame(
            {
                symbol: 100.0 * np.power(rate, positions)
                for symbol, rate in zip(
                    ["A", "B", "C", "D"],
                    growth,
                    strict=True,
                )
            },
            index=dates,
        )
        panel = MarketPanel(
            adjusted_close=prices,
            tradable=pd.DataFrame(True, index=dates, columns=prices.columns),
        )
        factors = {
            "ratio_pe_ttm": prices.div(prices.iloc[0]),
            "market_cap": prices.rank(axis=1, method="average"),
        }
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

        classic = run_homogeneity(
            spec,
            panel_loader=lambda _: panel,
            factor_loader=lambda: None,
        )
        full = run_homogeneity(
            spec,
            panel_loader=lambda _: panel,
            factor_loader=lambda: ComparatorFactorCache(
                values=factors,
                cache_version="known-answer",
            ),
        )

        self.assertEqual(classic["contractVersion"], AUDIT_TOOL_CONTRACT_VERSION)
        self.assertEqual(classic["mode"], "classic_only")
        self.assertEqual(len(classic["comparisons"]), 3)
        self.assertEqual(full["mode"], "full_factor_library")
        self.assertEqual(len(full["comparisons"]), 5)
        self.assertEqual(full["summary"]["nearestComparator"], "momentum_20")
        self.assertAlmostEqual(full["summary"]["maxAbsMeanSpearman"], 1.0)
        self.assertEqual(full["sourceRef"], HOMOGENEITY_AUDIT_SOURCE_REF)
        self.assertTrue(full["annualIc"])

    def test_protocol_dispatches_homogeneity_once(self) -> None:
        spec = {"frozen": True}
        expected = {"kind": "homogeneity"}
        calls: list[object] = []

        actual = run_request(
            {
                "kind": "homogeneity",
                "spec": spec,
                "budget": {"maxVariants": 1},
            },
            panel_loader=lambda _: self.fail("plain panel loader must not run"),
            homogeneity_runner=lambda value: calls.append(value) or expected,
        )

        self.assertIs(actual, expected)
        self.assertEqual(calls, [spec])
        with self.assertRaisesRegex(ValueError, "does not accept grid"):
            run_request(
                {
                    "kind": "homogeneity",
                    "spec": spec,
                    "grid": {},
                    "budget": {"maxVariants": 1},
                },
                homogeneity_runner=lambda _: expected,
            )


if __name__ == "__main__":
    unittest.main()
