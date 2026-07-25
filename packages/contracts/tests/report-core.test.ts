import { describe, expect, test } from "vitest";
import {
  buildCaseSummaryZh,
  deriveVerdictRationale,
  formatDecimal,
  formatEvidenceValueZh,
  formatPercentZh,
  formatSignedPp,
  selectKeyEvidence,
  shortWindowSuppression,
  type AuditCheckResult,
  type CheckEvidence,
} from "../src";

function evidence(metric: string, value: number | string | boolean, unit: string): CheckEvidence {
  return { metric, value, unit, sourceRefs: ["test:report-core"] };
}

function check(
  id: AuditCheckResult["id"],
  conclusion: AuditCheckResult["conclusion"],
  entries: readonly CheckEvidence[],
): AuditCheckResult {
  return {
    id,
    conclusion,
    confidence: conclusion === "not_applicable" ? null : 0.9,
    evidence: entries,
    missingEvidence:
      conclusion === "insufficient_evidence"
        ? [
            {
              requirement: "comparator panel",
              reason: "degraded capability",
              sourceRefs: ["test:gap"],
            },
          ]
        : [],
  };
}

const REGIME_EVIDENCE: readonly CheckEvidence[] = [
  evidence("down-high.days", 11, "trading_days"),
  evidence("down-high.annualReturn", 105.74782414689032, "annualized_decimal"),
  evidence("up-normal.days", 391, "trading_days"),
  evidence("up-normal.annualReturn", 0.18, "annualized_decimal"),
  evidence("dominantEnvironment.pnlShare", 0.78, "fraction_of_total_pnl"),
];

describe("report-core formatting", () => {
  test("suppresses annualized presentation for short windows (red line 3)", () => {
    const annualized = REGIME_EVIDENCE[1];
    if (annualized === undefined) {
      throw new Error("fixture missing");
    }
    expect(shortWindowSuppression(annualized, REGIME_EVIDENCE)).toEqual({
      windowTradingDays: 11,
    });
    expect(formatEvidenceValueZh(annualized, REGIME_EVIDENCE)).toBe(
      "不予年化呈现（样本 11 个交易日）",
    );
    // The formatted output must never contain the absurd annualized number.
    expect(formatEvidenceValueZh(annualized, REGIME_EVIDENCE)).not.toContain("105");
  });

  test("keeps annualized presentation for windows at or above the threshold", () => {
    const annualized = REGIME_EVIDENCE[3];
    if (annualized === undefined) {
      throw new Error("fixture missing");
    }
    expect(shortWindowSuppression(annualized, REGIME_EVIDENCE)).toBeUndefined();
    expect(formatEvidenceValueZh(annualized, REGIME_EVIDENCE)).toBe("18%");
  });

  test("formats units deterministically", () => {
    expect(formatPercentZh(0.29299487465351537)).toBe("29.3%");
    expect(formatSignedPp(0.08)).toBe("+8 pp");
    expect(formatSignedPp(-0.11299487465351538)).toBe("-11.3 pp");
    expect(formatDecimal(0.8999999999999999, 2)).toBe("0.9");
    expect(formatEvidenceValueZh(evidence("contaminatedSelectionRate", 0.42, "ratio"), [])).toBe(
      "42%",
    );
    expect(formatEvidenceValueZh(evidence("baselineSharpe", 1.0445, "ratio"), [])).toBe("1.044");
    expect(formatEvidenceValueZh(evidence("affectedRebalances", 35, "count"), [])).toBe("35");
    expect(
      formatEvidenceValueZh(evidence("pessimistic_annualReturn_positive", true, "boolean"), []),
    ).toBe("是");
  });
});

describe("report-core rationale and summary (v9 RETIRE shape)", () => {
  const checks: readonly AuditCheckResult[] = [
    check("param-robustness", "pass", [evidence("neighborhoodSharpeRetention", 0.96, "ratio")]),
    check("data-availability", "fail", [
      evidence("futureConstituentCount", 76, "count"),
      evidence("affectedRebalances", 35, "count"),
      evidence("contaminatedSelectionRate", 0.42, "ratio"),
    ]),
    check("cost-stress", "pass_with_reservations", [
      evidence("pessimistic_annualReturn", 0.031, "ratio"),
    ]),
    check("regime-dependency", "pass", REGIME_EVIDENCE),
    check("homogeneity-decay", "fail", [
      evidence("maxAbsMeanSpearman", 1, "spearman_rho"),
      evidence("yearsCovered", 3.5, "years"),
    ]),
  ];

  test("deriveVerdictRationale names the failing checks and the fail-first rule", () => {
    const rationale = deriveVerdictRationale({
      checks,
      verdict: "RETIRE",
      recoveryConditions: [],
    });
    expect(rationale.failedCheckIds).toEqual(["data-availability", "homogeneity-decay"]);
    expect(rationale.watchCapApplied).toBe(false);
    expect(rationale.zh).toBe(
      "五项检查中「数据可得性」「同质化衰减」失败；按预声明的 fail 优先规则定档 RETIRE（退役），且其中至少一项没有预声明恢复路径。",
    );
    expect(rationale.en).toContain("fail-first");
  });

  test("buildCaseSummaryZh cites key evidence for every failed check", () => {
    const summary = buildCaseSummaryZh({
      checks,
      verdict: "RETIRE",
      claimComparison: null,
      watchCapApplied: false,
    });
    expect(summary).toBe(
      "「数据可得性」失败（未来成分股数量 76，受影响调仓次数 35）；「同质化衰减」失败（与常见因子的最高相似度 1，覆盖年数 3.5）；按预声明的 fail 优先规则定档 RETIRE（退役——建议停止使用这套策略）。",
    );
  });

  test("selectKeyEvidence prefers the shared key-metric table", () => {
    const availability = checks[1];
    if (availability === undefined) {
      throw new Error("fixture missing");
    }
    expect(selectKeyEvidence(availability).map((entry) => entry.metric)).toEqual([
      "futureConstituentCount",
      "affectedRebalances",
      "contaminatedSelectionRate",
    ]);
  });
});
