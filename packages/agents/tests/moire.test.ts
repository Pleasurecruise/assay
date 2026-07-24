import type {
  AuditCheckId,
  AuditCheckResult,
  CheckConclusion,
  CheckEvidence,
} from "@assay/contracts";
import { describe, expect, test } from "vitest";
import {
  MOIRE_EVIDENCE_METRICS,
  MOIRE_M1_DOMINANT_RETENTION_THRESHOLD,
  MOIRE_M1_OTHER_RETENTION_THRESHOLD,
  MOIRE_M1_PARAM_RETENTION_TRIGGER,
  MOIRE_M1_REGIME_PNL_SHARE_TRIGGER,
  MOIRE_M2_CORRECTED_RETURN_DELTA_TRIGGER,
  MOIRE_MAX_EXPERIMENTS,
  MOIRE_POLICY_VERSION,
  planDiscriminativeMoireExperiments,
  planMoireExperiments,
  planReviewMoireExperiments,
  synthesizeDiscriminativeMoire,
  synthesizeM1,
  synthesizeM2,
  type M1MoireExperiment,
  type M2MoireExperiment,
} from "../src/moire";

const CHECK_IDS: readonly AuditCheckId[] = [
  "param-robustness",
  "data-availability",
  "cost-stress",
  "regime-dependency",
  "homogeneity-decay",
];

function evidence(metric: string, value: CheckEvidence["value"]): CheckEvidence {
  return {
    metric,
    value,
    unit: "test",
    sourceRefs: [`fixture:${metric}`],
  };
}

function result(
  id: AuditCheckId,
  conclusion: CheckConclusion,
  items: readonly CheckEvidence[] = [evidence("test", 1)],
): AuditCheckResult {
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
      confidence: 0,
      evidence: items,
      missingEvidence: [{ requirement: id, reason: "missing", sourceRefs: [`fixture:${id}`] }],
    };
  }
  return {
    id,
    conclusion,
    confidence: 0.8,
    evidence: items,
    missingEvidence: [],
  };
}

function checkSet(
  overrides: Partial<Record<AuditCheckId, AuditCheckResult>> = {},
): readonly AuditCheckResult[] {
  return CHECK_IDS.map((id) => overrides[id] ?? result(id, "pass"));
}

function m1Checks(
  options: {
    parameterConclusion?: CheckConclusion;
    parameterRetention?: number;
    regimeConclusion?: CheckConclusion;
    dominantPnlShare?: number;
  } = {},
): readonly AuditCheckResult[] {
  return checkSet({
    "param-robustness": result("param-robustness", options.parameterConclusion ?? "fail", [
      evidence(
        MOIRE_EVIDENCE_METRICS.parameterRetention,
        options.parameterRetention ?? MOIRE_M1_PARAM_RETENTION_TRIGGER - 0.01,
      ),
    ]),
    "regime-dependency": result(
      "regime-dependency",
      options.regimeConclusion ?? "pass_with_reservations",
      [
        evidence(
          MOIRE_EVIDENCE_METRICS.dominantRegimePnlShare,
          options.dominantPnlShare ?? MOIRE_M1_REGIME_PNL_SHARE_TRIGGER + 0.01,
        ),
      ],
    ),
  });
}

function m2Checks(
  options: {
    availabilityConclusion?: CheckConclusion;
    correctedDelta?: number;
    costConclusion?: CheckConclusion;
  } = {},
): readonly AuditCheckResult[] {
  return checkSet({
    "data-availability": result("data-availability", options.availabilityConclusion ?? "fail", [
      evidence(
        MOIRE_EVIDENCE_METRICS.correctedAnnualReturnDelta,
        options.correctedDelta ?? MOIRE_M2_CORRECTED_RETURN_DELTA_TRIGGER,
      ),
    ]),
    "cost-stress": result("cost-stress", options.costConclusion ?? "pass_with_reservations"),
  });
}

function requireM1(): M1MoireExperiment {
  const experiment = planDiscriminativeMoireExperiments(m1Checks())[0];
  if (experiment?.id !== "M1") {
    throw new Error("M1 fixture did not trigger");
  }
  return experiment;
}

