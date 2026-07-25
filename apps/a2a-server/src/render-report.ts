/**
 * Deterministic bilingual Markdown projection of a validated AuditArtifact
 * (REPORT_V3_BRIEF Blocks A1–A6). Every number is quoted or display-rounded
 * from the Artifact JSON via the shared report-core rules — no model output
 * and no new fact enters at render time, so the Markdown can never disagree
 * with the DataPart.
 */
import {
  CHECK_TERMS,
  CONCLUSION_TERMS_ZH,
  VERDICT_TERMS,
  confidenceLevelZh,
  deriveVerdictRationale,
  formatDecimal,
  formatEvidenceValueZh,
  formatPercentZh,
  formatSignedDecimal,
  formatSignedPp,
  metricLabelZh,
  parseMoireRefinement,
  recoveryScopeLabelZh,
  selectKeyEvidence,
  type AuditArtifact,
  type AuditArtifactResult,
  type AuditCheckResult,
  type ClaimComparison,
} from "@assay/contracts";

const ROUNDING_FOOTNOTE =
  "> 注：表内数值为显示舍入；精确值以 JSON DataPart 为准，可逐位复算。Values are display-rounded; the JSON DataPart is authoritative.";

/**
 * A5 — deterministic one-directional statements, keyed by check. Only checks
 * whose metric is monotonic (more evidence can only hold or worsen the grade)
 * may appear here; the renderer never infers directionality at runtime.
 */
const DIRECTIONAL_NOTES_ZH: Readonly<Partial<Record<AuditCheckResult["id"], string>>> = {
  "homogeneity-decay": "该缺口补齐后，定档只会持平或更差，不会更好。",
};

const SCOPE_STATEMENT = [
  "本审计依据预声明判据执行：判据与阈值在检查运行前冻结，fail 优先定档，检查结论权属于五个相互独立的检查程序，偏离判据必须署名披露。",
  "复算与回测实现独立于申报方；与申报同源的数据是控制变量而非缺陷——先复现，再扰动。",
  "本报告有效性以溯源节标注的数据快照与冻结策略为界，两者任一变更即触发复审。",
  "",
  "This audit follows pre-declared criteria frozen before any check ran, with fail-first grading and independent per-check conclusions. The reproduction is implementation-independent from the submitter; sharing the submitter's data source is the control variable, not a defect. The report is valid only for the data snapshot and frozen strategy recorded in Provenance.",
].join("\n");

function appendList(
  lines: string[],
  heading: string,
  entries: readonly string[] | undefined,
): void {
  if (entries === undefined || entries.length === 0) {
    return;
  }
  lines.push("", `## ${heading}`, "", ...entries.map((entry) => `- ${entry}`));
}

function appendSubList(lines: string[], label: string, entries: readonly string[]): void {
  if (entries.length === 0) {
    return;
  }
  lines.push(`**${label}**`, "", ...entries.map((entry) => `- ${entry}`), "");
}

function formatArtifactConfidence(confidence: number | null): string {
  return confidence === null
    ? "暂缺 not available"
    : `${confidence.toFixed(2)}（${confidenceLevelZh(confidence)}）`;
}

interface ClaimRow {
  readonly label: string;
  readonly claimed: number | undefined;
  readonly reproduced: number;
  readonly gap: number | undefined;
  readonly percent: boolean;
}

function claimRows(comparison: ClaimComparison): readonly ClaimRow[] {
  return [
    {
      label: "年化收益 Annual return",
      claimed: comparison.claimed.annualReturn,
      reproduced: comparison.reproduced.annualReturn,
      gap: comparison.gaps.annualReturn,
      percent: true,
    },
    {
      label: "夏普 Sharpe",
      claimed: comparison.claimed.sharpe,
      reproduced: comparison.reproduced.sharpe,
      gap: comparison.gaps.sharpe,
      percent: false,
    },
    {
      label: "最大回撤 Max drawdown",
      claimed: comparison.claimed.maxDrawdown,
      reproduced: comparison.reproduced.maxDrawdown,
      gap: comparison.gaps.maxDrawdown,
      percent: true,
    },
  ];
}

