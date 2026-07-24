from __future__ import annotations

import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

from panda_adapter.audit_cache import IndexDailyCache, V9_CACHE_VERSION
from panda_adapter.availability_audit import (
    PIT_DATASET_VERSION,
    PIT_SNAPSHOT_SCHEMA_VERSION,
    _rebalance_pairs,
    _snapshot_path,
    _write_json_atomic,
    run_availability_audit,
)
from panda_adapter.engine.experiments import run_cost_ladder, run_grid
from panda_adapter.engine.artifacts import (
    daily_returns_artifact_path,
    persist_grid_daily_returns,
)
from panda_adapter.market_panel import MarketPanel
from panda_adapter.moire_audit import (
    CORRECTED_CONTEXT_DIRECTORY,
    M1_SOURCE_REF_PREFIX,
    M2_SOURCE_REF_PREFIX,
    MOIRE_GRID_TOP_NS,
    MOIRE_GRID_WINDOWS,
    calculate_environment_retentions,
    load_corrected_backtest_context,
    moire_artifact_path,
    persist_corrected_backtest_context,
    run_moire_request,
)


def _spec(
    dates: pd.DatetimeIndex,
    *,
    top_n: int = 1,
    window: int = 1,
) -> dict[str, object]:
    return {
        "specVersion": "1",
        "universe": {"index": "000300.SH"},
        "signal": {
            "kind": "template",
            "template": "momentum",
            "params": {"window": window},
        },
        "selection": {"topN": top_n, "weighting": "equal"},
        "rebalance": {"frequency": "monthly", "at": "close"},
        "window": {
            "start": dates[0].strftime("%Y%m%d"),
            "end": dates[-1].strftime("%Y%m%d"),
        },
        "costs": {"model": "none"},
    }


def _daily_rows(
    dates: pd.DatetimeIndex,
    returns: list[float],
) -> list[dict[str, object]]:
    equity = 1.0
    rows: list[dict[str, object]] = []
    for date, value in zip(dates, returns, strict=True):
        equity *= 1.0 + value
        rows.append(
            {
                "date": date.strftime("%Y-%m-%d"),
                "return": value,
                "equity": equity,
            }
        )
    return rows


def _synthetic_m1_panel() -> tuple[
    pd.DatetimeIndex,
    MarketPanel,
    pd.Series,
]:
    dates = pd.bdate_range("2024-01-02", periods=360)
    positions = np.arange(len(dates), dtype=float)
    common = (
        100.0 * np.exp(0.0012 * positions) * (1.0 + 0.0015 * np.sin(positions / 3.0))
    )
    prices = pd.DataFrame(
        {
            symbol: common * multiplier
            for symbol, multiplier in zip(
                ["A", "B", "C", "D"],
                [1.0, 1.1, 1.2, 1.3],
                strict=True,
            )
        },
        index=dates,
    )
    panel = MarketPanel(
        adjusted_close=prices,
        tradable=pd.DataFrame(True, index=dates, columns=prices.columns),
    )
    index_close = pd.Series(
        100.0 * np.exp(0.0002 * positions) * (1.0 + 0.03 * np.sin(positions / 8.0)),
        index=dates,
    )
    return dates, panel, index_close


def _pessimistic_ladder(value: float) -> dict[str, object]:
    def summary(model: str, annual_return: float) -> dict[str, object]:
        return {
            "params": {
                "window": 1,
                "topN": 1,
                "costModel": model,
            },
            "annualReturn": annual_return,
            "sharpe": 0.0,
            "maxDrawdown": 0.0,
            "annualTurnover": 1.0,
        }

    return {
        "engineVersion": "known-answer",
        "baseline": summary("none", 0.1),
        "variants": [
            summary("standard", 0.05),
            summary("realistic", 0.01),
            summary("pessimistic", value),
        ],
    }


