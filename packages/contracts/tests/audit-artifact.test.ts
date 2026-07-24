import { describe, expect, test } from "vitest";
import {
  AUDIT_CHECK_IDS,
  canonicalizeStrategySpec,
  createEarlyExitAuditArtifact,
  hashStrategySpec,
  parseAuditArtifact,
  parseStrategySpec,
  toCanonicalStrategySpec,
} from "../src";

const canonicalStrategySpec = toCanonicalStrategySpec(
  parseStrategySpec({
    specVersion: "1",
    universe: { index: "000300.SH" },
    signal: {
      kind: "template",
      template: "momentum",
      params: { window: 20 },
    },
    selection: { topN: 50, weighting: "equal" },
    rebalance: { frequency: "monthly", at: "close" },
    window: { start: "20210101", end: "20251231" },
    costs: { model: "standard" },
  }),
);

const canonicalBytes = canonicalizeStrategySpec(canonicalStrategySpec);

const provenance = {
  inputHash: hashStrategySpec(canonicalBytes),
  dataAsOf: "2026-07-22",
  dataSources: [{ id: "panda-data", version: "0.0.12" }],
  codeRevision: "test-revision",
} as const;

function fullArtifact(): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    kind: "strategy_audit",
    auditId: "audit_01",
    generatedAt: "2026-07-23T12:00:00Z",
    results: [
      {
        subjectId: "strategy_01",
        verdict: "UNVERIFIABLE",
        confidence: 0.4,
        summary: "The checks ran but required market evidence is not wired in this phase.",
        strategySpec: canonicalStrategySpec,
        defaultsApplied: [],
        parsingAssumptions: [],
        checks: AUDIT_CHECK_IDS.map((id) => ({
          id,
          conclusion: "insufficient_evidence",
          confidence: 0.4,
          evidence: [],
          missingEvidence: [
            {
              requirement: `verified evidence for ${id}`,
              reason: "data tools are not wired in the Skeleton phase",
              sourceRefs: ["system:skeleton"],
            },
          ],
        })),
        moire: { disputesOpened: 0, resolved: [], unresolved: [] },
        recoveryConditions: [],
        reviewTriggers: [],
        assumptionsAndLimits: ["PandaData tools were not available to the check."],
      },
    ],
    comparison: null,
    riskDisclosure: [
      "This is a technical robustness audit, not investment advice or a return promise.",
    ],
    provenance,
  };
}

function earlyExitArtifact() {
  return createEarlyExitAuditArtifact({
    auditId: "audit_early",
    subjectId: "strategy_early",
    generatedAt: "2026-07-23T12:00:00Z",
    summary: "The strategy is missing its audit window.",
    reasonCode: "insufficient_information",
    missingInformation: [
      {
        requirement: "window",
        reason: "a historical start and end date are required",
        sourceRefs: ["doc:STRATEGY_SPEC#window"],
      },
    ],
    recoveryConditions: [
      {
        scope: "intake",
        condition: "Resubmit with window.start and window.end.",
      },
    ],
    provenance,
  });
}

