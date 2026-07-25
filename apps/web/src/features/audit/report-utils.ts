import type { AuditVerdict, ClaimComparison } from "@assay/contracts/audit-artifact";
import { shortWindowSuppression } from "@assay/contracts/report-core";
import type {
  AuditCheckId,
  AuditCheckResult,
  CheckConclusion,
  CheckEvidence,
} from "@assay/contracts/audit-checks";

import type { Language, TranslationFunction, TranslationKey } from "@/i18n";

export const VERDICT_COPY = {
  KEEP: {
    title: "report.verdict.KEEP.title",
    body: "report.verdict.KEEP.body",
  },
  WATCH: {
    title: "report.verdict.WATCH.title",
    body: "report.verdict.WATCH.body",
  },
  QUARANTINE: {
    title: "report.verdict.QUARANTINE.title",
    body: "report.verdict.QUARANTINE.body",
  },
  RETIRE: {
    title: "report.verdict.RETIRE.title",
    body: "report.verdict.RETIRE.body",
  },
  UNVERIFIABLE: {
    title: "report.verdict.UNVERIFIABLE.title",
    body: "report.verdict.UNVERIFIABLE.body",
  },
} as const satisfies Record<AuditVerdict, { title: TranslationKey; body: TranslationKey }>;

export const CHECK_QUESTION_KEYS = {
  "param-robustness": "report.question.param-robustness",
  "data-availability": "report.question.data-availability",
  "cost-stress": "report.question.cost-stress",
  "regime-dependency": "report.question.regime-dependency",
  "homogeneity-decay": "report.question.homogeneity-decay",
} as const satisfies Record<AuditCheckId, TranslationKey>;

export const CHECK_IMPACT_KEYS = {
  "param-robustness": "report.impact.param-robustness",
  "data-availability": "report.impact.data-availability",
  "cost-stress": "report.impact.cost-stress",
  "regime-dependency": "report.impact.regime-dependency",
  "homogeneity-decay": "report.impact.homogeneity-decay",
} as const satisfies Record<AuditCheckId, TranslationKey>;

const HIGHLIGHT_METRICS: Readonly<Record<AuditCheckId, readonly string[]>> = {
  "param-robustness": ["neighborhoodSharpeRetention", "medianVariantSharpe", "variantCount"],
  "data-availability": ["contaminatedSelectionRate", "affectedRebalances", "corrected.sharpe"],
  "cost-stress": [
    "annualReturn_pessimistic",
    "returnErosion_baseline_to_pessimistic",
    "maxDrawdown_pessimistic",
  ],
  "regime-dependency": ["dominantEnvironment.pnlShare"],
  "homogeneity-decay": [
    "summary.maxAbsMeanSpearman",
    "summary.yearsCovered",
    "summary.rankIcSlope",
  ],
};

const METRIC_LABEL_KEYS: Readonly<Partial<Record<string, TranslationKey>>> = {
  neighborhoodSharpeRetention: "metric.neighborhoodSharpeRetention",
  medianVariantSharpe: "metric.medianVariantSharpe",
  variantCount: "metric.variantCount",
  contaminatedSelectionRate: "metric.contaminatedSelectionRate",
  affectedRebalances: "metric.affectedRebalances",
  "corrected.sharpe": "metric.correctedSharpe",
  annualReturn_pessimistic: "metric.pessimisticAnnualReturn",
  returnErosion_baseline_to_pessimistic: "metric.returnErosion",
  maxDrawdown_pessimistic: "metric.pessimisticDrawdown",
  "dominantEnvironment.pnlShare": "metric.dominantPnlShare",
  "summary.maxAbsMeanSpearman": "metric.factorSimilarity",
  "summary.yearsCovered": "metric.yearsCovered",
  "summary.rankIcSlope": "metric.rankIcSlope",
};

const CONCLUSION_PRIORITY: Readonly<Record<CheckConclusion, number>> = {
  fail: 0,
  insufficient_evidence: 1,
  pass_with_reservations: 2,
  pass: 3,
  not_applicable: 4,
};

export interface ClaimComparisonRow {
  id: "annual-return" | "sharpe" | "max-drawdown";
  claimed: number;
  reproduced: number;
  gap: number;
  percent: boolean;
}

export function notableChecks(checks: readonly AuditCheckResult[]): AuditCheckResult[] {
  return checks
    .filter(
      (check) =>
        (check.conclusion !== "pass" && check.conclusion !== "not_applicable") ||
        check.missingEvidence.length > 0,
    )
    .toSorted(
      (left, right) => CONCLUSION_PRIORITY[left.conclusion] - CONCLUSION_PRIORITY[right.conclusion],
    );
}