class MoireM1KnownAnswerTest(unittest.TestCase):
    def test_environment_retention_is_hand_calculable(self) -> None:
        dates = pd.bdate_range("2026-01-05", periods=4)
        labels = pd.DataFrame(
            {
                "id": [
                    "up-normal",
                    "up-normal",
                    "down-high",
                    "down-high",
                ]
            },
            index=dates,
        )
        daily_by_variant = {"baseline": _daily_rows(dates, [0.0, 0.02, 0.0, 0.02])}
        for window in MOIRE_GRID_WINDOWS:
            for top_n in MOIRE_GRID_TOP_NS:
                daily_by_variant[f"w{window}-n{top_n}"] = _daily_rows(
                    dates,
                    [-0.01, 0.03, -0.03, 0.05],
                )

        details = calculate_environment_retentions(
            daily_by_variant,
            labels=labels,
            environment_ids=["up-normal", "down-high"],
        )
        by_id = {row["environmentId"]: row for row in details}

        self.assertAlmostEqual(by_id["up-normal"]["retention"], 0.5)
        self.assertAlmostEqual(by_id["down-high"]["retention"], 0.25)
        self.assertEqual(by_id["up-normal"]["variantCount"], 15)

    def test_missing_artifacts_run_real_fixed_grid_then_are_reused(
        self,
    ) -> None:
        dates, panel, index_close = _synthetic_m1_panel()
        spec = _spec(dates, top_n=4, window=20)
        calls: list[int] = []

        def counting_grid(*args: object, **kwargs: object) -> dict[str, object]:
            calls.append(1)
            return run_grid(*args, **kwargs)  # type: ignore[arg-type]

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backtest_root = root / "backtest"
            moire_root = root / "moire"
            first = run_moire_request(
                {"kind": "regime_slice_of_grid", "spec": spec},
                panel_loader=lambda _: panel,
                index_loader=lambda: IndexDailyCache(
                    index_close,
                    "synthetic-index-v1",
                ),
                grid_runner=counting_grid,
                backtest_artifact_root=backtest_root,
                moire_artifact_root=moire_root,
            )

            self.assertEqual(calls, [1])
            self.assertEqual(
                set(first),
                {
                    "id",
                    "kind",
                    "sourceRef",
                    "dominantEnvironmentId",
                    "dominantRetention",
                    "otherEnvironmentRetentions",
                },
            )
            self.assertEqual(first["id"], "M1")
            self.assertEqual(first["kind"], "regime_slice_of_grid")
            self.assertRegex(
                first["sourceRef"],
                rf"^{M1_SOURCE_REF_PREFIX}[0-9a-f]{{64}}$",
            )
            self.assertAlmostEqual(
                first["dominantRetention"],
                1.0,
                delta=0.01,
            )
            self.assertTrue(first["otherEnvironmentRetentions"])
            self.assertTrue(
                all(
                    math.isclose(
                        row["retention"],
                        1.0,
                        abs_tol=0.01,
                    )
                    for row in first["otherEnvironmentRetentions"]
                )
            )
            evidence = json.loads(
                moire_artifact_path(
                    first["sourceRef"],
                    root=moire_root,
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(evidence["grid"]["variantCount"], 15)
            self.assertEqual(evidence["grid"]["mode"], "fixed_grid_rerun")
            self.assertTrue(
                any(
                    "deterministically rerun" in value
                    for value in evidence["assumptions"]
                )
            )

            second = run_moire_request(
                {"kind": "regime_slice_of_grid", "spec": spec},
                panel_loader=lambda _: panel,
                index_loader=lambda: IndexDailyCache(
                    index_close,
                    "synthetic-index-v1",
                ),
                grid_runner=lambda *args, **kwargs: self.fail(
                    "complete artifacts must be reused"
                ),
                backtest_artifact_root=backtest_root,
                moire_artifact_root=moire_root,
            )

            self.assertEqual(
                second["dominantEnvironmentId"], first["dominantEnvironmentId"]
            )
            self.assertAlmostEqual(
                second["dominantRetention"],
                1.0,
                delta=0.01,
            )
            self.assertEqual(second["sourceRef"], first["sourceRef"])
            second_evidence = json.loads(
                moire_artifact_path(
                    second["sourceRef"],
                    root=moire_root,
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(
                second_evidence["grid"]["mode"],
                "fixed_grid_rerun",
            )

    def test_ambiguous_artifact_candidates_force_fixed_grid_rerun(
        self,
    ) -> None:
        dates, panel, index_close = _synthetic_m1_panel()
        spec = _spec(dates, top_n=4, window=20)
        baseline = {"window": 20, "topN": 4, "costModel": "none"}
        variants = [
            {
                "variantId": f"w{window}-n{top_n}",
                "window": window,
                "topN": top_n,
            }
            for window in MOIRE_GRID_WINDOWS
            for top_n in MOIRE_GRID_TOP_NS
        ]
        calls: list[int] = []

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backtest_root = root / "backtest"
            first_grid = run_grid(
                panel.adjusted_close,
                tradable=panel.tradable,
                baseline=baseline,
                variants=variants,
                artifact_root=backtest_root,
            )
            first_variant = first_grid["variants"][0]
            reference = first_variant["params"]["dailyReturnsRef"]
            payload = json.loads(
                daily_returns_artifact_path(
                    reference,
                    root=backtest_root,
                ).read_text(encoding="utf-8")
            )
            altered_rows = [dict(row) for row in payload["dailyReturns"]]
            altered_rows[0]["return"] += 1e-9
            altered_equity = 1.0
            for row in altered_rows:
                altered_equity *= 1.0 + row["return"]
                row["equity"] = altered_equity
            persist_grid_daily_returns(
                variant_id=payload["variantId"],
                parameters=payload["params"],
                daily_returns=altered_rows,
                root=backtest_root,
            )

            def counting_grid(
                *args: object,
                **kwargs: object,
            ) -> dict[str, object]:
                calls.append(1)
                return run_grid(*args, **kwargs)  # type: ignore[arg-type]

            outcome = run_moire_request(
                {"kind": "regime_slice_of_grid", "spec": spec},
                panel_loader=lambda _: panel,
                index_loader=lambda: IndexDailyCache(
                    index_close,
                    "synthetic-index-v1",
                ),
                grid_runner=counting_grid,
                backtest_artifact_root=backtest_root,
                moire_artifact_root=root / "moire",
            )

            self.assertEqual(calls, [1])
            evidence = json.loads(
                moire_artifact_path(
                    outcome["sourceRef"],
                    root=root / "moire",
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(evidence["grid"]["mode"], "fixed_grid_rerun")


class MoireM2KnownAnswerTest(unittest.TestCase):
    def _availability_context(
        self,
        root: Path,
    ) -> tuple[dict[str, object], MarketPanel]:
        dates = pd.bdate_range("2026-01-02", periods=70)
        positions = np.arange(len(dates), dtype=float)
        prices = pd.DataFrame(
            {
                "A": (
                    100.0
                    * np.exp(-0.0002 * positions)
                    * (1.0 + 0.001 * np.sin(positions / 3.0))
                ),
                "B": 100.0 * np.power(1.01, positions),
            },
            index=dates,
        )
        panel = MarketPanel(
            adjusted_close=prices,
            tradable=pd.DataFrame(True, index=dates, columns=prices.columns),
        )
        spec = _spec(dates)
        for signal_date, _ in _rebalance_pairs(dates):
            _write_json_atomic(
                _snapshot_path(root, "000300.SH", signal_date),
                {
                    "schemaVersion": PIT_SNAPSHOT_SCHEMA_VERSION,
                    "indexSymbol": "000300.SH",
                    "requestedDate": signal_date.strftime("%Y-%m-%d"),
                    "effectiveDate": signal_date.strftime("%Y-%m-%d"),
                    "symbols": ["A"],
                },
            )
        availability = run_availability_audit(
            spec,
            panel_loader=lambda _: panel,
            client_factory=lambda: self.fail("cached PIT must not call live data"),
            cache_root=root,
        )
        self.assertEqual(availability["futureConstituentCount"], 1)
        return spec, panel

    def test_availability_context_drives_one_real_corrected_ladder(
        self,
    ) -> None:
        calls: list[pd.DataFrame] = []

        def counting_ladder(
            *args: object,
            **kwargs: object,
        ) -> dict[str, object]:
            calls.append(kwargs["eligible"].copy())  # type: ignore[union-attr]
            return run_cost_ladder(*args, **kwargs)  # type: ignore[arg-type]

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pit_root = root / "pit"
            moire_root = root / "moire"
            spec, panel = self._availability_context(pit_root)
            context = load_corrected_backtest_context(
                spec,
                pit_cache_root=pit_root,
            )

            self.assertEqual(context.cache_version, V9_CACHE_VERSION)
            self.assertEqual(
                context.pit_dataset_version,
                PIT_DATASET_VERSION,
            )
            self.assertFalse(context.eligible["B"].any())
            uncorrected = run_cost_ladder(
                panel.adjusted_close,
                tradable=panel.tradable,
                strategy={"window": 1, "topN": 1, "costModel": "none"},
            )
            uncorrected_pessimistic = next(
                row
                for row in uncorrected["variants"]
                if row["params"]["costModel"] == "pessimistic"
            )
            self.assertGreater(
                uncorrected_pessimistic["annualReturn"],
                0,
            )

            outcome = run_moire_request(
                {"kind": "corrected_cost_ladder", "spec": spec},
                cost_ladder_runner=counting_ladder,
                moire_artifact_root=moire_root,
                pit_cache_root=pit_root,
            )

            self.assertEqual(len(calls), 1)
            self.assertFalse(calls[0]["B"].any())
            self.assertEqual(
                outcome,
                {
                    "id": "M2",
                    "kind": "corrected_cost_ladder",
                    "sourceRef": outcome["sourceRef"],
                    "correctedCostConclusion": "fail",
                },
            )
            self.assertRegex(
                outcome["sourceRef"],
                rf"^{M2_SOURCE_REF_PREFIX}[0-9a-f]{{64}}$",
            )
            self.assertNotIn("adjustedClose", json.dumps(outcome))
            self.assertNotIn("eligible", json.dumps(outcome))
            evidence_text = moire_artifact_path(
                outcome["sourceRef"],
                root=moire_root,
            ).read_text(encoding="utf-8")
            self.assertNotIn("adjustedClose", evidence_text)
            self.assertNotIn(str(root), evidence_text)
            evidence = json.loads(evidence_text)
            self.assertEqual(
                evidence["correctedContextCacheVersion"],
                V9_CACHE_VERSION,
            )
            self.assertEqual(
                evidence["correctedContextPitDatasetVersion"],
                PIT_DATASET_VERSION,
            )

    def test_frozen_pessimistic_zero_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pit_root = root / "pit"
            moire_root = root / "moire"
            spec, _ = self._availability_context(pit_root)
            calls: list[float] = []

            def ladder(value: float):
                def run(*_: object, **__: object) -> dict[str, object]:
                    calls.append(value)
                    return _pessimistic_ladder(value)

                return run

            at_zero = run_moire_request(
                {"kind": "corrected_cost_ladder", "spec": spec},
                cost_ladder_runner=ladder(0.0),
                moire_artifact_root=moire_root,
                pit_cache_root=pit_root,
            )
            positive = run_moire_request(
                {"kind": "corrected_cost_ladder", "spec": spec},
                cost_ladder_runner=ladder(1e-12),
                moire_artifact_root=moire_root,
                pit_cache_root=pit_root,
            )

            self.assertEqual(calls, [0.0, 1e-12])
            self.assertEqual(at_zero["correctedCostConclusion"], "fail")
            self.assertEqual(
                positive["correctedCostConclusion"],
                "pass_with_reservations",
            )

    def test_stdio_exposes_only_m2_outcome_not_corrected_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pit_root = root / "pit"
            moire_root = root / "moire"
            spec, _ = self._availability_context(pit_root)
            source_root = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "src")
            )
            environment = {
                **os.environ,
                "PYTHONPATH": source_root,
                "ASSAY_PIT_CACHE_ROOT": str(pit_root),
                "ASSAY_MOIRE_ARTIFACT_ROOT": str(moire_root),
            }

            completed = subprocess.run(
                [sys.executable, "-m", "panda_adapter.moire_stdio"],
                input=json.dumps({"kind": "corrected_cost_ladder", "spec": spec}),
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stderr, "")
            outcome = json.loads(completed.stdout)
            self.assertEqual(
                set(outcome),
                {
                    "id",
                    "kind",
                    "sourceRef",
                    "correctedCostConclusion",
                },
            )
            self.assertNotIn("adjustedClose", completed.stdout)
            self.assertNotIn("eligible", completed.stdout)
            self.assertNotIn(str(root), completed.stdout)


class MoireProtocolBoundaryTest(unittest.TestCase):
    def test_rejects_agent_or_sibling_context(self) -> None:
        spec = {"hostFrozen": True}
        with self.assertRaisesRegex(ValueError, "exactly kind and spec"):
            run_moire_request(
                {
                    "kind": "regime_slice_of_grid",
                    "spec": spec,
                    "siblingResults": [],
                }
            )
        with self.assertRaisesRegex(ValueError, "exactly kind and spec"):
            run_moire_request(
                {
                    "kind": "corrected_cost_ladder",
                    "spec": spec,
                    "agentResult": {},
                }
            )

    def test_missing_m2_context_fails_closed(self) -> None:
        dates = pd.bdate_range("2026-01-02", periods=40)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "context is unavailable"):
                run_moire_request(
                    {
                        "kind": "corrected_cost_ladder",
                        "spec": _spec(dates),
                    },
                    pit_cache_root=Path(directory),
                )

    def test_stale_corrected_context_versions_fail_closed(self) -> None:
        dates = pd.bdate_range("2026-01-02", periods=40)
        prices = pd.DataFrame(
            {"A": np.linspace(100.0, 110.0, len(dates))},
            index=dates,
        )
        panel = MarketPanel(
            adjusted_close=prices,
            tradable=pd.DataFrame(True, index=dates, columns=prices.columns),
        )
        eligible = pd.DataFrame(True, index=dates, columns=prices.columns)
        spec = _spec(dates)
        cases = (
            ("stale-cache", PIT_DATASET_VERSION, "cache version"),
            (V9_CACHE_VERSION, "stale-pit-dataset", "PIT dataset version"),
        )

        for cache_version, pit_dataset_version, message in cases:
            with self.subTest(message=message):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    persist_corrected_backtest_context(
                        spec=spec,
                        panel=panel,
                        eligible=eligible,
                        availability_mode="full_pit",
                        cache_version=cache_version,
                        pit_dataset_version=pit_dataset_version,
                        pit_cache_root=root,
                    )
                    with self.assertRaisesRegex(RuntimeError, message):
                        load_corrected_backtest_context(
                            spec,
                            pit_cache_root=root,
                        )

    def test_corrected_context_is_below_host_cache_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec, _ = MoireM2KnownAnswerTest()._availability_context(root)

            context_files = list((root / CORRECTED_CONTEXT_DIRECTORY).glob("*.json"))
            self.assertEqual(len(context_files), 1)
            payload = json.loads(context_files[0].read_text(encoding="utf-8"))
            self.assertEqual(payload["cacheVersion"], V9_CACHE_VERSION)
            self.assertEqual(
                payload["pitDatasetVersion"],
                PIT_DATASET_VERSION,
            )
            self.assertRegex(payload["specHash"], r"^sha256:[0-9a-f]{64}$")
            self.assertRegex(
                payload["contextDigest"],
                r"^sha256:[0-9a-f]{64}$",
            )
            context = load_corrected_backtest_context(
                spec,
                pit_cache_root=root,
            )
            self.assertEqual(context.cache_version, V9_CACHE_VERSION)
            self.assertEqual(
                context.pit_dataset_version,
                PIT_DATASET_VERSION,
            )


if __name__ == "__main__":
    unittest.main()