function renderClaimComparison(lines: string[], comparison: ClaimComparison): void {
  lines.push(
    "",
    "## 二、申报与复算 Claims vs. Reproduction",
    "",
    "| 指标 Metric | 申报 Claimed | 复算 Reproduced | 偏差 Gap（申报 − 复算） |",
    "| --- | ---: | ---: | ---: |",
  );
  const rows = claimRows(comparison);
  for (const row of rows) {
    const claimed =
      row.claimed === undefined
        ? "未申报 not claimed"
        : row.percent
          ? formatPercentZh(row.claimed)
          : formatDecimal(row.claimed, 2);
    const reproduced = row.percent
      ? formatPercentZh(row.reproduced)
      : formatDecimal(row.reproduced, 2);
    const gap =
      row.claimed === undefined || row.gap === undefined
        ? "—"
        : row.percent
          ? formatSignedPp(row.gap)
          : formatSignedDecimal(row.gap, 2);
    lines.push(`| ${row.label} | ${claimed} | ${reproduced} | ${gap} |`);
  }
  lines.push("", ROUNDING_FOOTNOTE);
  if (rows.some((row) => row.claimed === undefined)) {
    lines.push(
      "",
      "申报口径不完整：上表中「未申报」的指标未由申报方提供，这本身构成一项证据缺口。",
    );
  }
  if (comparison.knownConventionDiffs.length > 0) {
    lines.push(
      "",
      "**已知口径差异 Known convention differences**",
      "",
      ...comparison.knownConventionDiffs.map((entry) => `- ${entry}`),
    );
  }
}

function renderCheck(lines: string[], check: AuditCheckResult, ordinal: number): void {
  const term = CHECK_TERMS[check.id];
  const effective = parseMoireRefinement(check)?.effectiveConclusion ?? check.conclusion;
  lines.push(
    "",
    `### ${ordinal}. ${term.zh} ${term.en} —— ${CONCLUSION_TERMS_ZH[effective]}（置信度 ${
      check.confidence === null ? "暂缺" : check.confidence.toFixed(2)
    }）`,
    "",
    `> 检查问题：${term.questionZh}`,
    "",
  );
  const keyEvidence = selectKeyEvidence(check);
  for (const evidence of keyEvidence) {
    lines.push(
      `- ${metricLabelZh(evidence.metric)}：${formatEvidenceValueZh(evidence, check.evidence)}（\`${evidence.metric}\`，源 ${evidence.sourceRefs.join(", ")}）`,
    );
  }
  for (const missing of check.missingEvidence) {
    lines.push(
      `- 缺失证据 Missing：${missing.requirement} — ${missing.reason}（${missing.sourceRefs.join(", ")}）`,
    );
  }
  if (effective === "insufficient_evidence") {
    const note = DIRECTIONAL_NOTES_ZH[check.id];
    if (note !== undefined) {
      lines.push(`- 方向性说明：${note}`);
    }
  }
  if (check.refinedByMoire !== undefined) {
    lines.push(`- Moiré 复核：${check.refinedByMoire}`);
  }
  const keyMetricNames = new Set(keyEvidence.map((evidence) => evidence.metric));
  const remaining = check.evidence.filter((evidence) => !keyMetricNames.has(evidence.metric));
  if (remaining.length > 0) {
    lines.push(
      "",
      "<details>",
      `<summary>全部证据 All evidence（另 ${remaining.length} 项）</summary>`,
      "",
      ...remaining.map(
        (evidence) =>
          `- \`${evidence.metric}\` = ${formatEvidenceValueZh(evidence, check.evidence)}（原始值 ${String(evidence.value)} ${evidence.unit}，源 ${evidence.sourceRefs.join(", ")}）`,
      ),
      "",
      "</details>",
    );
  }
}

