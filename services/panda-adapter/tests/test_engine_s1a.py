from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

import pandas as pd

from panda_adapter.engine import (
    order_cost_rate,
    run_momentum_backtest,
    run_request,
)


class EngineKnownAnswerTest(unittest.TestCase):
    def test_single_stock_compounds_from_day_after_next_close_execution(self) -> None:
        dates = pd.to_datetime(
            [
                "2026-01-27",
                "2026-01-28",
                "2026-01-29",
                "2026-01-30",  # month-end signal
                "2026-02-02",  # execution close
                "2026-02-03",  # first held return
                "2026-02-04",
            ]
        )
        prices = pd.DataFrame(
            {"A": [1.0, 1.1, 1.2, 1.3, 10.0, 11.0, 12.1]},
            index=dates,
        )

        result = run_momentum_backtest(
            prices,
            window=1,
            top_n=1,
            cost_model="standard",
        )
        rows = result["dailyReturns"]

        # The 1.3 -> 10.0 jump precedes execution and must not be earned.
        self.assertAlmostEqual(rows[4]["return"], -0.00025)
        self.assertAlmostEqual(rows[5]["return"], 0.1)
        self.assertAlmostEqual(rows[6]["return"], 0.1)
        self.assertAlmostEqual(
            rows[-1]["equity"],
            (1.0 - 0.00025) * 1.1 * 1.1,
        )

    def test_cost_equation_matches_each_frozen_model(self) -> None:
        self.assertAlmostEqual(order_cost_rate("buy", "standard"), 0.00025)
        self.assertAlmostEqual(order_cost_rate("sell", "standard"), 0.00075)
        self.assertAlmostEqual(order_cost_rate("buy", "realistic"), 0.00125)
        self.assertAlmostEqual(order_cost_rate("sell", "realistic"), 0.00175)
        self.assertAlmostEqual(
            order_cost_rate("buy", "pessimistic"),
            0.00125 * 1.5,
        )
        self.assertAlmostEqual(
            order_cost_rate("sell", "pessimistic"),
            0.00175 * 1.5,
        )

    def test_future_price_cannot_change_month_end_selection(self) -> None:
        dates = pd.to_datetime(
            [
                "2026-01-27",
                "2026-01-28",
                "2026-01-29",
                "2026-01-30",
                "2026-02-02",
                "2026-02-03",
            ]
        )
        baseline = pd.DataFrame(
            {
                "A": [10, 11, 12, 13, 14, 15],
                "B": [10, 10, 10, 10, 10, 10],
            },
            index=dates,
            dtype=float,
        )
        changed_future = baseline.copy()
        changed_future.loc[dates[4], "B"] = 10_000

        first = run_momentum_backtest(
            baseline,
            window=1,
            top_n=1,
            cost_model="standard",
        )
        second = run_momentum_backtest(
            changed_future,
            window=1,
            top_n=1,
            cost_model="standard",
        )

        # Both executions buy A; changing B at execution close only changes
        # future returns, never the already-frozen month-end signal.
        self.assertEqual(
            first["dailyReturns"][4]["return"],
            second["dailyReturns"][4]["return"],
        )
        self.assertEqual(
            first["dailyReturns"][5]["return"],
            second["dailyReturns"][5]["return"],
        )

    def test_signal_day_suspension_leaves_cash_without_rank_backfill(self) -> None:
        dates = pd.to_datetime(
            [
                "2026-01-27",
                "2026-01-28",
                "2026-01-29",
                "2026-01-30",
                "2026-02-02",
                "2026-02-03",
            ]
        )
        prices = pd.DataFrame(
            {
                "A": [1, 2, 3, 4, 4, 8],
                "B": [1, 1, 1, 1, 1, 2],
            },
            index=dates,
            dtype=float,
        )
        tradable = pd.DataFrame(True, index=dates, columns=prices.columns)
        tradable.loc[pd.Timestamp("2026-01-30"), "A"] = False

        result = run_momentum_backtest(
            prices,
            tradable=tradable,
            window=1,
            top_n=1,
            cost_model="standard",
        )

        self.assertEqual(result["dailyReturns"][-1]["return"], 0.0)
        self.assertEqual(result["dailyReturns"][-1]["equity"], 1.0)

    def test_execution_day_suspension_skips_trade_without_backfill(self) -> None:
        dates = pd.to_datetime(
            [
                "2026-01-27",
                "2026-01-28",
                "2026-01-29",
                "2026-01-30",
                "2026-02-02",
                "2026-02-03",
            ]
        )
        prices = pd.DataFrame(
            {
                "A": [1, 2, 3, 4, 4, 8],
                "B": [1, 1, 1, 1, 1, 2],
            },
            index=dates,
            dtype=float,
        )
        tradable = pd.DataFrame(True, index=dates, columns=prices.columns)
        tradable.loc[pd.Timestamp("2026-02-02"), "A"] = False

        result = run_momentum_backtest(
            prices,
            tradable=tradable,
            window=1,
            top_n=1,
            cost_model="standard",
        )

        self.assertEqual(result["dailyReturns"][-1]["return"], 0.0)
        self.assertEqual(result["dailyReturns"][-1]["equity"], 1.0)

    def test_untradable_existing_holding_is_locked_instead_of_replaced(self) -> None:
        dates = pd.to_datetime(
            [
                "2026-01-29",
                "2026-01-30",
                "2026-02-02",
                "2026-02-03",
                "2026-02-26",
                "2026-02-27",
                "2026-03-02",
                "2026-03-03",
            ]
        )
        prices = pd.DataFrame(
            {
                "A": [1, 2, 2, 2, 2, 2, 2, 2],
                "B": [1, 1, 1, 1, 1, 2, 2, 4],
            },
            index=dates,
            dtype=float,
        )
        tradable = pd.DataFrame(True, index=dates, columns=prices.columns)
        tradable.loc[pd.Timestamp("2026-03-02"), "A"] = False

        result = run_momentum_backtest(
            prices,
            tradable=tradable,
            window=1,
            top_n=1,
            cost_model="standard",
        )

        self.assertEqual(result["dailyReturns"][-1]["return"], 0.0)
        self.assertAlmostEqual(
            result["dailyReturns"][-1]["equity"],
            1.0 - 0.00025,
        )


class EngineProtocolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.spec = {
            "specVersion": "1",
            "universe": {"index": "000300.SH"},
            "signal": {
                "kind": "template",
                "template": "momentum",
                "params": {"window": 1},
            },
            "selection": {"topN": 1, "weighting": "equal"},
            "rebalance": {"frequency": "monthly", "at": "close"},
            "window": {"start": "20260127", "end": "20260203"},
            "costs": {"model": "standard"},
            "data": {
                "panel": {
                    "dates": [
                        "2026-01-27",
                        "2026-01-28",
                        "2026-01-29",
                        "2026-01-30",
                        "2026-02-02",
                        "2026-02-03",
                    ],
                    "symbols": ["A"],
                    "adjClose": [[1.0], [1.1], [1.2], [1.3], [1.4], [1.5]],
                }
            },
        }

    def test_grid_and_cost_ladder_match_s0_response_shape(self) -> None:
        grid = run_request(
            {
                "kind": "grid",
                "spec": self.spec,
                "grid": {
                    "signalParams": {"window": [1]},
                    "topN": [1],
                },
                "budget": {"maxVariants": 1},
            }
        )
        ladder = run_request(
            {
                "kind": "cost_ladder",
                "spec": self.spec,
                "budget": {"maxVariants": 3},
            }
        )

        json.dumps(grid, allow_nan=False)
        json.dumps(ladder, allow_nan=False)
        self.assertEqual(
            set(grid),
            {
                "engineVersion",
                "baseline",
                "variants",
                "summaryRef",
                "variantDailyReturns",
            },
        )
        self.assertEqual(
            len(grid["variantDailyReturns"]), len(grid["variants"])
        )
        self.assertEqual(
            len({len(series) for series in grid["variantDailyReturns"]}), 1
        )
        for series in grid["variantDailyReturns"]:
            self.assertTrue(all(isinstance(value, float) for value in series))
        self.assertEqual(
            grid["summaryRef"],
            "artifact:backtest/parameter-grid",
        )
        self.assertEqual(
            ladder["summaryRef"],
            "artifact:backtest/cost-stress",
        )
        self.assertEqual(
            [row["params"]["costModel"] for row in ladder["variants"]],
            ["standard", "realistic", "pessimistic"],
        )
        self.assertEqual(
            set(grid["baseline"]),
            {
                "params",
                "annualReturn",
                "sharpe",
                "maxDrawdown",
                "annualTurnover",
            },
        )

    def test_claim_baseline_uses_as_of_universe_and_no_costs(self) -> None:
        spec = {
            **self.spec,
            "costs": {"model": "none"},
        }
        baseline = run_request(
            {
                "kind": "baseline",
                "spec": spec,
                "universeMode": "asOf",
                "budget": {"maxVariants": 1},
            }
        )

        self.assertEqual(baseline["variants"], [])
        self.assertEqual(baseline["baseline"]["params"]["costModel"], "none")

        with self.assertRaisesRegex(ValueError, "universeMode"):
            run_request(
                {
                    "kind": "baseline",
                    "spec": spec,
                    "budget": {"maxVariants": 1},
                }
            )

    def test_cli_errors_use_stderr_only(self) -> None:
        environment = dict(os.environ)
        source_root = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "src")
        )
        environment["PYTHONPATH"] = source_root
        completed = subprocess.run(
            [sys.executable, "-m", "panda_adapter.engine"],
            input=json.dumps(
                {
                    "kind": "grid",
                    "spec": self.spec,
                    "grid": {
                        "signalParams": {"window": [1, 2]},
                        "topN": [1],
                    },
                    "budget": {"maxVariants": 1},
                }
            ),
            text=True,
            capture_output=True,
            check=False,
            env=environment,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "")
        error = json.loads(completed.stderr)
        self.assertEqual(set(error), {"error", "message"})
        self.assertNotIn("\n", completed.stderr.rstrip("\n"))


if __name__ == "__main__":
    unittest.main()
