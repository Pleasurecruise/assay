import type { AuditCheckId, AuditCheckResult } from "@assay/contracts";

export interface MoireExperiment {
  id: string;
  checkId: AuditCheckId;
  instruction: string;
}

const instructions: Readonly<Record<AuditCheckId, string>> = {
  "param-robustness":
    "扩大参数邻域并平移回测起点；确认负面结论是否仍成立，报告最能区分稳健与过拟合的变体。",
  "data-availability":
    "抽查样本期早、中、晚三个历史截面；重新核对指数成分、可交易状态与信息披露时间。",
  "cost-stress": "补跑零成本、基准、悲观成本及盈亏平衡成本；确认结论不是单一费率假设造成的。",
  "regime-dependency": "执行逐环境留一检验；确认结论是否由单一市场环境或分段方式驱动。",
  "homogeneity-decay": "复核最近邻因子相关性与逐年 IC/RankIC 斜率；确认同质化或衰减结论能否复现。",
};

/**
 * Plans at most two verdict-changing follow-ups after the independent phase.
 * The follow-up agent receives only its own original result, never sibling evidence.
 */
export function planMoireExperiments(
  checks: readonly AuditCheckResult[],
): readonly MoireExperiment[] {
  const hasPositive = checks.some(
    (check) => check.conclusion === "pass" || check.conclusion === "pass_with_reservations",
  );
  if (!hasPositive) {
    return [];
  }

  return checks
    .filter(
      (check) =>
        check.conclusion === "fail" ||
        (check.conclusion === "pass_with_reservations" &&
          check.confidence !== null &&
          check.confidence < 0.75),
    )
    .sort((left, right) => {
      if (left.conclusion !== right.conclusion) {
        return left.conclusion === "fail" ? -1 : 1;
      }
      return (right.confidence ?? 0) - (left.confidence ?? 0);
    })
    .slice(0, 2)
    .map((check, index) => ({
      id: `moire-${index + 1}-${check.id}`,
      checkId: check.id,
      instruction: instructions[check.id],
    }));
}