function requireM2(): M2MoireExperiment {
  const experiment = planDiscriminativeMoireExperiments(m2Checks(), {
    costBaselineMode: "uncorrected",
  })[0];
  if (experiment?.id !== "M2") {
    throw new Error("M2 fixture did not trigger");
  }
  return experiment;
}

describe("legacy review-style Moiré planner", () => {
  test("retains the bounded review planner and backwards-compatible export", () => {
    const checks = [
      result("param-robustness", "fail"),
      result("data-availability", "pass"),
      result("cost-stress", "fail"),
      result("regime-dependency", "pass_with_reservations"),
      result("homogeneity-decay", "pass"),
    ];

    const planned = planReviewMoireExperiments(checks);

    expect(planned).toHaveLength(2);
    expect(planned.map((experiment) => experiment.checkId)).toEqual([
      "param-robustness",
      "cost-stress",
    ]);
    expect(planMoireExperiments(checks)).toEqual(planned);
  });

  test("does not spend review budget when every check agrees", () => {
    expect(planReviewMoireExperiments(checkSet())).toEqual([]);
  });
});

describe("v9 discriminative Moiré planner", () => {
  test("plans M1 only for strict parameter and regime trigger boundaries", () => {
    const experiments = planDiscriminativeMoireExperiments(
      m1Checks({
        parameterRetention: MOIRE_M1_PARAM_RETENTION_TRIGGER - 0.000_001,
        dominantPnlShare: MOIRE_M1_REGIME_PNL_SHARE_TRIGGER + 0.000_001,
      }),
    );

    expect(experiments).toEqual([
      expect.objectContaining({
        id: "M1",
        policyVersion: MOIRE_POLICY_VERSION,
        kind: "regime_slice_of_grid",
        checkId: "param-robustness",
        pairedCheckId: "regime-dependency",
        trigger: {
          parameterRetention: MOIRE_M1_PARAM_RETENTION_TRIGGER - 0.000_001,
          dominantRegimePnlShare: MOIRE_M1_REGIME_PNL_SHARE_TRIGGER + 0.000_001,
        },
      }),
    ]);
  });

  test.each([
    {
      name: "retention equals 40 percent",
      options: { parameterRetention: MOIRE_M1_PARAM_RETENTION_TRIGGER },
    },
    {
      name: "dominant pnl share equals 70 percent",
      options: { dominantPnlShare: MOIRE_M1_REGIME_PNL_SHARE_TRIGGER },
    },
    {
      name: "parameter check did not fail",
      options: { parameterConclusion: "pass_with_reservations" as const },
    },
    {
      name: "regime check failed",
      options: { regimeConclusion: "fail" as const },
    },
  ])("does not trigger M1 when $name", ({ options }) => {
    expect(planDiscriminativeMoireExperiments(m1Checks(options))).toEqual([]);
  });

  test.each([MOIRE_M2_CORRECTED_RETURN_DELTA_TRIGGER, -MOIRE_M2_CORRECTED_RETURN_DELTA_TRIGGER])(
    "plans M2 at the inclusive absolute delta boundary %s",
    (correctedDelta) => {
      const experiments = planDiscriminativeMoireExperiments(m2Checks({ correctedDelta }), {
        costBaselineMode: "uncorrected",
      });

      expect(experiments).toEqual([
        expect.objectContaining({
          id: "M2",
          policyVersion: MOIRE_POLICY_VERSION,
          kind: "corrected_cost_ladder",
          checkId: "cost-stress",
          pairedCheckId: "data-availability",
          trigger: {
            correctedAnnualReturnDelta: correctedDelta,
            costBaselineMode: "uncorrected",
            originalCostConclusion: "pass_with_reservations",
          },
        }),
      ]);
    },
  );

  test.each([
    {
      name: "delta is below two percentage points",
      checks: m2Checks({
        correctedDelta: MOIRE_M2_CORRECTED_RETURN_DELTA_TRIGGER - 0.000_001,
      }),
      costBaselineMode: "uncorrected" as const,
    },
    {
      name: "cost baseline provenance is unknown",
      checks: m2Checks(),
      costBaselineMode: "unknown" as const,
    },
    {
      name: "cost baseline is already PIT corrected",
      checks: m2Checks(),
      costBaselineMode: "pit_corrected" as const,
    },
    {
      name: "availability check did not fail",
      checks: m2Checks({ availabilityConclusion: "pass_with_reservations" }),
      costBaselineMode: "uncorrected" as const,
    },
    {
      name: "cost conclusion is not conclusive",
      checks: m2Checks({ costConclusion: "insufficient_evidence" }),
      costBaselineMode: "uncorrected" as const,
    },
  ])("does not trigger M2 when $name", ({ checks, costBaselineMode }) => {
    expect(
      planDiscriminativeMoireExperiments(checks, {
        costBaselineMode,
      }),
    ).toEqual([]);
  });

  test("fails closed on duplicate canonical evidence", () => {
    const duplicateRetention = m1Checks().map((check) =>
      check.id === "param-robustness"
        ? {
            ...check,
            evidence: [...check.evidence, evidence(MOIRE_EVIDENCE_METRICS.parameterRetention, 0.2)],
          }
        : check,
    );
    const duplicateDelta = m2Checks().map((check) =>
      check.id === "data-availability"
        ? {
            ...check,
            evidence: [
              ...check.evidence,
              evidence(MOIRE_EVIDENCE_METRICS.correctedAnnualReturnDelta, -0.03),
            ],
          }
        : check,
    );

    expect(planDiscriminativeMoireExperiments(duplicateRetention)).toEqual([]);
    expect(
      planDiscriminativeMoireExperiments(duplicateDelta, {
        costBaselineMode: "uncorrected",
      }),
    ).toEqual([]);
  });

  test("ignores orthogonal failures and never plans M3", () => {
    const orthogonal = checkSet({
      "param-robustness": result("param-robustness", "pass", [
        evidence(MOIRE_EVIDENCE_METRICS.parameterRetention, 0.2),
      ]),
      "cost-stress": result("cost-stress", "fail"),
      "regime-dependency": result("regime-dependency", "pass", [
        evidence(MOIRE_EVIDENCE_METRICS.dominantRegimePnlShare, 0.9),
      ]),
      "homogeneity-decay": result("homogeneity-decay", "fail"),
    });

    expect(
      planDiscriminativeMoireExperiments(orthogonal, {
        costBaselineMode: "uncorrected",
      }),
    ).toEqual([]);
  });

  test("plans only M1 then M2 in fixed order, independent of input order", () => {
    const both = checkSet({
      "param-robustness": result("param-robustness", "fail", [
        evidence(MOIRE_EVIDENCE_METRICS.parameterRetention, 0.3),
      ]),
      "regime-dependency": result("regime-dependency", "pass_with_reservations", [
        evidence(MOIRE_EVIDENCE_METRICS.dominantRegimePnlShare, 0.8),
      ]),
      "data-availability": result("data-availability", "fail", [
        evidence(MOIRE_EVIDENCE_METRICS.correctedAnnualReturnDelta, -0.03),
      ]),
      "cost-stress": result("cost-stress", "fail"),
      "homogeneity-decay": result("homogeneity-decay", "fail"),
    });
    const context = { costBaselineMode: "uncorrected" as const };

    const forward = planDiscriminativeMoireExperiments(both, context);
    const reversed = planDiscriminativeMoireExperiments([...both].reverse(), context);

    expect(MOIRE_MAX_EXPERIMENTS).toBe(2);
    expect(forward.map((experiment) => experiment.id)).toEqual(["M1", "M2"]);
    expect(reversed).toEqual(forward);
    expect(forward).toHaveLength(MOIRE_MAX_EXPERIMENTS);
  });
});

