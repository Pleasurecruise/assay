from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "prepare_v9_p1_cache.py"
SPEC = importlib.util.spec_from_file_location(
    "prepare_v9_p1_cache_test_subject",
    SCRIPT_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load P1 cache script: {SCRIPT_PATH}")
p1 = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p1
SPEC.loader.exec_module(p1)


def _symbols(count: int = 300) -> list[str]:
    return [f"S{index:05d}" for index in range(count)]


def _price(
    date: pd.Timestamp,
    symbol: str,
    *,
    symbol_positions: dict[str, int],
) -> float:
    return float(
        100
        + symbol_positions[symbol]
        + (pd.Timestamp(date) - pd.Timestamp("2020-01-01")).days / 10_000
    )


def _seed_base_cache(
    *,
    cache_root: Path,
    dates: pd.DatetimeIndex,
    symbols: list[str],
    truncate_date: pd.Timestamp | None = None,
    factor_start_date: pd.Timestamp | None = None,
    missing_factor_keys: set[tuple[str, str]] | None = None,
) -> Path:
    output = cache_root / "csi300-3y.csv"
    positions = {symbol: index for index, symbol in enumerate(symbols)}
    status_rows = [
        {
            "date": date.strftime("%Y-%m-%d"),
            "symbol": symbol,
            "tradeStatus": 0,
        }
        for date in dates
        for symbol in symbols
    ]
    status = pd.DataFrame(status_rows)
    missing_keys = missing_factor_keys or set()
    factor_rows = [
        {
            "date": date.strftime("%Y-%m-%d"),
            "symbol": symbol,
            "adjClose": _price(
                date,
                symbol,
                symbol_positions=positions,
            ),
        }
        for date in dates
        for symbol in symbols
        if (
            (truncate_date is None or date != truncate_date or positions[symbol] < 189)
            and (
                date.strftime("%Y-%m-%d"),
                symbol,
            )
            not in missing_keys
        )
    ]
    factor = pd.DataFrame(factor_rows)

    for date in dates:
        request = p1._base_request(
            source="trade-status",
            start_date=pd.Timestamp(date),
            end_date=pd.Timestamp(date),
            symbols=symbols,
        )
        scoped = status.loc[status["date"] == date.strftime("%Y-%m-%d")]
        p1.BASE_BUILDER._write_fragment(output, request, scoped)

    for start_date, end_date in p1.BASE_BUILDER._factor_windows(
        factor_start_date if factor_start_date is not None else dates[0],
        dates[-1],
    ):
        request = p1._base_request(
            source="factor-close",
            start_date=start_date,
            end_date=end_date,
            symbols=symbols,
        )
        scoped = factor.loc[
            factor["date"].between(
                start_date.strftime("%Y-%m-%d"),
                end_date.strftime("%Y-%m-%d"),
            )
        ]
        p1.BASE_BUILDER._write_fragment(output, request, scoped)

    merged = factor.merge(
        status,
        on=["date", "symbol"],
        how="left",
        validate="one_to_one",
    )
    merged[list(p1.HISTORICAL_COLUMNS)].to_csv(output, index=False)
    return output


class FakeP1Client:
    def __init__(
        self,
        *,
        base_dates: pd.DatetimeIndex,
        base_symbols: list[str],
        extra_symbol: str = "XTRA",
        absent_factor_keys: set[tuple[str, str]] | None = None,
    ) -> None:
        self.base_dates = pd.DatetimeIndex(base_dates)
        self.base_symbols = list(base_symbols)
        self.extra_symbol = extra_symbol
        self.absent_factor_keys = absent_factor_keys or set()
        self.positions = {
            symbol: index for index, symbol in enumerate([*base_symbols, extra_symbol])
        }
        self.factor_calls: list[dict[str, object]] = []
        self.status_calls: list[dict[str, object]] = []
        self.index_weight_calls: list[dict[str, object]] = []
        self.index_daily_calls: list[dict[str, object]] = []
        self.calendar_calls: list[dict[str, object]] = []

    def query(
        self,
        operation: str,
        parameters: dict[str, object],
    ) -> pd.DataFrame:
        if operation != "trade_calendar":
            raise AssertionError(f"unexpected operation {operation}")
        self.calendar_calls.append(parameters)
        start = pd.Timestamp(str(parameters["start_date"]))
        end = pd.Timestamp(str(parameters["end_date"]))
        return pd.DataFrame(
            {
                "date": pd.bdate_range(start, end).strftime("%Y%m%d"),
                "is_trading_day": 1,
            }
        )

    def get_index_weights(self, **parameters: object) -> pd.DataFrame:
        self.index_weight_calls.append(parameters)
        requested = pd.Timestamp(str(parameters["end_date"]))
        members = [*self.base_symbols[:-1], self.extra_symbol]
        return pd.DataFrame(
            {
                "date": requested.strftime("%Y%m%d"),
                "stock_symbol": members,
                "weight": 1.0,
            }
        )

    def get_factor(self, **parameters: object) -> pd.DataFrame:
        self.factor_calls.append(parameters)
        symbols = [str(value) for value in parameters["symbol"]]
        start = pd.Timestamp(str(parameters["start_date"]))
        end = pd.Timestamp(str(parameters["end_date"]))
        dates = self.base_dates[(self.base_dates >= start) & (self.base_dates <= end)]
        factors = [str(value) for value in parameters["factors"]]
        if factors == ["close"]:
            return pd.DataFrame(
                [
                    {
                        "date": date.strftime("%Y%m%d"),
                        "symbol": symbol,
                        "close": _price(
                            date,
                            symbol,
                            symbol_positions=self.positions,
                        ),
                    }
                    for date in dates
                    for symbol in symbols
                    if (
                        date.strftime("%Y-%m-%d"),
                        symbol,
                    )
                    not in self.absent_factor_keys
                ]
            )
        if factors != list(p1.COMPARATOR_FACTORS):
            raise AssertionError(f"unexpected factors {factors}")
        return pd.DataFrame(
            [
                {
                    "date": date.strftime("%Y%m%d"),
                    "symbol": symbol,
                    "ratio_pe_ttm": 10.0 + self.positions[symbol],
                    "market_cap": 1_000.0 + self.positions[symbol],
                }
                for date in dates
                for symbol in symbols
            ]
        )

    def get_market_data(self, **parameters: object) -> pd.DataFrame:
        self.status_calls.append(parameters)
        symbols = [str(value) for value in parameters["symbol"]]
        date = pd.Timestamp(str(parameters["start_date"]))
        return pd.DataFrame(
            [
                {
                    "date": date.strftime("%Y%m%d"),
                    "symbol": symbol,
                    "trade_status": 0,
                }
                for symbol in symbols
            ]
        )

    def get_index_daily(self, **parameters: object) -> pd.DataFrame:
        self.index_daily_calls.append(parameters)
        start = pd.Timestamp(str(parameters["start_date"]))
        end = pd.Timestamp(str(parameters["end_date"]))
        return pd.DataFrame(
            [
                {
                    "date": date.strftime("%Y%m%d"),
                    "symbol": p1.INDEX_SYMBOL,
                    "close": 4_000.0 + (date - pd.Timestamp("2020-01-01")).days / 100,
                }
                for date in pd.bdate_range(start, end)
            ]
        )


class NoNetworkClient:
    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"network method must not run: {name}")