export function evidenceHighlights(check: AuditCheckResult): readonly CheckEvidence[] {
  const byMetric = new Map(check.evidence.map((evidence) => [evidence.metric, evidence]));
  const preferred = HIGHLIGHT_METRICS[check.id]
    .map((metric) => byMetric.get(metric))
    .filter((evidence): evidence is CheckEvidence => evidence !== undefined);
  if (preferred.length >= 3) {
    return preferred.slice(0, 3);
  }

  const selected = new Set(preferred.map((evidence) => evidence.metric));
  for (const evidence of check.evidence) {
    if (preferred.length >= 3) {
      break;
    }
    if (typeof evidence.value === "number" && !selected.has(evidence.metric)) {
      preferred.push(evidence);
      selected.add(evidence.metric);
    }
  }
  return preferred;
}

export function claimComparisonRows(comparison: ClaimComparison): ClaimComparisonRow[] {
  const rows: ClaimComparisonRow[] = [];
  if (comparison.claimed.annualReturn !== undefined) {
    rows.push({
      id: "annual-return",
      claimed: comparison.claimed.annualReturn,
      reproduced: comparison.reproduced.annualReturn,
      gap: comparison.gaps.annualReturn ?? 0,
      percent: true,
    });
  }
  if (comparison.claimed.sharpe !== undefined) {
    rows.push({
      id: "sharpe",
      claimed: comparison.claimed.sharpe,
      reproduced: comparison.reproduced.sharpe,
      gap: comparison.gaps.sharpe ?? 0,
      percent: false,
    });
  }
  if (comparison.claimed.maxDrawdown !== undefined) {
    rows.push({
      id: "max-drawdown",
      claimed: comparison.claimed.maxDrawdown,
      reproduced: comparison.reproduced.maxDrawdown,
      gap: comparison.gaps.maxDrawdown ?? 0,
      percent: true,
    });
  }
  return rows;
}

export function metricLabel(t: TranslationFunction, metric: string): string {
  const key = METRIC_LABEL_KEYS[metric];
  return key ? t(key) : metric;
}

export function confidenceLevel(t: TranslationFunction, confidence: number | null): string {
  if (confidence === null) {
    return t("report.confidenceUnknown");
  }
  if (confidence >= 0.8) {
    return t("report.confidenceHigh");
  }
  if (confidence >= 0.6) {
    return t("report.confidenceMedium");
  }
  return t("report.confidenceLow");
}

export function formatEvidenceValue(
  evidence: CheckEvidence,
  language: Language,
  siblings: readonly CheckEvidence[] = [],
): string {
  // REPORT_V3_BRIEF red line 3 (shared with the Markdown renderer): metrics
  // annualized over short windows must never be presented in annualized form.
  const suppression = shortWindowSuppression(evidence, siblings);
  if (suppression !== undefined) {
    return language.startsWith("zh")
      ? `不予年化呈现（样本 ${suppression.windowTradingDays} 个交易日）`
      : `not annualized (window of ${suppression.windowTradingDays} trading days)`;
  }
  if (typeof evidence.value !== "number") {
    return String(evidence.value);
  }
  const metric = evidence.metric.toLowerCase();
  const unit = evidence.unit.toLowerCase();
  if (
    /(return|rate|delta|share|drawdown|erosion|retention)/u.test(metric) &&
    !metric.includes("sharpe")
  ) {
    return new Intl.NumberFormat(language, {
      maximumFractionDigits: 1,
      style: "percent",
    }).format(evidence.value);
  }
  if (unit.includes("count") || unit.includes("day") || unit === "years") {
    return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(evidence.value);
  }
  if (unit.includes("times per year")) {
    return `${formatNumber(evidence.value, language)}×`;
  }
  return formatNumber(evidence.value, language);
}

export function formatClaimValue(value: number, percent: boolean, language: Language): string {
  return percent
    ? new Intl.NumberFormat(language, { maximumFractionDigits: 1, style: "percent" }).format(value)
    : new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
}

export function claimGapLabel(
  t: TranslationFunction,
  gap: number,
  percent: boolean,
  language: Language,
): string {
  const value = percent
    ? `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(Math.abs(gap) * 100)} pp`
    : new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(Math.abs(gap));
  if (Math.abs(gap) < 0.000_001) {
    return t("report.claimMatched");
  }
  return t(gap > 0 ? "report.claimOverstated" : "report.claimUnderstated", { value });
}

export function formatDateTime(value: string, language: Language): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function formatNumber(value: number, language: Language): string {
  return new Intl.NumberFormat(language, {
    maximumFractionDigits: Math.abs(value) >= 100 ? 1 : 3,
  }).format(value);
}
