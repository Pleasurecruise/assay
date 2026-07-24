import type { AuditCheckId, AuditCheckResult } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import { planMoireExperiments } from "../src/moire";

function result(
  id: AuditCheckId,
  conclusion: AuditCheckResult["conclusion"],
  confidence: number,
): AuditCheckResult {
  return {
    id,
    conclusion,
    confidence,
    evidence:
      conclusion === "insufficient_evidence"
        ? []
        : [
            {
              metric: "test",
              value: 1,
              unit: "count",
              sourceRefs: [`test:${id}`],
            },
          ],
    missingEvidence:
      conclusion === "insufficient_evidence"
        ? [{ requirement: id, reason: "missing", sourceRefs: [`test:${id}`] }]
        : [],
  };
}

describe("Moiré experiment planner", () => {
  test("selects at most two verdict-changing negative checks", () => {
    const experiments = planMoireExperiments([
      result("param-robustness", "fail", 0.9),
      result("data-availability", "pass", 0.8),
      result("cost-stress", "fail", 0.7),
      result("regime-dependency", "pass_with_reservations", 0.6),
      result("homogeneity-decay", "pass", 0.8),
    ]);

    expect(experiments).toHaveLength(2);
    expect(experiments.map((experiment) => experiment.checkId)).toEqual([
      "param-robustness",
      "cost-stress",
    ]);
  });

  test("does not spend follow-up budget when every check agrees", () => {
    const experiments = planMoireExperiments([
      result("param-robustness", "pass", 0.8),
      result("data-availability", "pass", 0.8),
      result("cost-stress", "pass", 0.8),
      result("regime-dependency", "pass", 0.8),
      result("homogeneity-decay", "pass", 0.8),
    ]);

    expect(experiments).toEqual([]);
  });
});