describe("Audit Artifact contract", () => {
  test("accepts an executed §4 strategy Artifact with the frozen StrategySpec", () => {
    const artifact = parseAuditArtifact(fullArtifact());

    expect(artifact.kind).toBe("strategy_audit");
    expect(artifact.results[0]?.strategySpec).toEqual(canonicalStrategySpec);
    expect(artifact.provenance.inputHash).toBe(hashStrategySpec(canonicalBytes));
    expect(artifact.riskDisclosure.length).toBeGreaterThan(0);
  });

  test("accepts the §4.1 early-exit shape with all five not-applicable checks", () => {
    const artifact = parseAuditArtifact(earlyExitArtifact());
    const result = artifact.results[0];

    expect(result).toEqual(
      expect.objectContaining({
        verdict: "UNVERIFIABLE",
        confidence: null,
        reasonCode: "insufficient_information",
      }),
    );
    expect(result?.checks.map((check) => check.id)).toEqual(AUDIT_CHECK_IDS);
    expect(
      result?.checks.every(
        (check) =>
          check.conclusion === "not_applicable" &&
          check.confidence === null &&
          check.evidence.length === 0 &&
          check.missingEvidence.length === 0,
      ),
    ).toBe(true);
    expect(result?.moire).toEqual({
      disputesOpened: 0,
      resolved: [],
      unresolved: [],
    });
  });

  test("requires the frozen StrategySpec after any strategy check executes", () => {
    const artifact = fullArtifact();
    const result = (artifact.results as Record<string, unknown>[])[0];
    if (result === undefined) {
      throw new Error("missing test result");
    }
    delete result.strategySpec;

    expect(() => parseAuditArtifact(artifact)).toThrow(
      "executed strategy_audit must include the frozen strategySpec",
    );
  });

  test("rejects a non-canonical StrategySpec in an executed Artifact", () => {
    const artifact = fullArtifact();
    const result = (artifact.results as Record<string, unknown>[])[0];
    if (result === undefined) {
      throw new Error("missing test result");
    }
    result.strategySpec = {
      ...canonicalStrategySpec,
      selection: { topN: 50 },
    };

    expect(() => parseAuditArtifact(artifact)).toThrow(
      "must include every canonical StrategySpec default",
    );
  });

  test("keeps early-exit fields mutually exclusive with executed checks", () => {
    const artifact = fullArtifact();
    const result = (artifact.results as Record<string, unknown>[])[0];
    if (result === undefined) {
      throw new Error("missing test result");
    }
    result.reasonCode = "unsupported_input";
    result.missingInformation = [
      {
        requirement: "signal",
        reason: "unsupported",
        sourceRefs: ["doc:STRATEGY_SPEC#signal"],
      },
    ];

    expect(() => parseAuditArtifact(artifact)).toThrow(
      "may only use early-exit fields when no checks executed",
    );
  });

  test.each([
    ["reasonCode", "reasonCode is required"],
    ["missingInformation", "missingInformation is required"],
  ])("requires early-exit %s", (field, expectedMessage) => {
    const artifact = structuredClone(earlyExitArtifact()) as unknown as Record<string, unknown>;
    const result = (artifact.results as Record<string, unknown>[])[0];
    if (result === undefined) {
      throw new Error("missing test result");
    }
    delete result[field];

    expect(() => parseAuditArtifact(artifact)).toThrow(expectedMessage);
  });

  test("rejects an early exit with an executed or malformed check slot", () => {
    const artifact = structuredClone(earlyExitArtifact()) as unknown as Record<string, unknown>;
    const result = (artifact.results as Record<string, unknown>[])[0];
    const checks = result?.checks as Record<string, unknown>[];
    if (result === undefined || checks[0] === undefined) {
      throw new Error("missing test check");
    }
    result.confidence = 0.8;
    checks[0] = {
      id: "param-robustness",
      conclusion: "pass",
      confidence: 0.8,
      evidence: [
        {
          metric: "retention",
          value: 0.9,
          unit: "ratio",
          sourceRefs: ["artifact:test"],
        },
      ],
      missingEvidence: [],
    };

    expect(() => parseAuditArtifact(artifact)).toThrow(
      "may only use early-exit fields when no checks executed",
    );
  });

  test("requires zero disputes and a non-empty risk disclosure for early exits", () => {
    const withDispute = structuredClone(earlyExitArtifact()) as unknown as Record<string, unknown>;
    const disputedResult = (withDispute.results as Record<string, unknown>[])[0];
    if (disputedResult === undefined) {
      throw new Error("missing test result");
    }
    disputedResult.moire = {
      disputesOpened: 1,
      resolved: ["unexpected"],
      unresolved: [],
    };
    expect(() => parseAuditArtifact(withDispute)).toThrow(
      "early exit must report zero Moiré disputes",
    );

    const withoutDisclosure = structuredClone(earlyExitArtifact()) as unknown as Record<
      string,
      unknown
    >;
    withoutDisclosure.riskDisclosure = [];
    expect(() => parseAuditArtifact(withoutDisclosure)).toThrow(
      "$.riskDisclosure must be a non-empty array of strings",
    );
  });
});
