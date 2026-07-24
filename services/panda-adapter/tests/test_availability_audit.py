from __future__ import annotations

from http.client import IncompleteRead
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pandas as pd

from panda_adapter.availability_audit import (
    AVAILABILITY_SOURCE_REF,
    PIT_SNAPSHOT_SCHEMA_VERSION,
    _snapshot_path,
    _write_json_atomic,
    run_availability_audit,
)
from panda_adapter.data_transport import RetryPolicy
from panda_adapter.engine.protocol import run_request
from panda_adapter.market_panel import MarketPanel


def _spec(dates: pd.DatetimeIndex) -> dict[str, object]:
    return {
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
    }


def _base_panel() -> MarketPanel:
    dates = pd.bdate_range("2026-01-01", "2026-03-31")
    positions = np.arange(len(dates), dtype=float)
    prices = pd.DataFrame(
        {
            "A": 100.0 * np.power(1.001, positions),
            "B": 100.0 * np.power(1.004, positions),
        },
        index=dates,
    )
    return MarketPanel(
        adjusted_close=prices,
        tradable=pd.DataFrame(True, index=dates, columns=prices.columns),
    )


def _rebalance_dates(panel: MarketPanel) -> list[pd.Timestamp]:
    dates = panel.adjusted_close.index
    periods = dates.to_period("M")
    return [
        pd.Timestamp(dates[position])
        for position in range(len(dates) - 1)
        if periods[position] != periods[position + 1]
    ]


class FakePITClient:
    def __init__(
        self,
        *,
        memberships: dict[str, list[str]],
        base_dates: pd.DatetimeIndex,
        factor_failure: bool = False,
    ) -> None:
        self.memberships = memberships
        self.base_dates = base_dates
        self.factor_failure = factor_failure
        self.index_calls: list[dict[str, object]] = []
        self.factor_calls: list[dict[str, object]] = []
        self.status_calls: list[dict[str, object]] = []

    def get_index_weights(self, **values: object) -> pd.DataFrame:
        self.index_calls.append(values)
        requested = str(values["end_date"])
        return pd.DataFrame(
            [
                {
                    "date": requested,
                    "stock_symbol": symbol,
                    "weight": 1.0,
                }
                for symbol in self.memberships[requested]
            ]
        )

    def get_factor(self, **values: object) -> pd.DataFrame:
        self.factor_calls.append(values)
        if self.factor_failure:
            raise IncompleteRead(b"", 10)
        start = pd.to_datetime(str(values["start_date"]))
        end = pd.to_datetime(str(values["end_date"]))
        dates = self.base_dates[(self.base_dates >= start) & (self.base_dates <= end)]
        symbols = list(values["symbol"])
        return pd.DataFrame(
            [
                {
                    "date": date.strftime("%Y%m%d"),
                    "symbol": symbol,
                    "close": 100.0 * (1.003 ** int(self.base_dates.get_loc(date))),
                }
                for date in dates
                for symbol in symbols
            ]
        )

    def get_market_data(self, **values: object) -> pd.DataFrame:
        self.status_calls.append(values)
        date = str(values["start_date"])
        symbols = list(values["symbol"])
        return pd.DataFrame(
            [
                {
                    "date": date,
                    "symbol": symbol,
                    "trade_status": (1 if date == "20260202" and symbol == "C" else 0),
                }
                for symbol in symbols
            ]
        )


class SequenceClock:
    def __init__(self, values: list[float]) -> None:
        self.values = iter(values)
        self.last = 0.0

    def __call__(self) -> float:
        self.last = next(self.values, self.last)
        return self.last


