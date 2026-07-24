from __future__ import annotations

import json
import re
import unittest
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

from panda_adapter.audit_cache import V9_CACHE_VERSION

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
INVENTORY_PATH = (
    REPOSITORY_ROOT
    / "artifacts"
    / "v9"
    / "p5-pre-terminal-simplification-deviation-inventory.json"
)
MANIFEST_PATH = (
    REPOSITORY_ROOT / ".cache" / "assay" / "v9-p1-v1" / "manifest.json"
)

AUTHORIZED_ENTRY_IDS = {
    "official_post_strict_gap_fill",
    "historical_members_remove_only",
    "pit_constituent_equal_weight_proxy",
    "homogeneity_classic_only",
    "price_only_financial_timing_not_activated",
    "manual_spearman_scipy_equivalence",
    "terminal_as_of_not_month_end",
}
COMPLETED_GATE_IDS = {"single_agent_smokes"}
BLOCKING_GATE_IDS = {
    "terminal_golden_snapshot",
    "real_online_e2e",
    "remote_head_verification",
}
ACCEPTANCE_GATE_IDS = COMPLETED_GATE_IDS | BLOCKING_GATE_IDS


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"{path.name} must contain a JSON object")
    return value


def _resolve_json_pointer(value: Any, pointer: str) -> Any:
    if not pointer.startswith("/"):
        raise AssertionError(f"invalid JSON pointer: {pointer}")
    current = value
    for raw_token in pointer[1:].split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if token not in current:
                raise AssertionError(f"missing JSON pointer: {pointer}")
            current = current[token]
        elif isinstance(current, list) and token.isdigit():
            current = current[int(token)]
        else:
            raise AssertionError(f"invalid JSON pointer traversal: {pointer}")
    return current


def _walk(value: Any) -> list[Any]:
    values = [value]
    if isinstance(value, dict):
        for item in value.values():
            values.extend(_walk(item))
    elif isinstance(value, list):
        for item in value:
            values.extend(_walk(item))
    return values