function renderResultBody(
  lines: string[],
  artifact: AuditArtifact,
  result: AuditArtifactResult,
): void {
  const rationale = deriveVerdictRationale(result);
  const verdictTerm = VERDICT_TERMS[result.verdict];
  lines.push(
    "",
    "## 一、审计结论 Verdict",
    "",
    `> **${result.verdict}（${verdictTerm.zhShort}）—— ${verdictTerm.zhTitle}**`,
    `> ${verdictTerm.enTitle}`,
    ">",
    `> 置信度 Confidence：${formatArtifactConfidence(result.confidence)}`,
    "",
    `**定档依据 Rationale**：${rationale.zh}`,
    "",
    `*${rationale.en}*`,
    "",
    `**结论摘要 Summary**：${result.summary}`,
  );
  if (result.reasonCode !== undefined) {
    lines.push("", `提前退出原因 Early-exit reason：\`${result.reasonCode}\``);
  }
  appendList(
    lines,
    "缺失信息 Missing Information",
    result.missingInformation?.map(
      (item) => `${item.requirement} — ${item.reason}（${item.sourceRefs.join(", ")}）`,
    ),
  );

  if (artifact.claimComparison !== null) {
    renderClaimComparison(lines, artifact.claimComparison);
  }

  const executed = result.checks.some((check) => check.conclusion !== "not_applicable");
  if (executed) {
    lines.push(
      "",
      "## 三、五项检查 Findings",
      "",
      "每项检查的判据在执行前预声明；关键证据与全部证据一并披露，偏离判据须署名。",
    );
    result.checks.forEach((check, index) => {
      renderCheck(lines, check, index + 1);
    });
  }

  lines.push("", "## 四、恢复条件与复审触发 Recovery & Review", "", "本报告不提供操作建议。");
  if (result.recoveryConditions.length > 0) {
    lines.push("", "满足以下条件可申请复审：", "");
    for (const condition of result.recoveryConditions) {
      lines.push(`- **${recoveryScopeLabelZh(condition.scope)}**：${condition.condition}`);
    }
  } else {
    lines.push("", "本判定未定义定向恢复条件。");
  }
  if (result.reviewTriggers.length > 0) {
    lines.push(
      "",
      "以下事件自动触发复审：",
      "",
      ...result.reviewTriggers.map((entry) => `- ${entry}`),
    );
  }
}

function renderAppendix(
  lines: string[],
  artifact: AuditArtifact,
  result: AuditArtifactResult,
): void {
  lines.push("", "---", "", "## 附录 Appendix");

  if (result.strategySpec !== undefined) {
    lines.push(
      "",
      "<details>",
      "<summary>A. 冻结策略 Frozen StrategySpec</summary>",
      "",
      "```json",
      JSON.stringify(result.strategySpec, null, 2),
      "```",
      "",
    );
    appendSubList(lines, "应用默认值 Defaults applied", [...(result.defaultsApplied ?? [])]);
    appendSubList(lines, "解析假设 Parsing assumptions", [...(result.parsingAssumptions ?? [])]);
    lines.push("</details>");
  }

  lines.push(
    "",
    "**B. 证据与溯源 Provenance**",
    "",
    `- 输入哈希 Input hash：\`${artifact.provenance.inputHash}\``,
    `- 数据截至 Data as of：\`${artifact.provenance.dataAsOf}\``,
    `- 代码版本 Code revision：\`${artifact.provenance.codeRevision}\``,
    ...artifact.provenance.dataSources.map(
      (source) => `- 数据来源 Data source：\`${source.id}\` @ ${source.version}`,
    ),
    `- Moiré 判别：开启 ${result.moire.disputesOpened} 项矛盾实验，已消解 ${result.moire.resolved.length} 项，未消解 ${result.moire.unresolved.length} 项。`,
  );
  appendList(lines, "假设与边界 Assumptions and Limits", result.assumptionsAndLimits);
  lines.push("", "**C. 审计范围与独立性声明 Scope & Independence**", "", SCOPE_STATEMENT);
  appendList(lines, "风险披露 Risk Disclosure", artifact.riskDisclosure);
}

export function renderAuditArtifactMarkdown(artifact: AuditArtifact): string {
  const result = artifact.results[0];
  if (result === undefined) {
    throw new Error("A strategy audit Artifact must contain one result");
  }
  const lines = [
    "# Assay 策略审计报告 | Strategy Audit Report",
    "",
    `- 审计编号 Audit ID：\`${artifact.auditId}\``,
    `- 审计对象 Subject ID：\`${result.subjectId}\``,
    `- 数据截至 Data as of：\`${artifact.provenance.dataAsOf}\` · 代码版本 Code revision：\`${artifact.provenance.codeRevision}\``,
  ];
  renderResultBody(lines, artifact, result);
  renderAppendix(lines, artifact, result);
  return lines.join("\n");
}
