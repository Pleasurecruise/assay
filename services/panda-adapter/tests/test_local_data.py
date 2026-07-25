from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import pandas as pd

from panda_adapter.audit_cache import (
    HistoricalMembersPolicy,
    PitMembershipCache,
    V9_CACHE_MANIFEST_SCHEMA_VERSION,
    V9_CACHE_VERSION,
)
from panda_adapter.availability_audit import (
    _rebalance_pairs,
    run_availability_audit,
)
from panda_adapter.engine import protocol as engine_protocol
from panda_adapter.local_data import (
    LOCAL_DATA_PACKAGE_SCHEMA_VERSION,
    LOCAL_DATA_REF_VERSION,
    LocalAuditData,
    load_local_audit_data,
    parse_local_data_ref,
)
from panda_adapter.market_panel import MarketPanel


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _strategy_spec(
    *,
    top_n: int = 1,
    claims: dict[str, float] | None = None,
) -> dict[str, object]:
    return {
        "specVersion": "1",
        "universe": {"index": "000300.SH"},
        "signal": {
            "kind": "template",
            "template": "momentum",
            "params": {"window": 20},
        },
        "selection": {"topN": top_n, "weighting": "equal"},
        "rebalance": {"frequency": "monthly", "at": "close"},
        "window": {"start": "20260101", "end": "20260105"},
        "costs": {"model": "standard"},
        **({} if claims is None else {"claims": claims}),
    }


def _strategy_key(spec: dict[str, object]) -> str:
    strategy = {
        key: spec[key]
        for key in (
            "specVersion",
            "universe",
            "signal",
            "selection",
            "rebalance",
            "window",
        )
    }
    return f"sha256-{sha256(_canonical_bytes(strategy)).hexdigest()}"


def _tree_digest(root: Path) -> str:
    digest = sha256()
    paths = sorted(
        (
            path.relative_to(root).as_posix().encode("utf-8"),
            path,
        )
        for path in root.rglob("*")
        if path.is_file()
    )
    for relative, path in paths:
        digest.update(relative)
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return f"sha256-{digest.hexdigest()}"


