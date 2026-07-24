from __future__ import annotations

import math
import unittest

import numpy as np
import pandas as pd

from panda_adapter.audit_cache import IndexDailyCache
from panda_adapter.engine.constants import (
    AUDIT_TOOL_CONTRACT_VERSION,
    REGIME_SPLIT_SOURCE_REF,
)
from panda_adapter.engine.protocol import run_request
from panda_adapter.market_panel import MarketPanel
from panda_adapter.regime_audit import (
    label_regimes,
    run_regime_split,
    split_returns_by_regime,
)


class RegimeAuditKnownAnswerTest(unittest.TestCase):
    def test_label_for_t_is_invariant_to_t_and_future_prices(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=280)
        positions = np.arange(len(dates), dtype=float)
        close = pd.Series(
            100.0
            * np.exp(0.0005 * positions)
            * (1.0 + 0.01 * np.sin(positions / 3.0)),
            index=dates,
        )
        target = dates[240]

        before = label_regimes(close, [target]).iloc[0]
        mutated = close.copy()
        mutated.loc[target:] = mutated.loc[target:] * 25.0
        after = label_regimes(mutated, [target]).iloc[0]

        self.assertEqual(before["priorDate"], dates[239])
        self.assertEqual(before["id"], after["id"])
        self.assertEqual(before["trend"], after["trend"])
        self.assertEqual(before["volatility"], after["volatility"])

    def test_slice_metrics_and_additive_pnl_share_are_hand_calculable(
        self,
    ) -> None:
        dates = pd.bdate_range("2026-01-05", periods=4)
        rows = [
            {"date": dates[0].strftime("%Y-%m-%d"), "return": 0.1, "equity": 1.1},
            {"date": dates[1].strftime("%Y-%m-%d"), "return": 0.0, "equity": 1.1},
            {
                "date": dates[2].strftime("%Y-%m-%d"),
                "return": 0.1,
                "equity": 1.21,
            },
            {
                "date": dates[3].strftime("%Y-%m-%d"),
                "return": 0.0,
                "equity": 1.21,
            },
        ]
        labels = pd.DataFrame(
            {
                "id": ["up-high", "up-high", "down-normal", "down-normal"],
                "trend": ["up", "up", "down", "down"],
                "volatility": ["high", "high", "normal", "normal"],
            },
            index=dates,
        )

        environments, zero_total, unlabeled = split_returns_by_regime(
            rows,
            labels,
        )
        by_id = {row["id"]: row for row in environments}

        self.assertFalse(zero_total)
        self.assertEqual(unlabeled, 0)
        self.assertEqual(by_id["up-high"]["days"], 2)
        self.assertAlmostEqual(
            by_id["up-high"]["annualReturn"],
            1.1 ** 126 - 1.0,
        )
        self.assertAlmostEqual(by_id["up-high"]["sharpe"], math.sqrt(126))
        self.assertAlmostEqual(by_id["up-high"]["pnlShare"], 10 / 21)
        self.assertAlmostEqual(by_id["down-normal"]["pnlShare"], 11 / 21)
        self.assertAlmostEqual(
            sum(float(row["pnlShare"]) for row in environments),
            1.0,
        )

    def test_zero_full_period_pnl_maps_all_shares_to_zero(self) -> None:
        dates = pd.bdate_range("2026-01-05", periods=2)
        rows = [
            {"date": dates[0].strftime("%Y-%m-%d"), "return": 0.1, "equity": 1.1},
            {
                "date": dates[1].strftime("%Y-%m-%d"),
                "return": -(1.0 / 11.0),
                "equity": 1.0,
            },
        ]
        labels = pd.DataFrame(
            {
                "id": ["up-high", "down-normal"],
                "trend": ["up", "down"],
                "volatility": ["high", "normal"],
            },
            index=dates,
        )

        environments, zero_total, unlabeled = split_returns_by_regime(
            rows,
            labels,
        )

        self.assertTrue(zero_total)
        self.assertEqual(unlabeled, 0)
        self.assertEqual(
            [row["pnlShare"] for row in environments],
            [0.0, 0.0],
        )

    def test_unlabeled_warmup_keeps_full_period_pnl_denominator(self) -> None:
        dates = pd.bdate_range("2026-01-05", periods=3)
        rows = [
            {
                "date": dates[0].strftime("%Y-%m-%d"),
                "return": 0.1,
                "equity": 1.1,
            },
            {
                "date": dates[1].strftime("%Y-%m-%d"),
                "return": 0.1,
                "equity": 1.21,
            },
            {
                "date": dates[2].strftime("%Y-%m-%d"),
                "return": 0.0,
                "equity": 1.21,
            },
        ]
        labels = pd.DataFrame(
            {
                "id": [None, "up-normal", "up-normal"],
                "trend": [None, "up", "up"],
                "volatility": [None, "normal", "normal"],
            },
            index=dates,
        )

        environments, zero_total, unlabeled = split_returns_by_regime(
            rows,
            labels,
        )

        self.assertFalse(zero_total)
        self.assertEqual(unlabeled, 1)
        self.assertEqual(environments[0]["days"], 2)
        self.assertAlmostEqual(environments[0]["pnlShare"], 11 / 21)

    def test_runner_returns_the_frozen_response_shape(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=320)
        prices = pd.DataFrame(
            100.0,
            index=dates,
            columns=["A", "B", "C"],
        )
        panel = MarketPanel(
            adjusted_close=prices,
            tradable=pd.DataFrame(True, index=dates, columns=prices.columns),
        )
        positions = np.arange(len(dates), dtype=float)
        index_close = pd.Series(
            100.0
            * np.exp(0.0004 * positions)
            * (1.0 + 0.01 * np.sin(positions / 4.0)),
            index=dates,
        )
        spec = {
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
            "costs": {"model": "none"},
        }

        result = run_regime_split(
            spec,
            panel_loader=lambda _: panel,
            index_loader=lambda: IndexDailyCache(index_close, "known-answer"),
        )

        self.assertEqual(
            set(result),
            {
                "contractVersion",
                "engineVersion",
                "kind",
                "mode",
                "environments",
                "dominantEnvironment",
                "sourceRef",
                "assumptions",
            },
        )
        self.assertEqual(
            result["contractVersion"],
            AUDIT_TOOL_CONTRACT_VERSION,
        )
        self.assertEqual(result["kind"], "regime_split")
        self.assertEqual(result["mode"], "index_daily")
        self.assertEqual(result["sourceRef"], REGIME_SPLIT_SOURCE_REF)
        self.assertTrue(
            any("pnlShare is deterministically set" in item for item in result["assumptions"])
        )

    def test_protocol_dispatches_regime_without_loading_plain_panel(
        self,
    ) -> None:
        spec = {"frozen": True}
        expected = {"kind": "regime_split"}
        calls: list[object] = []

        actual = run_request(
            {
                "kind": "regime_split",
                "spec": spec,
                "budget": {"maxVariants": 1},
            },
            panel_loader=lambda _: self.fail("plain panel loader must not run"),
            regime_runner=lambda value: calls.append(value) or expected,
        )

        self.assertIs(actual, expected)
        self.assertEqual(calls, [spec])
        with self.assertRaisesRegex(ValueError, "maxVariants must equal 1"):
            run_request(
                {
                    "kind": "regime_split",
                    "spec": spec,
                    "budget": {"maxVariants": 2},
                },
                regime_runner=lambda _: expected,
            )


if __name__ == "__main__":
    unittest.main()
