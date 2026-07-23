import { describe, expect, test } from "vitest";
import { AUDIT_CHECK_IDS, isAuditCheckId, parseAuditCheckResult } from "../src/audit-checks";

describe("audit check contract", () => {
  test("keeps the canonical five-check order stable", () => {
    expect(AUDIT_CHECK_IDS).toEqual([
      "param-robustness",
      "data-availability",
      "cost-stress",
      "regime-dependency",
      "homogeneity-decay",
    ]);
    expect(AUDIT_CHECK_IDS.every(isAuditCheckId)).toBe(true);
  });

  test("accepts a reproducible conclusive result", () => {
    const result = parseAuditCheckResult(
      {
        id: "param-robustness",
        conclusion: "fail",
        confidence: 0.9,
        evidence: [
          {
            metric: "neighborhoodSharpeRetention",
            value: 0.35,
            unit: "ratio",
            sourceRefs: ["artifact:backtest/parameter-grid"],
          },
        ],
        missingEvidence: [],
      },
      "param-robustness",
    );

    expect(result.conclusion).toBe("fail");
    expect(result.confidence).toBe(0.9);
  });

  test("requires evidence for a conclusive result", () => {
    expect(() =>
      parseAuditCheckResult({
        id: "cost-stress",
        conclusion: "pass",
        confidence: 0.7,
        evidence: [],
        missingEvidence: [],
      }),
    ).toThrow('Check "cost-stress" must contain reproducible evidence');
  });

  test("requires an explanation for insufficient evidence", () => {
    expect(() =>
      parseAuditCheckResult({
        id: "data-availability",
        conclusion: "insufficient_evidence",
        confidence: 0,
        evidence: [],
        missingEvidence: [],
      }),
    ).toThrow('Check "data-availability" must explain missing evidence');
  });

  test("enforces the empty not-applicable representation", () => {
    expect(
      parseAuditCheckResult({
        id: "cost-stress",
        conclusion: "not_applicable",
        confidence: null,
        evidence: [],
        missingEvidence: [],
      }),
    ).toEqual({
      id: "cost-stress",
      conclusion: "not_applicable",
      confidence: null,
      evidence: [],
      missingEvidence: [],
    });

    expect(() =>
      parseAuditCheckResult({
        id: "cost-stress",
        conclusion: "not_applicable",
        confidence: 1,
        evidence: [],
        missingEvidence: [],
      }),
    ).toThrow("must be empty and have null confidence");
  });

  test("rejects non-finite evidence and confidence", () => {
    expect(() =>
      parseAuditCheckResult({
        id: "homogeneity-decay",
        conclusion: "pass",
        confidence: Number.NaN,
        evidence: [
          {
            metric: "correlation",
            value: Number.POSITIVE_INFINITY,
            unit: "ratio",
            sourceRefs: ["artifact:test"],
          },
        ],
        missingEvidence: [],
      }),
    ).toThrow();
  });
});