class V9DeviationInventoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.raw_inventory = INVENTORY_PATH.read_text(encoding="utf-8")
        cls.inventory = _load_json(INVENTORY_PATH)

    def test_schema_and_acceptance_state_are_complete(self) -> None:
        self.assertEqual(
            set(self.inventory),
            {
                "schemaVersion",
                "artifactRole",
                "generatedAt",
                "cacheVersion",
                "state",
                "sourceManifest",
                "finalAcceptance",
                "entries",
                "acceptanceGates",
                "safety",
            },
        )
        self.assertEqual(
            self.inventory["schemaVersion"],
            "assay-v9-simplification-deviation-inventory-v1",
        )
        self.assertEqual(
            self.inventory["artifactRole"],
            "pre-terminal-simplification-deviation-inventory",
        )
        self.assertEqual(self.inventory["state"], "pre-terminal")
        self.assertEqual(self.inventory["cacheVersion"], V9_CACHE_VERSION)
        datetime.fromisoformat(
            str(self.inventory["generatedAt"]).replace("Z", "+00:00")
        )

        entries = self.inventory["entries"]
        gates = self.inventory["acceptanceGates"]
        self.assertIsInstance(entries, list)
        self.assertIsInstance(gates, list)
        self.assertEqual(len(entries), len(AUTHORIZED_ENTRY_IDS))
        self.assertEqual(len(gates), len(ACCEPTANCE_GATE_IDS))
        self.assertEqual({entry["id"] for entry in entries}, AUTHORIZED_ENTRY_IDS)
        self.assertEqual({gate["id"] for gate in gates}, ACCEPTANCE_GATE_IDS)
        self.assertTrue(
            all(
                set(entry)
                == {
                    "id",
                    "type",
                    "status",
                    "summary",
                    "authorization",
                    "impact",
                    "evidenceRefs",
                    "blocksFinalAcceptance",
                }
                and set(entry["authorization"])
                == {"status", "scope", "condition"}
                and set(entry["impact"])
                == {"affectedChecks", "effect", "residualRisk"}
                and entry["status"] == "active_authorized"
                and entry["authorization"]["status"] == "authorized"
                and entry["blocksFinalAcceptance"] is False
                and entry["evidenceRefs"]
                for entry in entries
            )
        )
        self.assertTrue(
            all(
                {
                    "id",
                    "status",
                    "summary",
                    "impact",
                    "verificationRefs",
                    "completionEvidenceRequired",
                    "blocksFinalAcceptance",
                }
                <= set(gate)
                and gate["status"]
                == (
                    "completed"
                    if gate["id"] in COMPLETED_GATE_IDS
                    else "pending"
                )
                and gate["blocksFinalAcceptance"]
                is (gate["id"] in BLOCKING_GATE_IDS)
                and gate["verificationRefs"]
                and gate["completionEvidenceRequired"]
                for gate in gates
            )
        )
        acceptance = self.inventory["finalAcceptance"]
        self.assertEqual(acceptance["status"], "blocked")
        self.assertEqual(
            set(acceptance["nonBlockingAuthorizedEntryIds"]),
            AUTHORIZED_ENTRY_IDS,
        )
        self.assertEqual(
            set(acceptance["completedGateIds"]),
            COMPLETED_GATE_IDS,
        )
        self.assertEqual(
            set(acceptance["blockingGateIds"]),
            BLOCKING_GATE_IDS,
        )

    @unittest.skipUnless(
        MANIFEST_PATH.is_file(),
        "local promoted v9 cache is not available",
    )
    def test_cache_version_and_manifest_evidence_are_bound(self) -> None:
        manifest = _load_json(MANIFEST_PATH)
        source_manifest = self.inventory["sourceManifest"]
        self.assertEqual(
            source_manifest["path"],
            ".cache/assay/v9-p1-v1/manifest.json",
        )
        self.assertEqual(
            self.inventory["cacheVersion"],
            source_manifest["cacheVersion"],
        )
        self.assertEqual(
            source_manifest["cacheVersion"],
            manifest["cacheVersion"],
        )
        self.assertEqual(source_manifest["schemaVersion"], manifest["schemaVersion"])
        self.assertEqual(source_manifest["state"], manifest["state"])
        self.assertEqual(source_manifest["promoted"], manifest["promoted"])

        for entry in self.inventory["entries"]:
            for evidence in entry["evidenceRefs"]:
                if evidence["kind"] == "cache_provenance":
                    self.assertTrue(
                        (REPOSITORY_ROOT / PurePosixPath(evidence["path"])).is_file()
                    )
                if evidence["kind"] != "manifest":
                    continue
                self.assertEqual(evidence["path"], source_manifest["path"])
                for pointer in evidence["jsonPointers"]:
                    self.assertIsNotNone(_resolve_json_pointer(manifest, pointer))

    def test_safety_and_evidence_references_are_local_and_sanitized(self) -> None:
        self.assertEqual(
            self.inventory["safety"],
            {
                "containsCredentials": False,
                "containsPersonalContactData": False,
                "containsAbsoluteLocalPaths": False,
                "containsVendorRawErrors": False,
            },
        )
        self.assertNotRegex(self.raw_inventory, r"/(?:Users|home)/")
        self.assertNotRegex(self.raw_inventory, r"[A-Za-z]:\\\\")
        self.assertNotIn("file://", self.raw_inventory)
        self.assertNotRegex(
            self.raw_inventory,
            r"(?i)\b(?:sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._-]{12,})",
        )
        self.assertNotRegex(
            self.raw_inventory,
            r"(?<!\d)1[3-9]\d{9}(?!\d)",
        )

        forbidden_keys = {
            "apiKey",
            "password",
            "secret",
            "token",
            "rawError",
            "vendorError",
            "rawVendorError",
            "localPath",
        }
        for value in _walk(self.inventory):
            if not isinstance(value, dict):
                continue
            self.assertTrue(forbidden_keys.isdisjoint(value))
            path = value.get("path")
            if path is None:
                continue
            self.assertIsInstance(path, str)
            relative = PurePosixPath(path)
            self.assertFalse(relative.is_absolute())
            self.assertNotIn("..", relative.parts)
            if value.get("kind") in {"source", "test"}:
                referenced_path = REPOSITORY_ROOT / relative
                self.assertTrue(referenced_path.is_file())
                referenced_text = referenced_path.read_text(encoding="utf-8")
                if "symbol" in value:
                    self.assertIn(value["symbol"], referenced_text)
                if "case" in value:
                    self.assertIn(value["case"], referenced_text)


if __name__ == "__main__":
    unittest.main()
