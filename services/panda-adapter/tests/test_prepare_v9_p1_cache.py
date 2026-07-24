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
        if truncate_date is None or date != truncate_date or positions[symbol] < 189
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
        dates[0],
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
    ) -> None:
        self.base_dates = pd.DatetimeIndex(base_dates)
        self.base_symbols = list(base_symbols)
        self.extra_symbol = extra_symbol
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
                result["quality"]["tradableFactorCoverage"],
                True,
            )
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


if __name__ == "__main__":
    unittest.main()