class AvailabilityAuditTest(unittest.TestCase):
    def test_full_pit_fetches_only_missing_symbols_and_reuses_cache(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        memberships = {date.strftime("%Y%m%d"): ["A", "C"] for date in signal_dates}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_json_atomic(
                _snapshot_path(root, "000300.SH", signal_dates[0]),
                {
                    "schemaVersion": PIT_SNAPSHOT_SCHEMA_VERSION,
                    "indexSymbol": "000300.SH",
                    "requestedDate": signal_dates[0].strftime("%Y-%m-%d"),
                    "effectiveDate": signal_dates[0].strftime("%Y-%m-%d"),
                    "symbols": ["A", "C"],
                },
            )
            first_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
            )
            first = run_availability_audit(
                _spec(panel.adjusted_close.index),
                panel_loader=lambda _: panel,
                client=first_client,
                cache_root=root,
                retry_policy=RetryPolicy(
                    max_attempts=1,
                    initial_delay_seconds=0,
                    max_delay_seconds=0,
                ),
            )

            self.assertEqual(
                set(first),
                {
                    "engineVersion",
                    "mode",
                    "futureConstituentCount",
                    "affectedRebalances",
                    "sampleSymbols",
                    "untradableTargets",
                    "contaminatedSelectionRate",
                    "corrected",
                    "sourceRef",
                    "assumptions",
                },
            )
            self.assertEqual(first["mode"], "full_pit")
            self.assertEqual(first["futureConstituentCount"], 1)
            self.assertEqual(first["sampleSymbols"], ["B"])
            self.assertEqual(
                first["affectedRebalances"],
                [date.strftime("%Y-%m-%d") for date in signal_dates],
            )
            self.assertEqual(first["untradableTargets"], 1)
            self.assertEqual(first["contaminatedSelectionRate"], 1.0)
            self.assertEqual(first["sourceRef"], AVAILABILITY_SOURCE_REF)
            self.assertEqual(
                first["corrected"]["delta"],
                first["corrected"]["annualReturn"]
                - self._baseline_annual_return(panel),
            )
            self.assertEqual(
                [call["end_date"] for call in first_client.index_calls],
                [signal_dates[1].strftime("%Y%m%d")],
            )
            self.assertTrue(first_client.factor_calls)
            self.assertTrue(first_client.status_calls)
            self.assertTrue(
                all(call["symbol"] == ["C"] for call in first_client.factor_calls)
            )
            self.assertTrue(
                all(call["symbol"] == ["C"] for call in first_client.status_calls)
            )

            cached_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
                factor_failure=True,
            )
            second = run_availability_audit(
                _spec(panel.adjusted_close.index),
                panel_loader=lambda _: panel,
                client=cached_client,
                cache_root=root,
                retry_policy=RetryPolicy(
                    max_attempts=1,
                    initial_delay_seconds=0,
                    max_delay_seconds=0,
                ),
            )

            self.assertEqual(second["mode"], "full_pit")
            self.assertEqual(cached_client.index_calls, [])
            self.assertEqual(cached_client.factor_calls, [])
            self.assertEqual(cached_client.status_calls, [])

    def test_degrades_only_after_budget_and_never_fetches_base_symbols(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        memberships = {date.strftime("%Y%m%d"): ["A", "C"] for date in signal_dates}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for date in signal_dates:
                path = _snapshot_path(root, "000300.SH", date)
                _write_json_atomic(
                    path,
                    {
                        "schemaVersion": PIT_SNAPSHOT_SCHEMA_VERSION,
                        "indexSymbol": "000300.SH",
                        "requestedDate": date.strftime("%Y-%m-%d"),
                        "effectiveDate": date.strftime("%Y-%m-%d"),
                        "symbols": ["A", "C"],
                    },
                )
            client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
                factor_failure=True,
            )
            result = run_availability_audit(
                _spec(panel.adjusted_close.index),
                panel_loader=lambda _: panel,
                client=client,
                cache_root=root,
                max_blocked_seconds=1_200,
                clock=SequenceClock([0.0, 1_201.0]),
                sleeper=lambda _: None,
                retry_policy=RetryPolicy(
                    max_attempts=1,
                    initial_delay_seconds=0,
                    max_delay_seconds=0,
                ),
            )

            self.assertEqual(result["mode"], "degraded_remove_only")
            self.assertTrue(
                any("remove-only" in item for item in result["assumptions"])
            )
            self.assertEqual(result["futureConstituentCount"], 1)
            self.assertEqual(result["sampleSymbols"], ["B"])
            self.assertEqual(len(client.factor_calls), 1)
            self.assertEqual(client.factor_calls[0]["symbol"], ["C"])
            self.assertEqual(client.status_calls, [])

    def test_protocol_dispatches_once_without_loading_a_panel(self) -> None:
        panel = _base_panel()
        calls: list[dict[str, object]] = []
        response = {
            "engineVersion": "test",
            "mode": "full_pit",
            "futureConstituentCount": 0,
            "affectedRebalances": [],
            "sampleSymbols": [],
            "untradableTargets": 0,
            "contaminatedSelectionRate": 0.0,
            "corrected": {
                "annualReturn": 0.1,
                "sharpe": 1.0,
                "delta": 0.0,
            },
            "sourceRef": AVAILABILITY_SOURCE_REF,
            "assumptions": [],
        }

        actual = run_request(
            {
                "kind": "availability_audit",
                "spec": _spec(panel.adjusted_close.index),
                "budget": {"maxVariants": 1},
            },
            panel_loader=lambda _: self.fail("panel loader must not run"),
            availability_runner=lambda spec: calls.append(dict(spec)) or response,
        )

        self.assertIs(actual, response)
        self.assertEqual(len(calls), 1)
        with self.assertRaisesRegex(
            ValueError,
            "budget.maxVariants must equal 1",
        ):
            run_request(
                {
                    "kind": "availability_audit",
                    "spec": _spec(panel.adjusted_close.index),
                    "budget": {"maxVariants": 2},
                },
                availability_runner=lambda _: response,
            )

    @staticmethod
    def _baseline_annual_return(panel: MarketPanel) -> float:
        from panda_adapter.engine.core import run_momentum_backtest

        result = run_momentum_backtest(
            panel.adjusted_close,
            tradable=panel.tradable,
            window=5,
            top_n=1,
            cost_model="standard",
        )
        return float(result["metrics"]["annualReturn"])


if __name__ == "__main__":
    unittest.main()