class PrepareV9P1CacheTest(unittest.TestCase):
    def test_distinguishes_terminal_as_of_from_completed_month_ends(self) -> None:
        dates = pd.DatetimeIndex(
            [
                "2026-01-30",
                "2026-02-27",
                "2026-03-13",
            ]
        )

        points = p1._derive_pit_points(dates, expected_count=3)

        self.assertEqual(
            [(point.date.strftime("%Y-%m-%d"), point.kind) for point in points],
            [
                ("2026-01-30", "completed_month_end"),
                ("2026-02-27", "completed_month_end"),
                ("2026-03-13", "terminal_as_of"),
            ],
        )
        self.assertEqual(
            p1._derive_pit_points(
                [pd.Timestamp("2026-01-30")],
                expected_count=1,
            )[0].kind,
            "completed_month_end",
        )

    def test_repairs_only_the_incomplete_189_of_300_factor_window(self) -> None:
        symbols = _symbols()
        dates = pd.bdate_range("2026-04-13", "2026-04-24")
        truncated = pd.Timestamp("2026-04-15")

        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory)
            output = _seed_base_cache(
                cache_root=cache_root,
                dates=dates,
                symbols=symbols,
                truncate_date=truncated,
            )
            second_window = p1._base_request(
                source="factor-close",
                start_date=pd.Timestamp("2026-04-20"),
                end_date=pd.Timestamp("2026-04-24"),
                symbols=symbols,
            )
            second_path = p1.BASE_BUILDER._fragment_path(
                output,
                second_window,
            )
            second_before = second_path.read_bytes()
            client = FakeP1Client(
                base_dates=dates,
                base_symbols=symbols,
            )
            config = p1.P1Config(
                cache_root=cache_root,
                base_cache=output,
                perform_spot_checks=False,
            )

            repaired, result = p1._prepare_base_cache(
                config=config,
                client=client,
                budget=p1.StageBudget(
                    stage="base",
                    max_seconds=1_200,
                    sleeper=lambda _: None,
                ),
            )

            day = repaired.loc[repaired["date"] == truncated.strftime("%Y-%m-%d")]
            self.assertEqual(day["symbol"].nunique(), 300)
            self.assertEqual(
                result["quality"]["effectiveTradableFactorCoverage"],
                True,
            )
            self.assertTrue(result["quality"]["providerTradableFactorCoverage"])
            self.assertEqual(
                result["repairedFragments"],
                ["2026-04-13/2026-04-19"],
            )
            self.assertEqual(len(client.factor_calls), 1)
            self.assertEqual(
                client.factor_calls[0]["start_date"],
                "20260413",
            )
            self.assertEqual(
                client.factor_calls[0]["end_date"],
                "20260419",
            )
            self.assertEqual(second_path.read_bytes(), second_before)

    def test_reuses_fragments_when_request_start_precedes_first_trading_day(
        self,
    ) -> None:
        symbols = _symbols()
        dates = pd.bdate_range("2026-04-13", "2026-05-01")
        request_start = pd.Timestamp("2026-04-12")
        truncated = pd.Timestamp("2026-04-15")

        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory)
            output = _seed_base_cache(
                cache_root=cache_root,
                dates=dates,
                symbols=symbols,
                truncate_date=truncated,
                factor_start_date=request_start,
            )
            retained_request = p1._base_request(
                source="factor-close",
                start_date=pd.Timestamp("2026-04-19"),
                end_date=pd.Timestamp("2026-04-25"),
                symbols=symbols,
            )
            retained_path = p1.BASE_BUILDER._fragment_path(
                output,
                retained_request,
            )
            retained_before = retained_path.read_bytes()
            drifted_request = p1._base_request(
                source="factor-close",
                start_date=dates[0],
                end_date=dates[0] + pd.Timedelta(days=6),
                symbols=symbols,
            )
            drifted_path = p1.BASE_BUILDER._fragment_path(
                output,
                drifted_request,
            )
            client = FakeP1Client(
                base_dates=dates,
                base_symbols=symbols,
            )

            repaired, result = p1._prepare_base_cache(
                config=p1.P1Config(
                    cache_root=cache_root,
                    base_cache=output,
                    perform_spot_checks=False,
                ),
                client=client,
                budget=p1.StageBudget(
                    stage="base",
                    max_seconds=1_200,
                    sleeper=lambda _: None,
                ),
            )

            repaired_day = repaired.loc[
                repaired["date"] == truncated.strftime("%Y-%m-%d")
            ]
            self.assertEqual(repaired_day["symbol"].nunique(), 300)
            self.assertEqual(len(client.factor_calls), 1)
            self.assertEqual(
                client.factor_calls[0]["start_date"],
                "20260412",
            )
            self.assertEqual(
                client.factor_calls[0]["end_date"],
                "20260418",
            )
            self.assertEqual(
                result["repairedFragments"],
                ["2026-04-12/2026-04-18"],
            )
            self.assertEqual(
                result["factorWindowAnchor"],
                "2026-04-12",
            )
            self.assertEqual(
                result["factorWindowAnchorSource"],
                "identity_bound_parent_fragments",
            )
            self.assertEqual(retained_path.read_bytes(), retained_before)
            self.assertFalse(drifted_path.exists())

    def test_verified_single_key_source_absence_is_persisted_and_counted(
        self,
    ) -> None:
        symbols = _symbols()
        dates = pd.bdate_range("2026-04-14", "2026-04-16")
        absent_key = ("2026-04-15", symbols[0])

        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory)
            output = _seed_base_cache(
                cache_root=cache_root,
                dates=dates,
                symbols=symbols,
                missing_factor_keys={absent_key},
            )
            config = p1.P1Config(
                cache_root=cache_root,
                base_cache=output,
                perform_spot_checks=False,
            )
            repaired, result = p1._prepare_base_cache(
                config=config,
                client=FakeP1Client(
                    base_dates=dates,
                    base_symbols=symbols,
                    absent_factor_keys={absent_key},
                ),
                budget=p1.StageBudget(
                    stage="base",
                    max_seconds=1_200,
                    sleeper=lambda _: None,
                ),
            )

            self.assertFalse(
                (
                    repaired["date"].eq(absent_key[0])
                    & repaired["symbol"].eq(absent_key[1])
                ).any()
            )
            self.assertEqual(
                result["verifiedSourceAbsenceCount"],
                1,
            )
            self.assertEqual(
                result["quality"]["verifiedSourceAbsenceCount"],
                1,
            )
            self.assertEqual(
                result["quality"]["unverifiedTradableMissingKeys"],
                0,
            )
            self.assertTrue(result["quality"]["effectiveTradableFactorCoverage"])
            self.assertFalse(result["quality"]["providerTradableFactorCoverage"])
            self.assertEqual(
                result["effectiveTradabilityRule"],
                "price_available_and_trade_status",
            )
            self.assertEqual(len(result["assumptions"]), 1)
            self.assertIn("1 identity-bound", result["assumptions"][0])

            leaf = p1.BASE_BUILDER.FragmentRequest(
                source="factor-close",
                start_date=pd.Timestamp(absent_key[0]),
                end_date=pd.Timestamp(absent_key[0]),
                symbols=(absent_key[1],),
                universe_hash=p1.BASE_BUILDER._universe_hash(symbols),
                universe_size=len(symbols),
            )
            leaf_frame = p1.BASE_BUILDER._read_fragment(output, leaf)
            self.assertTrue(leaf_frame.empty)
            self.assertEqual(
                p1._read_base_verified_source_absence(
                    output=output,
                    request=leaf,
                    frame=leaf_frame,
                ),
                absent_key,
            )

            resumed, resumed_result = p1._prepare_base_cache(
                config=config,
                client=NoNetworkClient(),
                budget=p1.StageBudget(
                    stage="base",
                    max_seconds=1_200,
                    sleeper=lambda _: None,
                ),
            )
            self.assertEqual(len(resumed), len(repaired))
            self.assertEqual(
                resumed_result["verifiedSourceAbsenceCount"],
                1,
            )

    def test_empty_factor_fragment_without_leaf_proof_remains_fail_closed(
        self,
    ) -> None:
        date = pd.Timestamp("2026-04-15")
        symbol = "S00000"
        request = p1._base_request(
            source="factor-close",
            start_date=date,
            end_date=date,
            symbols=[symbol],
        )
        status = pd.DataFrame(
            [
                {
                    "date": "2026-04-15",
                    "symbol": symbol,
                    "tradeStatus": 0,
                }
            ]
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "panel.csv"
            p1.BASE_BUILDER._write_fragment(
                output,
                request,
                pd.DataFrame(columns=["date", "symbol", "adjClose"]),
            )
            verified: set[tuple[str, str]] = set()

            with self.assertRaisesRegex(
                AssertionError,
                "network method must not run",
            ):
                p1._repair_base_factor_fragment(
                    output=output,
                    request=request,
                    status=status,
                    client=NoNetworkClient(),
                    budget=p1.StageBudget(
                        stage="base",
                        max_seconds=10,
                        sleeper=lambda _: None,
                    ),
                    repaired=[],
                    verified_source_absences=verified,
                )

            self.assertEqual(verified, set())
            self.assertFalse(
                p1._base_verified_source_absence_path(
                    output,
                    request,
                ).exists()
            )

    def test_non_single_key_empty_response_splits_and_is_not_a_proof(
        self,
    ) -> None:
        date = pd.Timestamp("2026-04-15")
        symbols = ["S00000", "S00001"]
        request = p1._base_request(
            source="factor-close",
            start_date=date,
            end_date=date,
            symbols=symbols,
        )
        status = pd.DataFrame(
            [
                {
                    "date": "2026-04-15",
                    "symbol": symbol,
                    "tradeStatus": 0,
                }
                for symbol in symbols
            ]
        )

        class EmptyParentOnly:
            def __init__(self) -> None:
                self.calls = 0

            def get_factor(self, **_: object) -> pd.DataFrame:
                self.calls += 1
                if self.calls == 1:
                    return pd.DataFrame()
                raise ValueError("child verification required")

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "panel.csv"
            client = EmptyParentOnly()
            verified: set[tuple[str, str]] = set()

            with self.assertRaisesRegex(
                ValueError,
                "child verification required",
            ):
                p1._repair_base_factor_fragment(
                    output=output,
                    request=request,
                    status=status,
                    client=client,
                    budget=p1.StageBudget(
                        stage="base",
                        max_seconds=10,
                        sleeper=lambda _: None,
                    ),
                    repaired=[],
                    verified_source_absences=verified,
                )

            self.assertGreater(client.calls, 1)
            self.assertEqual(verified, set())
            self.assertFalse(
                p1._base_verified_source_absence_path(
                    output,
                    request,
                ).exists()
            )

    def test_fragment_split_resumes_only_the_interrupted_child(self) -> None:
        symbols = ("A", "B", "C", "D")
        request = p1.CacheRequest(
            source="comparator-factors",
            start_date=pd.Timestamp("2026-01-02"),
            end_date=pd.Timestamp("2026-01-02"),
            symbols=symbols,
            fields=p1.COMPARATOR_FACTORS,
        )
        expected = {("2026-01-02", symbol) for symbol in symbols}
        calls: list[tuple[str, ...]] = []
        interrupted = True

        def download(value: p1.CacheRequest) -> pd.DataFrame:
            nonlocal interrupted
            calls.append(value.symbols)
            if value.symbols == symbols:
                requested = value.symbols[:2]
            elif value.symbols == ("C", "D") and interrupted:
                interrupted = False
                raise RuntimeError("simulated process interruption")
            else:
                requested = value.symbols
            return pd.DataFrame(
                [
                    {
                        "date": "20260102",
                        "symbol": symbol,
                        "ratio_pe_ttm": 10,
                        "market_cap": 100,
                    }
                    for symbol in requested
                ]
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(
                RuntimeError,
                "simulated process interruption",
            ):
                p1._materialize_fragment(
                    root=root,
                    request=request,
                    expected_keys=expected,
                    budget=p1.StageBudget(
                        stage="factors",
                        max_seconds=1_200,
                        sleeper=lambda _: None,
                    ),
                    downloader=download,
                    stats=p1.FragmentStats(),
                )

            stats = p1.FragmentStats()
            result = p1._materialize_fragment(
                root=root,
                request=request,
                expected_keys=expected,
                budget=p1.StageBudget(
                    stage="factors",
                    max_seconds=1_200,
                    sleeper=lambda _: None,
                ),
                downloader=download,
                stats=stats,
            )

        self.assertEqual(p1._frame_keys(result), expected)
        self.assertEqual(
            calls,
            [
                ("A", "B", "C", "D"),
                ("A", "B"),
                ("C", "D"),
                ("C", "D"),
            ],
        )
        self.assertEqual(stats.reused, 1)

    def test_comparator_cache_covers_the_full_date_universe_product(self) -> None:
        symbols = _symbols()
        dates = pd.DatetimeIndex(["2026-01-02", "2026-01-05"])
        base = pd.DataFrame(
            [
                {
                    "date": date,
                    "symbol": symbol,
                    "adjClose": 100.0,
                    "tradeStatus": 0,
                }
                for date in dates
                for symbol in symbols
                if not (date == dates[0] and symbol == symbols[0])
            ]
        )

        with tempfile.TemporaryDirectory() as directory:
            result = p1._prepare_comparator_factors(
                config=p1.P1Config(
                    cache_root=Path(directory),
                    base_cache=Path(directory) / "csi300-3y.csv",
                    perform_spot_checks=False,
                ),
                client=FakeP1Client(
                    base_dates=dates,
                    base_symbols=symbols,
                ),
                base=base,
                budget=p1.StageBudget(
                    stage="factors",
                    max_seconds=1_200,
                    sleeper=lambda _: None,
                ),
            )

        self.assertEqual(result["rowCount"], len(dates) * len(symbols))
        self.assertEqual(result["tradingDates"], len(dates))
        self.assertEqual(result["symbols"], len(symbols))
        self.assertEqual(result["duplicatePrimaryKeys"], 0)

    def test_full_offline_fixture_promotes_manifest_and_resumes(self) -> None:
        symbols = _symbols()
        dates = pd.bdate_range("2026-01-02", "2026-03-13")

        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory)
            output = _seed_base_cache(
                cache_root=cache_root,
                dates=dates,
                symbols=symbols,
            )
            config = p1.P1Config(
                cache_root=cache_root,
                base_cache=output,
                expected_pit_points=3,
            )
            client = FakeP1Client(
                base_dates=dates,
                base_symbols=symbols,
            )

            first = p1.prepare_v9_p1_cache(
                config=config,
                client=client,
                sleeper=lambda _: None,
            )

            self.assertEqual(first["state"], "ready")
            self.assertTrue(first["promoted"])
            self.assertEqual(
                first["datasets"]["pitTimeline"]["completedMonthEnds"],
                2,
            )
            self.assertEqual(
                first["datasets"]["pitTimeline"]["terminalAsOf"],
                ["2026-03-13"],
            )
            self.assertEqual(
                first["datasets"]["historicalMembers"]["expectedSymbols"],
                1,
            )
            self.assertEqual(
                first["datasets"]["indexDaily"]["lookbackTradingDays"],
                200,
            )
            manifest_path = cache_root / "v9-p1-v1" / "manifest.json"
            self.assertTrue(manifest_path.is_file())
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["cacheVersion"], p1.CACHE_VERSION)
            index_path = cache_root / manifest["datasets"]["indexDaily"]["path"]
            factor_path = cache_root / manifest["datasets"]["comparatorFactors"]["path"]
            self.assertEqual(
                list(pd.read_csv(index_path).columns),
                list(p1.INDEX_COLUMNS),
            )
            self.assertEqual(
                list(pd.read_csv(factor_path).columns),
                list(p1.COMPARATOR_COLUMNS),
            )

            resumed = p1.prepare_v9_p1_cache(
                config=p1.P1Config(
                    cache_root=cache_root,
                    base_cache=output,
                    expected_pit_points=3,
                    perform_spot_checks=False,
                ),
                client=NoNetworkClient(),
                sleeper=lambda _: None,
            )

            self.assertEqual(resumed["state"], "ready")
            self.assertEqual(
                resumed["datasets"]["pitTimeline"]["downloaded"],
                0,
            )
            self.assertGreater(
                resumed["datasets"]["indexDaily"]["fragmentStats"]["reused"],
                0,
            )
            self.assertGreater(
                resumed["datasets"]["comparatorFactors"]["fragmentStats"]["reused"],
                0,
            )

    def test_pit_hard_failure_is_sanitized_and_not_promoted(self) -> None:
        base = pd.DataFrame(
            [
                {
                    "date": pd.Timestamp("2026-01-02"),
                    "symbol": symbol,
                    "adjClose": 100.0,
                    "tradeStatus": 0,
                }
                for symbol in _symbols()
            ]
        )
        base_result = {
            "status": "ready",
            "path": "csi300-3y.csv",
            "columns": list(p1.HISTORICAL_COLUMNS),
        }
        ready_index = {
            "status": "ready",
            "path": "v9-p1-v1/materialized/index-daily.csv",
            "columns": list(p1.INDEX_COLUMNS),
        }
        ready_factors = {
            "status": "ready",
            "path": "v9-p1-v1/materialized/comparator-factors.csv",
            "columns": list(p1.COMPARATOR_COLUMNS),
        }

        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory)
            config = p1.P1Config(
                cache_root=cache_root,
                base_cache=cache_root / "csi300-3y.csv",
            )
            with (
                patch.object(
                    p1,
                    "_prepare_base_cache",
                    return_value=(base, base_result),
                ),
                patch.object(
                    p1,
                    "_prepare_pit_timeline",
                    side_effect=RuntimeError("RAW_PROVIDER_DETAIL_DO_NOT_PERSIST"),
                ),
                patch.object(
                    p1,
                    "_prepare_index_daily",
                    return_value=(pd.DatetimeIndex([]), ready_index),
                ),
                patch.object(
                    p1,
                    "_prepare_comparator_factors",
                    return_value=ready_factors,
                ),
            ):
                result = p1.prepare_v9_p1_cache(
                    config=config,
                    client=object(),
                )

            rendered = json.dumps(result)
            self.assertEqual(result["state"], "blocked")
            self.assertFalse(result["promoted"])
            self.assertNotIn("RAW_PROVIDER_DETAIL_DO_NOT_PERSIST", rendered)
            self.assertFalse((config.version_root / "manifest.json").exists())
            self.assertTrue((config.version_root / "last-run.json").is_file())
            self.assertEqual(
                result["datasets"]["historicalMembers"]["mode"],
                "remove_only",
            )

    def test_stage_budget_enforces_the_20_minute_ceiling(self) -> None:
        values = iter([1_200.0])
        budget = p1.StageBudget(
            stage="index-daily",
            max_seconds=1_200,
            clock=lambda: next(values),
            sleeper=lambda _: None,
            started_at=0.0,
        )

        with self.assertRaises(p1.StageDeadlineExceeded):
            budget.ensure_available()

    def test_stage_budget_recovers_after_multiple_transport_exhaustions(
        self,
    ) -> None:
        for mode in ("call", "call_pretried_until_deadline"):
            with self.subTest(mode=mode):
                attempts = 0
                delays: list[float] = []
                budget = p1.StageBudget(
                    stage="base",
                    max_seconds=10,
                    clock=lambda: 0.0,
                    sleeper=delays.append,
                    retry_policy=p1.RetryPolicy(
                        max_attempts=1,
                        initial_delay_seconds=0.1,
                        max_delay_seconds=0.2,
                    ),
                    started_at=0.0,
                )

                def operation() -> str:
                    nonlocal attempts
                    attempts += 1
                    if attempts < 3:
                        if mode == "call":
                            raise ConnectionResetError("fixture transport")
                        raise p1.DataTransportError("fixture exhaustion")
                    return "ok"

                result = (
                    budget.call("fixture", operation)
                    if mode == "call"
                    else budget.call_pretried_until_deadline(operation)
                )

                self.assertEqual(result, "ok")
                self.assertEqual(attempts, 3)
                self.assertEqual(delays, [0.1, 0.2])

    def test_stage_budget_transport_retry_stops_at_hard_deadline(self) -> None:
        for mode in ("call", "call_pretried_until_deadline"):
            with self.subTest(mode=mode):
                attempts = 0
                delays: list[float] = []
                budget = p1.StageBudget(
                    stage="base",
                    max_seconds=0.25,
                    clock=lambda: 0.0,
                    sleeper=delays.append,
                    retry_policy=p1.RetryPolicy(
                        max_attempts=1,
                        initial_delay_seconds=0.1,
                        max_delay_seconds=0.2,
                    ),
                    started_at=0.0,
                )

                def operation() -> None:
                    nonlocal attempts
                    attempts += 1
                    if mode == "call":
                        raise ConnectionResetError("fixture transport")
                    raise p1.DataTransportError("fixture exhaustion")

                with self.assertRaisesRegex(
                    p1.StageDeadlineExceeded,
                    "^base deadline exceeded$",
                ):
                    if mode == "call":
                        budget.call("fixture", operation)
                    else:
                        budget.call_pretried_until_deadline(operation)

                self.assertEqual(attempts, 2)
                self.assertEqual(len(delays), 2)
                self.assertAlmostEqual(sum(delays), 0.25)

    def test_pretried_parent_exhaustion_returns_control_to_splitter(
        self,
    ) -> None:
        attempts = 0
        delays: list[float] = []
        budget = p1.StageBudget(
            stage="base",
            max_seconds=10,
            clock=lambda: 0.0,
            sleeper=delays.append,
            started_at=0.0,
        )

        def operation() -> None:
            nonlocal attempts
            attempts += 1
            raise p1.DataTransportError("fixture exhaustion")

        with self.assertRaisesRegex(
            p1.RetryableFragmentFailure,
            "^base fragment transport exhausted$",
        ):
            budget.call_pretried(operation)

        self.assertEqual(attempts, 1)
        self.assertEqual(delays, [])


if __name__ == "__main__":
    unittest.main()
