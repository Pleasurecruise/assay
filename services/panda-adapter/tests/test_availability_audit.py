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
    _count_untradable_targets,
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


def _untradable_target_count(
    rebalance_pairs: list[tuple[pd.Timestamp, pd.Timestamp]],
    *,
    untradable_dates: set[pd.Timestamp],
) -> int:
    date_values = {pd.Timestamp("2026-01-29")}
    for signal_date, execution_date in rebalance_pairs:
        date_values.update((signal_date, execution_date))
    dates = pd.DatetimeIndex(sorted(date_values))
    prices = pd.DataFrame(
        {"A": 100.0 + np.arange(len(dates), dtype=float)},
        index=dates,
    )
    tradable = pd.DataFrame(True, index=dates, columns=prices.columns)
    for date in untradable_dates:
        tradable.loc[date, "A"] = False
    eligibility = pd.DataFrame(False, index=dates, columns=prices.columns)
    for signal_date, _ in rebalance_pairs:
        eligibility.loc[signal_date, "A"] = True
    return _count_untradable_targets(
        panel=MarketPanel(adjusted_close=prices, tradable=tradable),
        eligibility=eligibility,
        rebalance_pairs=rebalance_pairs,
        window=1,
        top_n=1,
    )


class FakePITClient:
    def __init__(
        self,
        *,
        memberships: dict[str, list[str]],
        base_dates: pd.DatetimeIndex,
        factor_failure: bool = False,
        factor_failure_after: int | None = None,
        status_failure_after: int | None = None,
        omit_factor_symbol: str | None = None,
        omit_status_symbol_on_first_call: str | None = None,
        empty_factor_calls: set[int] | None = None,
        non_tradable_status_dates: set[str] | None = None,
    ) -> None:
        self.memberships = memberships
        self.base_dates = base_dates
        self.factor_failure = factor_failure
        self.factor_failure_after = factor_failure_after
        self.status_failure_after = status_failure_after
        self.omit_factor_symbol = omit_factor_symbol
        self.omit_status_symbol_on_first_call = omit_status_symbol_on_first_call
        self.empty_factor_calls = empty_factor_calls or set()
        self.non_tradable_status_dates = non_tradable_status_dates or set()
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
        if (
            self.factor_failure_after is not None
            and len(self.factor_calls) > self.factor_failure_after
        ):
            raise RuntimeError("simulated process interruption")
        if len(self.factor_calls) in self.empty_factor_calls:
            return pd.DataFrame()
        start = pd.to_datetime(str(values["start_date"]))
        end = pd.to_datetime(str(values["end_date"]))
        dates = self.base_dates[(self.base_dates >= start) & (self.base_dates <= end)]
        symbols = [
            symbol
            for symbol in list(values["symbol"])
            if symbol != self.omit_factor_symbol
        ]
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
        if (
            self.status_failure_after is not None
            and len(self.status_calls) > self.status_failure_after
        ):
            raise RuntimeError("simulated process interruption")
        date = str(values["start_date"])
        symbols = list(values["symbol"])
        if len(self.status_calls) == 1:
            symbols = [
                symbol
                for symbol in symbols
                if symbol != self.omit_status_symbol_on_first_call
            ]
        return pd.DataFrame(
            [
                {
                    "date": date,
                    "symbol": symbol,
                    "trade_status": (
                        1
                        if (
                            symbol == "C"
                            and (
                                date == "20260202"
                                or date in self.non_tradable_status_dates
                            )
                        )
                        else 0
                    ),
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

    def test_interrupted_extra_panel_resumes_factor_and_status_fragments(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        memberships = {date.strftime("%Y%m%d"): ["A", "C"] for date in signal_dates}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            factor_interrupted_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
                factor_failure_after=1,
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "^simulated process interruption$",
            ):
                run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: panel,
                    client=factor_interrupted_client,
                    cache_root=root,
                    retry_policy=RetryPolicy(
                        max_attempts=1,
                        initial_delay_seconds=0,
                        max_delay_seconds=0,
                    ),
                )

            self.assertEqual(len(factor_interrupted_client.factor_calls), 2)
            self.assertEqual(factor_interrupted_client.status_calls, [])
            self.assertEqual(
                list(root.glob("extra-panel/*/symbols-*.json")),
                [],
            )
            self.assertEqual(
                len(list(root.glob("extra-panel/*/fragments/factor-close/**/*.json"))),
                1,
            )

            status_interrupted_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
                status_failure_after=1,
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "^simulated process interruption$",
            ):
                run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: panel,
                    client=status_interrupted_client,
                    cache_root=root,
                    retry_policy=RetryPolicy(
                        max_attempts=1,
                        initial_delay_seconds=0,
                        max_delay_seconds=0,
                    ),
                )

            self.assertEqual(status_interrupted_client.index_calls, [])
            self.assertTrue(status_interrupted_client.factor_calls)
            self.assertNotEqual(
                status_interrupted_client.factor_calls[0]["start_date"],
                factor_interrupted_client.factor_calls[0]["start_date"],
            )
            self.assertEqual(len(status_interrupted_client.status_calls), 2)
            self.assertEqual(
                len(list(root.glob("extra-panel/*/fragments/trade-status/**/*.json"))),
                1,
            )

            resumed_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
            )
            result = run_availability_audit(
                _spec(panel.adjusted_close.index),
                panel_loader=lambda _: panel,
                client=resumed_client,
                cache_root=root,
                retry_policy=RetryPolicy(
                    max_attempts=1,
                    initial_delay_seconds=0,
                    max_delay_seconds=0,
                ),
            )

            self.assertEqual(result["mode"], "full_pit")
            self.assertEqual(resumed_client.index_calls, [])
            self.assertEqual(resumed_client.factor_calls, [])
            expected_status_dates = [
                date.strftime("%Y%m%d") for date in panel.adjusted_close.index[1:]
            ]
            self.assertEqual(
                [str(call["start_date"]) for call in resumed_client.status_calls],
                expected_status_dates,
            )
            self.assertEqual(
                len(list(root.glob("extra-panel/*/symbols-*.json"))),
                1,
            )

    def test_incomplete_status_fragment_is_not_cached_and_can_be_retried(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        memberships = {date.strftime("%Y%m%d"): ["A", "C"] for date in signal_dates}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            incomplete_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
                omit_status_symbol_on_first_call="C",
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "missing required symbol coverage",
            ):
                run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: panel,
                    client=incomplete_client,
                    cache_root=root,
                    retry_policy=RetryPolicy(
                        max_attempts=1,
                        initial_delay_seconds=0,
                        max_delay_seconds=0,
                    ),
                )

            self.assertTrue(incomplete_client.factor_calls)
            self.assertEqual(len(incomplete_client.status_calls), 1)
            self.assertEqual(
                list(root.glob("extra-panel/*/fragments/trade-status/**/*.json")),
                [],
            )
            self.assertEqual(
                list(root.glob("extra-panel/*/symbols-*.json")),
                [],
            )

            resumed_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
            )
            result = run_availability_audit(
                _spec(panel.adjusted_close.index),
                panel_loader=lambda _: panel,
                client=resumed_client,
                cache_root=root,
                retry_policy=RetryPolicy(
                    max_attempts=1,
                    initial_delay_seconds=0,
                    max_delay_seconds=0,
                ),
            )

            self.assertEqual(result["mode"], "full_pit")
            self.assertEqual(resumed_client.factor_calls, [])
            self.assertTrue(resumed_client.status_calls)

    def test_incomplete_factor_batch_is_discarded_before_retry(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        memberships = {date.strftime("%Y%m%d"): ["A", "C"] for date in signal_dates}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            incomplete_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
                omit_factor_symbol="C",
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "returned no prices",
            ):
                run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: panel,
                    client=incomplete_client,
                    cache_root=root,
                    retry_policy=RetryPolicy(
                        max_attempts=1,
                        initial_delay_seconds=0,
                        max_delay_seconds=0,
                    ),
                )

            self.assertTrue(incomplete_client.factor_calls)
            self.assertEqual(incomplete_client.status_calls, [])
            self.assertEqual(
                list(root.glob("extra-panel/*/fragments/factor-close/**/*.json")),
                [],
            )

            resumed_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
            )
            result = run_availability_audit(
                _spec(panel.adjusted_close.index),
                panel_loader=lambda _: panel,
                client=resumed_client,
                cache_root=root,
                retry_policy=RetryPolicy(
                    max_attempts=1,
                    initial_delay_seconds=0,
                    max_delay_seconds=0,
                ),
            )

            self.assertEqual(result["mode"], "full_pit")
            self.assertTrue(resumed_client.factor_calls)
            self.assertTrue(resumed_client.status_calls)

    def test_missing_tradable_factor_window_is_discarded_and_refetched(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        memberships = {date.strftime("%Y%m%d"): ["A", "C"] for date in signal_dates}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            incomplete_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
                empty_factor_calls={1},
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "tradable status rows are missing factor close coverage",
            ):
                run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: panel,
                    client=incomplete_client,
                    cache_root=root,
                    retry_policy=RetryPolicy(
                        max_attempts=1,
                        initial_delay_seconds=0,
                        max_delay_seconds=0,
                    ),
                )

            factor_fragments = list(
                root.glob("extra-panel/*/fragments/factor-close/**/*.json")
            )
            self.assertEqual(
                len(factor_fragments),
                len(incomplete_client.factor_calls) - 1,
            )

            resumed_client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
            )
            result = run_availability_audit(
                _spec(panel.adjusted_close.index),
                panel_loader=lambda _: panel,
                client=resumed_client,
                cache_root=root,
                retry_policy=RetryPolicy(
                    max_attempts=1,
                    initial_delay_seconds=0,
                    max_delay_seconds=0,
                ),
            )

            self.assertEqual(result["mode"], "full_pit")
            self.assertEqual(len(resumed_client.factor_calls), 1)
            self.assertEqual(resumed_client.status_calls, [])

    def test_non_tradable_sparse_factor_window_is_allowed(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        memberships = {date.strftime("%Y%m%d"): ["A", "C"] for date in signal_dates}
        first_window_dates = {
            date.strftime("%Y%m%d")
            for date in panel.adjusted_close.index
            if date <= pd.Timestamp("2026-01-07")
        }

        with tempfile.TemporaryDirectory() as directory:
            client = FakePITClient(
                memberships=memberships,
                base_dates=panel.adjusted_close.index,
                empty_factor_calls={1},
                non_tradable_status_dates=first_window_dates,
            )
            result = run_availability_audit(
                _spec(panel.adjusted_close.index),
                panel_loader=lambda _: panel,
                client=client,
                cache_root=Path(directory),
                retry_policy=RetryPolicy(
                    max_attempts=1,
                    initial_delay_seconds=0,
                    max_delay_seconds=0,
                ),
            )

            self.assertEqual(result["mode"], "full_pit")
            self.assertTrue(client.factor_calls)
            self.assertTrue(client.status_calls)

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
                clock=SequenceClock([0.0, 91.0]),
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
            self.assertTrue(any("90-second" in item for item in result["assumptions"]))
            self.assertEqual(result["futureConstituentCount"], 1)
            self.assertEqual(result["sampleSymbols"], ["B"])
            self.assertEqual(len(client.factor_calls), 1)
            self.assertEqual(client.factor_calls[0]["symbol"], ["C"])
            self.assertEqual(client.status_calls, [])

    def test_signal_day_untradability_is_not_an_execution_target_event(
        self,
    ) -> None:
        signal_date = pd.Timestamp("2026-01-30")
        execution_date = pd.Timestamp("2026-02-02")

        self.assertEqual(
            _untradable_target_count(
                [(signal_date, execution_date)],
                untradable_dates={signal_date},
            ),
            0,
        )

    def test_execution_day_untradability_counts_one_target_event(
        self,
    ) -> None:
        signal_date = pd.Timestamp("2026-01-30")
        execution_date = pd.Timestamp("2026-02-02")

        self.assertEqual(
            _untradable_target_count(
                [(signal_date, execution_date)],
                untradable_dates={execution_date},
            ),
            1,
        )

    def test_execution_target_events_accumulate_across_rebalances(
        self,
    ) -> None:
        first_execution = pd.Timestamp("2026-02-02")
        second_execution = pd.Timestamp("2026-03-02")
        pairs = [
            (pd.Timestamp("2026-01-30"), first_execution),
            (pd.Timestamp("2026-02-27"), second_execution),
        ]

        self.assertEqual(
            _untradable_target_count(
                pairs,
                untradable_dates={first_execution, second_execution},
            ),
            2,
        )

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
