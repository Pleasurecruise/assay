import { describe, expect, test } from "vitest";
import {
  assertAuditCheckSubmissionCompleted,
  parseAuditCheckSubmission,
} from "../src/final-result";

function validSubmission() {
  return {
    conclusion: "pass",
    confidence: 0.82,
    evidence: [
      {
        metric: "neighborhoodSharpeRetention",
        value: 1.035,
        unit: "ratio",
        sourceRefs: ["artifact:backtest/parameter-grid"],
      },
    ],
    missingEvidence: [],
  };
}

describe("final audit result submission", () => {
  test("accepts and clones one exact frozen-schema result", () => {
    const raw = validSubmission();
    const parsed = parseAuditCheckSubmission(raw, "param-robustness");

    expect(parsed).toEqual({ id: "param-robustness", ...raw });
    expect(parsed).not.toBe(raw);
    expect(parsed.evidence).not.toBe(raw.evidence);
  });

  test.each([
    ["model-authored id", { id: "param-robustness", ...validSubmission() }],
    ["unknown top-level field", { ...validSubmission(), extra: true }],
    ["host-only field", { ...validSubmission(), refinedByMoire: "forbidden" }],
    [
      "unknown evidence field",
      {
        ...validSubmission(),
        evidence: [{ ...validSubmission().evidence[0], extra: true }],
      },
    ],
    [
      "unknown missing-evidence field",
      {
        ...validSubmission(),
        missingEvidence: [
          {
            requirement: "history",
            reason: "missing",
            sourceRefs: ["artifact:test"],
            extra: true,
          },
        ],
      },
    ],
  ])("rejects %s before framework argument repair", (_name, submission) => {
    expect(() => parseAuditCheckSubmission(submission, "param-robustness")).toThrow(
      /must contain exactly/,
    );
  });

  test("rejects composite evidence and injects the host-owned id", () => {
    expect(() =>
      parseAuditCheckSubmission(
        {
          ...validSubmission(),
          evidence: [{ ...validSubmission().evidence[0], value: [1, 2] }],
        },
        "param-robustness",
      ),
    ).toThrow("invalid evidence");
    expect(parseAuditCheckSubmission(validSubmission(), "cost-stress").id).toBe("cost-stress");
  });

  test("requires exactly one successful captured submission", () => {
    const parsed = parseAuditCheckSubmission(validSubmission(), "param-robustness");
    expect(() => assertAuditCheckSubmissionCompleted(1, parsed)).not.toThrow();
    expect(() => assertAuditCheckSubmissionCompleted(0, undefined)).toThrow(
      "submitted successfully exactly once",
    );
    expect(() => assertAuditCheckSubmissionCompleted(2, parsed)).toThrow(
      "submitted successfully exactly once",
    );
  });
});
