import {
  AUDIT_CHECK_IDS,
  AUDIT_CHECK_SCHEMA_VERSION,
  type ParallelAuditChecksResult,
} from "@assay/contracts";
import { freezeStrategySpec } from "@assay/intake";
import { describe, expect, test } from "vitest";
import { buildExecutedAuditArtifact } from "../src/audit-orchestrator";

describe("buildExecutedAuditArtifact", () => {
  test("discloses that Skeleton failures cannot be graded QUARANTINE", () => {
    const identity = {
      auditId: "audit_verdict_limit",
      subjectId: "strategy_verdict_limit",
      traceId: "trace_verdict_limit",
    };
    const frozen = freezeStrategySpec(
      {
        specVersion: "1",
        universe: { index: "000300.SH" },
        signal: {
          kind: "template",
          template: "momentum",
          params: { window: 20 },
        },
        selection: { topN: 50 },
        rebalance: { frequency: "monthly" },
        window: { start: "20210101", end: "20251231" },
      },
      {
        dataAsOf: "2026-07-24",
        capabilitySnapshotId: "test:static",
        codeRevision: "test-revision",
      },
    );
    const result: ParallelAuditChecksResult = {
      schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
      auditId: identity.auditId,
      subjectId: identity.subjectId,
      traceId: identity.traceId,
      checks: AUDIT_CHECK_IDS.map((id) => ({
        id,
        conclusion: "fail",
        confidence: 0.8,
        evidence: [
          {
            metric: "materialDefect",
            value: true,
            unit: "boolean",
            sourceRefs: [`test:${id}`],
          },
        ],
        missingEvidence: [],
      })),
      startedAt: "2026-07-24T00:00:00.000Z",
      completedAt: "2026-07-24T00:00:01.000Z",
    };

    const artifact = buildExecutedAuditArtifact({
      frozen,
      identity,
      result,
      generatedAt: "2026-07-24T00:00:02.000Z",
    });

    expect(artifact.results[0]?.verdict).toBe("RETIRE");
    expect(artifact.results[0]?.assumptionsAndLimits).toContain(
      "Recovery-condition reasoning is not implemented in the Skeleton phase, so failures that VERDICT_SPEC §2 would grade QUARANTINE are graded RETIRE.",
    );
  });
});