describe("v9 deterministic Moiré synthesis", () => {
  test("synthesizes the M1 refinement at >=70% dominant and <40% elsewhere", () => {
    const experiment = requireM1();
    const first = synthesizeM1(experiment, {
      id: "M1",
      kind: "regime_slice_of_grid",
      sourceRef: "artifact:fixture/grid-daily-returns",
      dominantEnvironmentId: "up-normal",
      dominantRetention: MOIRE_M1_DOMINANT_RETENTION_THRESHOLD,
      otherEnvironmentRetentions: [
        { environmentId: "down-normal", retention: 0.2 },
        {
          environmentId: "up-high",
          retention: MOIRE_M1_OTHER_RETENTION_THRESHOLD - 0.000_001,
        },
      ],
    });
    const reordered = synthesizeM1(experiment, {
      id: "M1",
      kind: "regime_slice_of_grid",
      sourceRef: "artifact:fixture/grid-daily-returns",
      dominantEnvironmentId: "up-normal",
      dominantRetention: MOIRE_M1_DOMINANT_RETENTION_THRESHOLD,
      otherEnvironmentRetentions: [
        {
          environmentId: "up-high",
          retention: MOIRE_M1_OTHER_RETENTION_THRESHOLD - 0.000_001,
        },
        { environmentId: "down-normal", retention: 0.2 },
      ],
    });

    expect(first).toMatchObject({
      id: "M1",
      policyVersion: MOIRE_POLICY_VERSION,
      resolved: true,
      changed: true,
    });
    expect(first.refinedByMoire).toContain("参数脆弱性集中于非主导环境");
    expect(reordered).toEqual(first);
  });

  test.each([
    {
      name: "dominant retention is below 70 percent",
      dominantRetention: MOIRE_M1_DOMINANT_RETENTION_THRESHOLD - 0.000_001,
      others: [{ environmentId: "down-normal", retention: 0.2 }],
    },
    {
      name: "an other environment equals 40 percent",
      dominantRetention: MOIRE_M1_DOMINANT_RETENTION_THRESHOLD,
      others: [
        {
          environmentId: "down-normal",
          retention: MOIRE_M1_OTHER_RETENTION_THRESHOLD,
        },
      ],
    },
    {
      name: "there is no non-dominant environment",
      dominantRetention: MOIRE_M1_DOMINANT_RETENTION_THRESHOLD,
      others: [],
    },
  ])("keeps the M1 conclusion unchanged when $name", ({ dominantRetention, others }) => {
    const synthesis = synthesizeM1(requireM1(), {
      id: "M1",
      kind: "regime_slice_of_grid",
      sourceRef: "artifact:fixture/grid-daily-returns",
      dominantEnvironmentId: "up-normal",
      dominantRetention,
      otherEnvironmentRetentions: others,
    });

    expect(synthesis.changed).toBe(false);
    expect(synthesis.refinedByMoire).toContain("维持参数稳健性原结论");
  });

  test("synthesizes an M2 tier flip without mutating the original tier", () => {
    const experiment = requireM2();
    const synthesis = synthesizeM2(experiment, {
      id: "M2",
      kind: "corrected_cost_ladder",
      sourceRef: "artifact:fixture/pit-corrected-cost-ladder",
      correctedCostConclusion: "fail",
    });

    expect(experiment.trigger.originalCostConclusion).toBe("pass_with_reservations");
    expect(synthesis).toMatchObject({
      id: "M2",
      policyVersion: MOIRE_POLICY_VERSION,
      resolved: true,
      changed: true,
      effectiveConclusion: "fail",
    });
    expect(synthesis.refinedByMoire).toContain("PIT 修正后成本结论档位翻转，以修正版为准");
  });

  test("records M2 robustness when the corrected tier is unchanged", () => {
    const synthesis = synthesizeM2(requireM2(), {
      id: "M2",
      kind: "corrected_cost_ladder",
      sourceRef: "artifact:fixture/pit-corrected-cost-ladder",
      correctedCostConclusion: "pass_with_reservations",
    });

    expect(synthesis.changed).toBe(false);
    expect(synthesis.effectiveConclusion).toBe("pass_with_reservations");
    expect(synthesis.refinedByMoire).toContain("成本结论对成分修正稳健");
  });

  test("rejects mismatched experiment outcomes and malformed M1 environments", () => {
    expect(() =>
      synthesizeDiscriminativeMoire(requireM1(), {
        id: "M2",
        kind: "corrected_cost_ladder",
        sourceRef: "artifact:fixture/pit-corrected-cost-ladder",
        correctedCostConclusion: "fail",
      }),
    ).toThrow("matching id and kind");

    expect(() =>
      synthesizeM1(requireM1(), {
        id: "M1",
        kind: "regime_slice_of_grid",
        sourceRef: "artifact:fixture/grid-daily-returns",
        dominantEnvironmentId: "up-normal",
        dominantRetention: 0.8,
        otherEnvironmentRetentions: [{ environmentId: "up-normal", retention: 0.2 }],
      }),
    ).toThrow("environment ids must be unique");
  });
});
