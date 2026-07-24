import {
  AUDIT_CHECK_IDS,
  AUDIT_CHECK_SCHEMA_VERSION,
  type AuditCheckId,
  type AuditCheckResult,
  type CheckConclusion,
  type ParallelAuditChecksResult,
} from "@assay/contracts";
import { freezeStrategySpec } from "@assay/intake";
import { describe, expect, test } from "vitest";
import { buildExecutedAuditArtifact } from "../src/audit-orchestrator";

const identity = {
  auditId: "audit_verdict_policy",
  subjectId: "strategy_verdict_policy",
  traceId: "trace_verdict_policy",
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

function checkResult(id: AuditCheckId, conclusion: CheckConclusion): AuditCheckResult {
  if (conclusion === "not_applicable") {
    return {
      id,
      conclusion,
      confidence: null,
      evidence: [],
      missingEvidence: [],
    };
  }
  if (conclusion === "insufficient_evidence") {
    return {
      id,
      conclusion,
      confidence: 0.2,
      evidence: [],
      missingEvidence: [
        {
          requirement: `verified evidence for ${id}`,
          reason: "the required history is unavailable",
          sourceRefs: [`test:${id}`],
        },
      ],
    };
  }
  return {
    id,
    conclusion,
    confidence: 0.8,
    evidence: [
      {
        metric: "materialDefect",
        value: conclusion === "fail",
        unit: "boolean",
        sourceRefs: [`test:${id}`],
      },
    ],
    missingEvidence: [],
  };
}

function buildArtifact(conclusions: Partial<Readonly<Record<AuditCheckId, CheckConclusion>>>) {
  const result: ParallelAuditChecksResult = {
    schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
    auditId: identity.auditId,
    subjectId: identity.subjectId,
    traceId: identity.traceId,
    checks: AUDIT_CHECK_IDS.map((id) => checkResult(id, conclusions[id] ?? "pass")),
    startedAt: "2026-07-24T00:00:00.000Z",
    completedAt: "2026-07-24T00:00:01.000Z",
  };
  return buildExecutedAuditArtifact({
    frozen,
    identity,
    result,
    generatedAt: "2026-07-24T00:00:02.000Z",
  });
}

function buildRefinedArtifact(
  checkId: AuditCheckId,
  conclusion: CheckConclusion,
  refinedByMoire: string,
) {
  const result: ParallelAuditChecksResult = {
    schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
    auditId: identity.auditId,
    subjectId: identity.subjectId,
    traceId: identity.traceId,
    checks: AUDIT_CHECK_IDS.map((id) => ({
      ...checkResult(id, id === checkId ? conclusion : "pass"),
      ...(id === checkId ? { refinedByMoire } : {}),
    })),
    startedAt: "2026-07-24T00:00:00.000Z",
    completedAt: "2026-07-24T00:00:01.000Z",
  };
  return buildExecutedAuditArtifact({
    frozen,
    identity,
    result,
    generatedAt: "2026-07-24T00:00:02.000Z",
  });
}

describe("buildExecutedAuditArtifact", () => {
  test("prioritizes a recoverable fail over insufficient evidence", () => {
    const artifact = buildArtifact({
      "param-robustness": "insufficient_evidence",
      "data-availability": "fail",
    });
    const result = artifact.results[0];

    expect(result?.verdict).toBe("QUARANTINE");
    expect(result?.confidence).toBe(0.2);
    expect(result?.checks.find((check) => check.id === "data-availability")?.conclusion).toBe(
      "fail",
    );
    expect(result?.recoveryConditions).toEqual([
      {
        scope: "data-availability",
        condition: "改用 PIT 成分池重跑",
      },
    ]);
  });

  test("quarantines when every failed check has a static recovery condition", () => {
    const artifact = buildArtifact({
      "param-robustness": "fail",
      "data-availability": "fail",
      "cost-stress": "fail",
      "regime-dependency": "fail",
    });

    expect(artifact.results[0]?.verdict).toBe("QUARANTINE");
    expect(artifact.results[0]?.recoveryConditions).toEqual([
      {
        scope: "param-robustness",
        condition: "收窄参数敏感面或加环境过滤",
      },
      {
        scope: "data-availability",
        condition: "改用 PIT 成分池重跑",
      },
      {
        scope: "cost-stress",
        condition: "降低调仓频率/换手后复审",
      },
      {
        scope: "regime-dependency",
        condition: "增加环境过滤规则",
      },
    ]);
  });

  test("retires when any failed check has no recovery condition", () => {
    const artifact = buildArtifact({
      "param-robustness": "fail",
      "homogeneity-decay": "fail",
    });

    expect(artifact.results[0]?.verdict).toBe("RETIRE");
    expect(artifact.results[0]?.recoveryConditions).toEqual([]);
  });

  test("uses the host-synthesized M2 corrected tier without mutating the agent conclusion", () => {
    const artifact = buildRefinedArtifact(
      "cost-stress",
      "pass_with_reservations",
      "[M2][resolved] PIT 修正后成本结论档位翻转，以修正版为准。 original=pass_with_reservations; corrected=fail; sourceRef=artifact:fixture/cost",
    );
    const result = artifact.results[0];
    const cost = result?.checks.find((check) => check.id === "cost-stress");

    expect(cost?.conclusion).toBe("pass_with_reservations");
    expect(result?.verdict).toBe("QUARANTINE");
    expect(result?.recoveryConditions).toEqual([
      {
        scope: "cost-stress",
        condition: "降低调仓频率/换手后复审",
      },
    ]);
    expect(result?.moire.resolved).toHaveLength(1);
    expect(result?.moire.unresolved).toEqual([]);
  });

  test("uses a corrected passing M2 tier while preserving the original agent fail", () => {
    const artifact = buildRefinedArtifact(
      "cost-stress",
      "fail",
      "[M2][resolved] PIT 修正后成本结论档位翻转，以修正版为准。 original=fail; corrected=pass; sourceRef=artifact:fixture/cost",
    );
    const result = artifact.results[0];
    const cost = result?.checks.find((check) => check.id === "cost-stress");

    expect(cost?.conclusion).toBe("fail");
    expect(result?.verdict).toBe("KEEP");
    expect(result?.recoveryConditions).toEqual([]);
  });

  test("treats an unresolved verdict-changing Moiré dispute as insufficient evidence", () => {
    const artifact = buildRefinedArtifact(
      "param-robustness",
      "fail",
      "[M1][unresolved] 判别实验未完成，该矛盾仍可能改变最终判决。",
    );
    const result = artifact.results[0];
    const parameter = result?.checks.find((check) => check.id === "param-robustness");

    expect(parameter?.conclusion).toBe("fail");
    expect(result?.verdict).toBe("UNVERIFIABLE");
    expect(result?.confidence).toBe(0);
    expect(result?.moire.resolved).toEqual([]);
    expect(result?.moire.unresolved).toHaveLength(1);
    expect(result?.recoveryConditions).toEqual([]);
  });

  test("keeps an evidence gap unverifiable when no check fails", () => {
    const artifact = buildArtifact({
      "data-availability": "insufficient_evidence",
      "cost-stress": "pass_with_reservations",
    });

    expect(artifact.results[0]?.verdict).toBe("UNVERIFIABLE");
    expect(artifact.results[0]?.recoveryConditions).toEqual([]);
  });

  test("summarizes provenance plus Moiré refinements independently of verdict policy", () => {
    const provenanceIdentity = {
      auditId: "audit_verdict_limit",
      subjectId: "strategy_verdict_limit",
      traceId: "trace_verdict_limit",
    };
    const result: ParallelAuditChecksResult = {
      schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
      auditId: provenanceIdentity.auditId,
      subjectId: provenanceIdentity.subjectId,
      traceId: provenanceIdentity.traceId,
      checks: AUDIT_CHECK_IDS.map((id) =>
        id === "data-availability"
          ? {
              id,
              conclusion: "insufficient_evidence",
              confidence: 0.2,
              evidence: [],
              missingEvidence: [
                {
                  requirement: "point-in-time index constituents",
                  reason: "the required history is unavailable",
                  sourceRefs: ["test:data-availability"],
                },
              ],
            }
          : {
              id,
              conclusion: "fail",
              confidence: 0.8,
              evidence: [
                {
                  metric: "materialDefect",
                  value: true,
                  unit: "boolean",
                  sourceRefs:
                    id === "param-robustness"
                      ? ["assay:backtest:fixture", "pandadata:market_data:fixture"]
                      : [`test:${id}`],
                },
              ],
              missingEvidence: [],
              ...(id === "param-robustness" ? { refinedByMoire: "moire-1-param-robustness" } : {}),
            },
      ),
      startedAt: "2026-07-24T00:00:00.000Z",
      completedAt: "2026-07-24T00:00:01.000Z",
    };
    const artifact = buildExecutedAuditArtifact({
      frozen,
      identity: provenanceIdentity,
      result,
      generatedAt: "2026-07-24T00:00:02.000Z",
    });

    expect(artifact.results[0]?.verdict).toBe("RETIRE");
    expect(artifact.results[0]?.confidence).toBe(0.2);
    expect(artifact.results[0]?.moire).toEqual({
      disputesOpened: 1,
      resolved: ["moire-1-param-robustness"],
      unresolved: [],
    });
    expect(artifact.provenance.dataSources).toEqual([
      { id: "assay:backtest:fixture", version: "assay-backtester@1" },
      {
        id: "pandadata:market_data:fixture",
        version: "panda_data@0.0.12",
      },
    ]);
  });
});
