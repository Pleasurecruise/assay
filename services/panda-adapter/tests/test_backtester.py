from __future__ import annotations

import unittest

import pandas as pd

from panda_adapter.backtester import BacktestValidationError, run_backtest_frames


def strategy_spec(start: str, end: str) -> dict[str, object]:
    return {
        "specVersion": "1",
        "universe": {"index": "000300.SH"},
        "signal": {
            "kind": "template",
            "template": "momentum",
            "params": {"window": 5},
        },
        "selection": {"topN": 1, "weighting": "equal"},
        "rebalance": {"frequency": "weekly", "at": "close"},
        "window": {"start": start, "end": end},
        "costs": {"model": "none"},
    }


class BacktesterTest(unittest.TestCase):
    def setUp(self) -> None:
        dates = pd.bdate_range("2026-01-01", periods=60)
        rows: list[dict[str, object]] = []
        weights: list[dict[str, object]] = []
        for index, current in enumerate(dates):
            day = current.strftime("%Y%m%d")
            for symbol, daily_return in (
                ("000001.SZ", 0.01),
                ("000002.SZ", -0.002),
            ):
                close = (1 + daily_return) ** index * 10
                pre_close = close / (1 + daily_return) if index > 0 else close
                rows.append(
                    {
                        "date": day,
                        "symbol": symbol,
                        "close": close,
                        "pre_close": pre_close,
                        "turnover_rate": 0.01,
                    }
                )
                weights.append(
                    {
                        "date": day,
                        "index_symbol": "000300.SH",
                        "stock_symbol": symbol,
                        "weight": 0.5,
                    }
                )
        self.market = pd.DataFrame.from_records(rows)
        self.weights = pd.DataFrame.from_records(weights)
        self.start = dates[10].strftime("%Y%m%d")
        self.end = dates[-1].strftime("%Y%m%d")

    def test_runs_a_point_in_time_momentum_backtest(self) -> None:
        result = run_backtest_frames(
            strategy_spec(self.start, self.end),
            self.market,
            self.weights,
            window_override=5,
            cost_bps=0,
        )

        self.assertEqual(result["observations"], 50)
        self.assertGreater(result["rebalanceCount"], 0)
        self.assertGreater(result["annualReturn"], 0)
        self.assertGreater(result["sharpe"], 0)
        self.assertEqual(result["costBps"], 0)

    def test_rejects_market_data_without_total_return_inputs(self) -> None:
        with self.assertRaisesRegex(BacktestValidationError, "pre_close"):
            run_backtest_frames(
                strategy_spec(self.start, self.end),
                self.market.drop(columns=["pre_close"]),
                self.weights,
            )


if __name__ == "__main__":
    unittest.main()