def _build_local_package(
    root: Path,
    *,
    package_id: str = "g01",
) -> tuple[str, Path]:
    registry = root / "local-packages"
    registry.mkdir()
    market_path = root / "market.csv"
    market = pd.DataFrame(
        [
            {
                "date": date,
                "symbol": symbol,
                "adjClose": 100.0 + date_offset + symbol_offset,
                "tradeStatus": 0,
            }
            for date_offset, date in enumerate(
                ("2026-01-01", "2026-01-02", "2026-01-05")
            )
            for symbol_offset, symbol in enumerate(
                ("000001.SZ", "600001.SH")
            )
        ]
    )
    market_path.write_text(
        market.to_csv(index=False, lineterminator="\n"),
        encoding="utf-8",
    )

    pit_root = root / "pit"
    timeline_root = pit_root / "index-weights" / "000300_SH"
    timeline_root.mkdir(parents=True)
    snapshots = {
        "2026-01-02": ["000001.SZ", "600001.SH"],
        "2026-01-05": ["000001.SZ"],
    }
    for date, symbols in snapshots.items():
        (timeline_root / f"{date.replace('-', '')}.json").write_text(
            json.dumps(
                {
                    "schemaVersion": "pit-index-snapshot-v1",
                    "indexSymbol": "000300.SH",
                    "requestedDate": date,
                    "effectiveDate": date,
                    "symbols": symbols,
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )

    symbols = sorted({"000001.SZ", "600001.SH"})
    base_universe_hash = sha256("\n".join(symbols).encode("utf-8")).hexdigest()[
        :16
    ]
    v9_root = root / "v9"
    v9_root.mkdir()
    timeline_dataset = {
        "status": "ready",
        "path": "pit/index-weights/000300_SH",
        "columns": ["requestedDate", "effectiveDate", "symbols"],
        "downloaded": 2,
        "tradingDates": 2,
        "rowCount": 3,
        "symbols": 2,
        "quality": {
            "pointCount": 2,
            "memberCounts": {
                date: len(values) for date, values in snapshots.items()
            },
            "primaryKeysValid": True,
        },
    }
    historical_dataset = {
        "status": "degraded",
        "mode": "remove_only",
        "reasonCode": "HISTORICAL_MEMBER_DATA_UNAVAILABLE",
        "path": None,
        "columns": ["date", "symbol", "adjClose", "tradeStatus"],
        "assumptions": ["The fixture authorizes remove-only handling."],
        "rowCount": 0,
        "tradingDates": 0,
        "symbols": 0,
        "quality": {"primaryKeysValid": False, "verified": False},
    }
    manifest = {
        "schemaVersion": V9_CACHE_MANIFEST_SCHEMA_VERSION,
        "cacheVersion": V9_CACHE_VERSION,
        "promoted": True,
        "state": "degraded",
        "window": {"start": "2026-01-01", "end": "2026-01-05"},
        "universe": {
            "indexSymbol": "000300.SH",
            "baseSymbols": 2,
            "baseUniverseHash": base_universe_hash,
        },
        "datasets": {
            "basePanel": {
                "status": "ready",
                "factorWindowAnchor": "2026-01-01",
                "columns": ["date", "symbol", "adjClose", "tradeStatus"],
            },
            "pitTimeline": timeline_dataset,
            "historicalMembers": historical_dataset,
            "indexDaily": {
                "status": "degraded",
                "mode": "constituent_proxy",
                "reasonCode": "INDEX_DAILY_UNAVAILABLE",
            },
            "comparatorFactors": {
                "status": "degraded",
                "mode": "classic_only",
                "reasonCode": "COMPARATOR_FACTORS_UNAVAILABLE",
            },
        },
    }
    v9_manifest_path = v9_root / "manifest.json"
    v9_manifest_path.write_bytes(_canonical_bytes(manifest))

    spec = _strategy_spec()
    descriptor = {
        "schemaVersion": LOCAL_DATA_PACKAGE_SCHEMA_VERSION,
        "packageId": package_id,
        "strategyKey": _strategy_key(spec),
        "universe": {
            "indexSymbol": "000300.SH",
            "membershipMode": "point_in_time",
        },
        "window": {"start": "20260101", "end": "20260105"},
        "coverage": {
            "start": "2026-01-01",
            "end": "2026-01-05",
            "asOf": "2026-01-05",
        },
        "capabilities": {
            "trade_calendar": "ready",
            "pit_membership": "ready",
            "adjusted_close": "ready",
            "trade_status": "ready",
            "index_daily": "degraded",
            "comparator_factors": "degraded",
        },
        "paths": {
            "marketDataCache": "market.csv",
            "v9CacheRoot": "v9",
            "pitCacheRoot": "pit",
        },
        "checksums": {
            "marketData": f"sha256-{sha256(market_path.read_bytes()).hexdigest()}",
            "v9Manifest": (
                f"sha256-{sha256(v9_manifest_path.read_bytes()).hexdigest()}"
            ),
            "pitTree": _tree_digest(timeline_root),
        },
    }
    descriptor_bytes = _canonical_bytes(descriptor)
    descriptor_path = registry / f"{package_id}.json"
    descriptor_path.write_bytes(descriptor_bytes)
    descriptor_digest = f"sha256-{sha256(descriptor_bytes).hexdigest()}"
    return (
        f"{LOCAL_DATA_REF_VERSION}:audit-1:{package_id}:{descriptor_digest}",
        descriptor_path,
    )


class LocalDataLoaderTest(unittest.TestCase):
    def test_loader_reuses_v9_degradations_and_ignores_claims(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_ref, _ = _build_local_package(root)
            local = load_local_audit_data(data_ref, root=root)
            spec = _strategy_spec(
                claims={"annualReturn": 0.18, "sharpe": 1.9},
            )

            local.require_spec_identity(spec)
            local.require_spec_identity(
                {
                    **spec,
                    "costs": {"model": "none"},
                }
            )
            full_panel = local.full_market_panel(spec)
            as_of_panel = local.as_of_market_panel(spec)
            policy = local.historical_members_policy(spec)

            self.assertEqual(local.cache_version, V9_CACHE_VERSION)
            self.assertEqual(
                list(full_panel.adjusted_close.columns),
                ["000001.SZ", "600001.SH"],
            )
            self.assertEqual(
                list(as_of_panel.adjusted_close.columns),
                ["000001.SZ"],
            )
            self.assertEqual(policy.mode, "remove_only")
            self.assertIsNone(local.index_daily_cache())
            self.assertIsNone(local.comparator_factor_cache())
            with patch.dict(
                os.environ,
                {"ASSAY_AUDIT_OUTPUT_ROOT": str(root / "audit-output")},
            ):
                self.assertTrue(local.derived_root.is_dir())

            with self.assertRaisesRegex(ValueError, "strategy identity"):
                local.require_spec_identity(_strategy_spec(top_n=2))

    def test_loader_rejects_descriptor_market_and_pit_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_ref, descriptor = _build_local_package(root)

            descriptor.write_bytes(descriptor.read_bytes() + b" ")
            with self.assertRaisesRegex(RuntimeError, "descriptor digest"):
                load_local_audit_data(data_ref, root=root)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_ref, _ = _build_local_package(root)
            (root / "market.csv").write_bytes(
                (root / "market.csv").read_bytes().replace(b"100.0", b"999.0", 1)
            )
            with self.assertRaisesRegex(RuntimeError, "market-data cache digest"):
                load_local_audit_data(data_ref, root=root)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_ref, _ = _build_local_package(root)
            snapshot = (
                root
                / "pit"
                / "index-weights"
                / "000300_SH"
                / "20260105.json"
            )
            snapshot.write_bytes(snapshot.read_bytes() + b" ")
            with self.assertRaisesRegex(RuntimeError, "PIT timeline digest"):
                load_local_audit_data(data_ref, root=root)

    def test_data_ref_rejects_path_traversal(self) -> None:
        with self.assertRaisesRegex(ValueError, "valid Assay"):
            parse_local_data_ref(
                "assay-local-data-v1:audit:../g01:"
                f"sha256-{'a' * 64}"
            )

    def test_engine_protocol_selects_local_prefix(self) -> None:
        spec = _strategy_spec()
        data_ref = (
            "assay-local-data-v1:audit:g01:"
            f"sha256-{'a' * 64}"
        )
        local = Mock()

        with patch(
            "panda_adapter.engine.protocol.load_local_audit_data",
            return_value=local,
        ) as loader:
            observed = engine_protocol._local_data_for_request(
                {"dataRef": data_ref},
                spec,
            )

        loader.assert_called_once_with(data_ref)
        local.require_spec_identity.assert_called_once_with(spec)
        self.assertIs(observed, local)

    def test_availability_preserves_local_remove_only_disclosure(self) -> None:
        dates = pd.bdate_range("2026-01-01", "2026-04-01")
        prices = pd.DataFrame(
            {
                "000001.SZ": [100.0 + index for index in range(len(dates))],
                "600001.SH": [120.0 + index * 0.5 for index in range(len(dates))],
            },
            index=dates,
        )
        panel = MarketPanel(
            adjusted_close=prices,
            tradable=prices.notna(),
        )
        signal_dates = [
            signal_date for signal_date, _execution_date in _rebalance_pairs(dates)
        ]
        snapshots = {
            date: frozenset(
                {"000001.SZ", "600001.SH", "600002.SH"}
                if index == 0
                else {"000001.SZ", "600001.SH"}
            )
            for index, date in enumerate(signal_dates)
        }
        policy = HistoricalMembersPolicy(
            mode="remove_only",
            cache_version=V9_CACHE_VERSION,
            reason_code="HISTORICAL_MEMBER_DATA_UNAVAILABLE",
        )
        spec = _strategy_spec()
        spec["window"] = {"start": "20260101", "end": "20260401"}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local = LocalAuditData(
                data_ref=(
                    "assay-local-data-v1:audit:g01:"
                    f"sha256-{'a' * 64}"
                ),
                root=root,
                audit_id="audit",
                package_id="g01",
                descriptor_digest=f"sha256-{'a' * 64}",
                descriptor={},
                market_data_path=root / "unused.csv",
                v9_cache_root=root,
                pit_cache_root=root,
                v9_manifest={"cacheVersion": V9_CACHE_VERSION},
            )
            with (
                patch.dict(
                    os.environ,
                    {"ASSAY_AUDIT_OUTPUT_ROOT": str(root / "audit-output")},
                ),
                patch.object(LocalAuditData, "require_spec_identity"),
                patch.object(
                    LocalAuditData,
                    "as_of_market_panel",
                    return_value=panel,
                ),
                patch.object(
                    LocalAuditData,
                    "full_market_panel",
                    return_value=panel,
                ),
                patch.object(
                    LocalAuditData,
                    "pit_membership_cache",
                    return_value=PitMembershipCache(
                        snapshots=snapshots,
                        cache_version=V9_CACHE_VERSION,
                    ),
                ),
                patch.object(
                    LocalAuditData,
                    "historical_members_policy",
                    return_value=policy,
                ),
                patch(
                    "panda_adapter.moire_audit.persist_corrected_backtest_context"
                ),
            ):
                result = run_availability_audit(spec, local_data=local)

        self.assertEqual(result["mode"], "degraded_remove_only")
        assumptions = "\n".join(result["assumptions"])
        self.assertIn("manifest authorizes remove-only", assumptions)
        self.assertIn("immutable local dataRef", assumptions)
        self.assertNotIn("no current-only constituent fallback", assumptions)


if __name__ == "__main__":
    unittest.main()
