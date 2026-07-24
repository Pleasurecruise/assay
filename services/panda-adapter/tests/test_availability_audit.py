from __future__ import annotations

import json
import os
import tempfile
import unittest
from hashlib import sha256
from http.client import IncompleteRead
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
from panda_adapter.audit_cache import (
    V9_CACHE_MANIFEST_SCHEMA_VERSION,
    V9_CACHE_VERSION,
)
from panda_adapter.availability_audit import (
    AVAILABILITY_SOURCE_REF,
    PIT_SNAPSHOT_SCHEMA_VERSION,
    AvailabilityBudgetExceeded,
    _count_untradable_targets,
    _snapshot_path,
    _write_json_atomic,
    run_availability_audit,
)
from panda_adapter.data_transport import RetryPolicy
from panda_adapter.engine.constants import AUDIT_TOOL_CONTRACT_VERSION
from panda_adapter.engine.protocol import run_request
from panda_adapter.market_panel import MarketPanel
from panda_adapter.source_normalization import symbols_from_weights


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


def _write_remove_only_manifest(
    root: Path,
    *,
    panel: MarketPanel,
    pit_root: Path,
) -> None:
    symbols = sorted(
        str(value).strip().upper() for value in panel.adjusted_close.columns
    )
    _write_json_atomic(
        root / "manifest.json",
        {
            "schemaVersion": V9_CACHE_MANIFEST_SCHEMA_VERSION,
            "cacheVersion": V9_CACHE_VERSION,
            "state": "degraded",
            "promoted": True,
            "window": {
                "start": panel.adjusted_close.index.min().strftime("%Y-%m-%d"),
                "end": panel.adjusted_close.index.max().strftime("%Y-%m-%d"),
            },
            "universe": {
                "indexSymbol": "000300.SH",
                "baseSymbols": len(symbols),
                "baseUniverseHash": sha256(
                    "\n".join(symbols).encode("utf-8")
                ).hexdigest()[:16],
            },
            "datasets": {
                "basePanel": {"status": "ready"},
                "pitTimeline": {
                    "status": "ready",
                    "path": (
                        f"{pit_root.name}/index-weights/"
                        "000300_SH"
                    ),
                },
                "historicalMembers": {
                    "status": "degraded",
                    "mode": "remove_only",
                    "path": None,
                    "columns": ["date", "symbol", "adjClose", "tradeStatus"],
                    "reasonCode": "HISTORICAL_MEMBER_DATA_UNAVAILABLE",
                    "rowCount": 0,
                    "tradingDates": 0,
                    "symbols": 0,
                    "quality": {
                        "primaryKeysValid": False,
                        "verified": False,
                    },
                    "assumptions": [
                        "Historical-member data is unavailable; use remove-only."
                    ],
                },
            },
        },
    )


def _write_full_pit_manifest(
    root: Path,
    *,
    panel: MarketPanel,
    pit_root: Path,
) -> None:
    _write_remove_only_manifest(
        root,
        panel=panel,
        pit_root=pit_root,
    )
    dataset = root / "materialized" / "historical-members.csv"
    dataset.parent.mkdir(parents=True)
    pd.DataFrame(
        columns=["date", "symbol", "adjClose", "tradeStatus"]
    ).to_csv(dataset, index=False)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["state"] = "ready"
    manifest["datasets"]["historicalMembers"] = {
        "status": "ready",
        "mode": "full_pit",
        "path": "materialized/historical-members.csv",
        "columns": ["date", "symbol", "adjClose", "tradeStatus"],
    }
    _write_json_atomic(manifest_path, manifest)


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
                    "contractVersion",
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
            self.assertEqual(
                first["contractVersion"],
                AUDIT_TOOL_CONTRACT_VERSION,
            )
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

    def test_promoted_remove_only_policy_skips_redundant_live_acquisition(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        client_initializations = 0

        def fail_client_factory() -> object:
            nonlocal client_initializations
            client_initializations += 1
            raise AssertionError("remove-only policy must not initialize the client")

        with tempfile.TemporaryDirectory() as directory:
            common_root = Path(directory)
            pit_root = common_root / "pit-availability-v1"
            v9_root = common_root / "v9-p1-v1"
            for date in signal_dates:
                _write_json_atomic(
                    _snapshot_path(pit_root, "000300.SH", date),
                    {
                        "schemaVersion": PIT_SNAPSHOT_SCHEMA_VERSION,
                        "indexSymbol": "000300.SH",
                        "requestedDate": date.strftime("%Y-%m-%d"),
                        "effectiveDate": date.strftime("%Y-%m-%d"),
                        "symbols": ["A", "C"],
                    },
                )
            _write_remove_only_manifest(
                v9_root,
                panel=panel,
                pit_root=pit_root,
            )

            with patch.dict(
                os.environ,
                {"ASSAY_V9_CACHE_ROOT": str(v9_root)},
            ):
                result = run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: panel,
                    client_factory=fail_client_factory,
                    cache_root=pit_root,
                    retry_policy=RetryPolicy(
                        max_attempts=1,
                        initial_delay_seconds=0,
                        max_delay_seconds=0,
                    ),
                )

            self.assertEqual(result["mode"], "degraded_remove_only")
            self.assertEqual(client_initializations, 0)
            self.assertFalse((pit_root / "extra-panel").exists())
            self.assertEqual(result["futureConstituentCount"], 1)
            self.assertEqual(result["sampleSymbols"], ["B"])
            self.assertTrue(np.isfinite(result["corrected"]["delta"]))
            self.assertEqual(result["sourceRef"], AVAILABILITY_SOURCE_REF)
            self.assertTrue(
                any(
                    V9_CACHE_VERSION in item
                    and "HISTORICAL_MEMBER_DATA_UNAVAILABLE" in item
                    and "no live historical-member acquisition" in item
                    for item in result["assumptions"]
                )
            )
            self.assertFalse(
                any("90-second" in item for item in result["assumptions"])
            )

    def test_configured_v9_cache_fails_closed_on_missing_pit_snapshot(
        self,
    ) -> None:
        panel = _base_panel()
        client_initializations = 0

        def fail_client_factory() -> object:
            nonlocal client_initializations
            client_initializations += 1
            raise AssertionError("cache-only mode must not initialize the client")

        with tempfile.TemporaryDirectory() as directory:
            common_root = Path(directory)
            pit_root = common_root / "pit-availability-v1"
            v9_root = common_root / "v9-p1-v1"
            _write_remove_only_manifest(
                v9_root,
                panel=panel,
                pit_root=pit_root,
            )

            with (
                patch.dict(
                    os.environ,
                    {"ASSAY_V9_CACHE_ROOT": str(v9_root)},
                ),
                self.assertRaisesRegex(
                    RuntimeError,
                    "missing a required PIT snapshot",
                ),
            ):
                run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: panel,
                    client_factory=fail_client_factory,
                    cache_root=pit_root,
                )

            self.assertEqual(client_initializations, 0)
            self.assertFalse((pit_root / "index-weights").exists())

    def test_configured_v9_cache_fails_closed_on_missing_extra_fragment(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        client_initializations = 0

        def fail_client_factory() -> object:
            nonlocal client_initializations
            client_initializations += 1
            raise AssertionError("cache-only mode must not initialize the client")

        with tempfile.TemporaryDirectory() as directory:
            common_root = Path(directory)
            pit_root = common_root / "pit-availability-v1"
            v9_root = common_root / "v9-p1-v1"
            for date in signal_dates:
                _write_json_atomic(
                    _snapshot_path(pit_root, "000300.SH", date),
                    {
                        "schemaVersion": PIT_SNAPSHOT_SCHEMA_VERSION,
                        "indexSymbol": "000300.SH",
                        "requestedDate": date.strftime("%Y-%m-%d"),
                        "effectiveDate": date.strftime("%Y-%m-%d"),
                        "symbols": ["A", "C"],
                    },
                )
            _write_full_pit_manifest(
                v9_root,
                panel=panel,
                pit_root=pit_root,
            )

            with (
                patch.dict(
                    os.environ,
                    {"ASSAY_V9_CACHE_ROOT": str(v9_root)},
                ),
                self.assertRaisesRegex(
                    RuntimeError,
                    "missing a required PIT extra-panel fragment",
                ),
            ):
                run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: panel,
                    client_factory=fail_client_factory,
                    cache_root=pit_root,
                )

            self.assertEqual(client_initializations, 0)
            self.assertFalse((pit_root / "extra-panel").exists())

    def test_configured_remove_only_policy_fails_closed_on_panel_mismatch(
        self,
    ) -> None:
        panel = _base_panel()
        signal_dates = _rebalance_dates(panel)
        client_initializations = 0

        def fail_client_factory() -> object:
            nonlocal client_initializations
            client_initializations += 1
            raise AssertionError("invalid policy must not initialize the client")

        with tempfile.TemporaryDirectory() as directory:
            common_root = Path(directory)
            pit_root = common_root / "pit-availability-v1"
            v9_root = common_root / "v9-p1-v1"
            for date in signal_dates:
                _write_json_atomic(
                    _snapshot_path(pit_root, "000300.SH", date),
                    {
                        "schemaVersion": PIT_SNAPSHOT_SCHEMA_VERSION,
                        "indexSymbol": "000300.SH",
                        "requestedDate": date.strftime("%Y-%m-%d"),
                        "effectiveDate": date.strftime("%Y-%m-%d"),
                        "symbols": ["A", "C"],
                    },
                )
            _write_remove_only_manifest(
                v9_root,
                panel=panel,
                pit_root=pit_root,
            )
            mismatched_panel = MarketPanel(
                adjusted_close=panel.adjusted_close.rename(columns={"B": "D"}),
                tradable=panel.tradable.rename(columns={"B": "D"}),
            )

            with (
                patch.dict(
                    os.environ,
                    {"ASSAY_V9_CACHE_ROOT": str(v9_root)},
                ),
                self.assertRaisesRegex(
                    RuntimeError,
                    "universe does not match",
                ),
            ):
                run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: mismatched_panel,
                    client_factory=fail_client_factory,
                    cache_root=pit_root,
                )

            self.assertEqual(client_initializations, 0)

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

    def test_membership_correction_matches_hand_calculated_returns(
        self,
    ) -> None:
        dates = pd.DatetimeIndex(
            [
                "2026-01-28",
                "2026-01-29",
                "2026-01-30",
                "2026-02-02",
                "2026-02-03",
            ]
        )
        prices = pd.DataFrame(
            {
                "A": [99.0, 100.0, 101.0, 100.0, 90.0],
                "F": [99.0, 100.0, 102.0, 100.0, 110.0],
            },
            index=dates,
        )
        panel = MarketPanel(
            adjusted_close=prices,
            tradable=pd.DataFrame(True, index=dates, columns=prices.columns),
        )
        spec = _spec(dates)
        spec["signal"]["params"]["window"] = 1  # type: ignore[index]
        spec["costs"] = {"model": "none"}
        signal_date = pd.Timestamp("2026-01-30")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_json_atomic(
                _snapshot_path(root, "000300.SH", signal_date),
                {
                    "schemaVersion": PIT_SNAPSHOT_SCHEMA_VERSION,
                    "indexSymbol": "000300.SH",
                    "requestedDate": "2026-01-30",
                    "effectiveDate": "2026-01-30",
                    "symbols": ["A"],
                },
            )
            result = run_availability_audit(
                spec,
                panel_loader=lambda _: panel,
                client_factory=lambda: self.fail("no live client is needed"),
                cache_root=root,
            )

        corrected_annual_return = 0.9 ** 63 - 1.0
        baseline_annual_return = 1.1 ** 63 - 1.0
        self.assertEqual(result["futureConstituentCount"], 1)
        self.assertEqual(result["affectedRebalances"], ["2026-01-30"])
        self.assertEqual(result["sampleSymbols"], ["F"])
        self.assertEqual(result["contaminatedSelectionRate"], 1.0)
        self.assertAlmostEqual(
            result["corrected"]["annualReturn"],
            corrected_annual_return,
        )
        self.assertAlmostEqual(
            result["corrected"]["sharpe"],
            -(252 / 5) ** 0.5,
        )
        self.assertAlmostEqual(
            result["corrected"]["delta"],
            corrected_annual_return - baseline_annual_return,
        )

    def test_missing_pit_timeline_is_not_degraded_to_as_of(
        self,
    ) -> None:
        panel = _base_panel()

        class FailingWeightsClient:
            @staticmethod
            def get_index_weights(**_: object) -> object:
                raise IncompleteRead(b"", 10)

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(
                AvailabilityBudgetExceeded,
                "timeline acquisition is incomplete",
            ):
                run_availability_audit(
                    _spec(panel.adjusted_close.index),
                    panel_loader=lambda _: panel,
                    client=FailingWeightsClient(),
                    cache_root=Path(directory),
                    clock=SequenceClock([0.0, 91.0]),
                    sleeper=lambda _: None,
                    retry_policy=RetryPolicy(
                        max_attempts=1,
                        initial_delay_seconds=0,
                        max_delay_seconds=0,
                    ),
                )

    def test_undated_index_weights_cannot_be_relabeled_as_pit(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            "missing an effective snapshot date",
        ):
            symbols_from_weights(
                [{"stock_symbol": "000001.SZ"}],
                requested_date=pd.Timestamp("2026-01-30"),
            )

    def test_protocol_dispatches_once_without_loading_a_panel(self) -> None:
        panel = _base_panel()
        calls: list[dict[str, object]] = []
        response = {
            "contractVersion": AUDIT_TOOL_CONTRACT_VERSION,
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
