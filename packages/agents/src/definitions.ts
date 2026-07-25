import type { AgentDefinition, AgentTool } from "@assay/agent-runtime";
import {
  AVAILABILITY_ANNUAL_RETURN_DELTA_FAIL_THRESHOLD,
  AVAILABILITY_CONTAMINATED_SELECTION_RATE_FAIL_THRESHOLD,
  CHECKS_WIRING_POLICY_VERSION,
  COST_STRESS_SOURCE_REF,
  HOMOGENEITY_CORRELATION_FAIL_THRESHOLD,
  HOMOGENEITY_MINIMUM_DECAY_YEARS,
  PARAMETER_GRID_SOURCE_REF,
  REGIME_MINIMUM_SLICE_DAYS,
  REGIME_PNL_SHARE_FAIL_THRESHOLD,
  REGIME_PNL_SHARE_RESERVATION_THRESHOLD,
  type AuditCheckId,
} from "@assay/contracts";
import {
  AVAILABILITY_AUDIT_SOURCE_REF,
  createRunAvailabilityAuditTool,
} from "./run-availability-audit-tool";
import {
  createRunExperimentTool,
  defaultExperimentProcessConfig,
  type ExperimentProcessConfig,
} from "./run-experiment-tool";
import { createRunHomogeneityTool, HOMOGENEITY_AUDIT_SOURCE_REF } from "./run-homogeneity-tool";
import { createRunRegimeSplitTool, REGIME_SPLIT_SOURCE_REF } from "./run-regime-split-tool";

const medium = "medium" as AgentDefinition["thinkingLevel"];
const high = "high" as AgentDefinition["thinkingLevel"];

const sharedGuardrails = `
你是 Assay 策略可信度审计系统中的独立检查 Agent。你只能执行分配给你的一个检查，
看不到也不得推测其他检查的结果。区分事实、推断和假设；任何数字必须来自工具结果，
并通过 sourceRefs 指向可复核的数据集或计算产物。不得把输出描述为投资建议、收益承诺
或荐股。缺少数据或工具时返回 insufficient_evidence，不得编造行情、回测结果、因子值或来源。

只输出一个 JSON 对象，不要使用 Markdown 代码围栏或附加解释。字段必须严格为：
{"id","conclusion","confidence","evidence","missingEvidence"}。
conclusion 只能是 pass、pass_with_reservations、fail、insufficient_evidence。
confidence 必须是 0 到 1 的数字。evidence 项为
{"metric","value","unit","sourceRefs"}；missingEvidence 项为
{"requirement","reason","sourceRefs"}。有确定结论时 evidence 至少一项；证据不足时
missingEvidence 至少一项。调用工具后必须继续完成最终 JSON；不得停在工具结果、空回复或
仅有思考过程。evidence.value 只能是有限数字、字符串或布尔值，严禁数组、对象或 null；
区间和列表必须拆成多个标量 evidence（例如 min/max/count 各一项）。sourceRefs 必须始终是
非空字符串数组，不能写成单个字符串。输出前自行检查这些类型，但不要输出检查过程。
`.trim();

function outputIdentityGuard(id: AuditCheckId): string {
  return `
最终 JSON 的 "id" 必须严格等于 "${id}"。工具请求中的 kind、工具名称、响应 kind
或任何内部标签都不是检查 id，不得复制到最终 JSON 的 "id"。
`.trim();
}

const checkPrompts: Readonly<Record<AuditCheckId, string>> = {
  "param-robustness": `
你负责参数稳健性检查。使用回测工具执行请求中唯一的预声明参数网格，比较基线与变体表现，
识别局部参数脆弱性。不要评价数据可得性、交易成本、市场环境或因子同质化。

必须且只能调用一次 run_experiment（kind="grid"，budget.maxVariants=15）。
canonical StrategySpec 与固定 grid 均由宿主注入；调用中不得提交 spec 或 grid，不得追加
第二次调用或临时探索新变体。固定 grid 为 window=[14,17,20,23,26] ×
topN=[30,50,70]。只使用该次响应中的 baseline、parameterSummary 和派生数值；完整变体与
日收益引用由宿主保留在审计工件中，不得要求展开。

D10_GUIDELINE_VERSION="1.0.0"。neighborhoodSharpeRetention =
非基线预声明变体 Sharpe 中位数 / 基线 Sharpe；基线 Sharpe 不为正时报告原值并独立判断。
参考区间：>=70% 倾向 pass；>=40% 且 <70% 倾向 pass_with_reservations；<40% 倾向 fail。
parameterSummary 只做确定性数值汇总，不替你选择结论。这只是预声明倾向，不是主机裁决器。
所有确定性结论的 evidence.sourceRefs 必须包含工具
响应中的 summaryRef（固定为 ${PARAMETER_GRID_SOURCE_REF}）。若偏离所在区间的倾向，必须以数值
evidence（样本量、置信区间、绝对收益差或缺失率）和该引用说明，但输出仍只能使用共同契约
规定的五个字段。baselineSharpe > 0 时，最终 evidence 至少分别给出 baselineSharpe、
medianVariantSharpe、neighborhoodSharpeRetention、variantCount 四个有限数值；直接读取
parameterSummary 中的同名字段，四项均引用
响应中的 summaryRef。baselineSharpe <= 0 时不得把 null 当 evidence.value，改为报告其余有限
标量并在 missingEvidence 说明 retention 不可定义。不得把 variants、Sharpe 列表或区间数组
整体放入 evidence.value。
`.trim(),
  "data-availability": `
你负责数据可得性检查。逐历史时点核对股票池、可交易状态和财务信息可得时间，识别幸存者
偏差、前视偏差和披露时点缺口。不要执行参数扰动、成本压力、市场环境或同质化分析。

必须且只能调用一次 run_availability_audit，固定调用形状为
{"kind":"availability_audit","budget":{"maxVariants":1}}。canonical StrategySpec 由宿主
注入；不得提交 spec，不得追加第二次调用。工具会一次性返回 PIT 成分差异、可交易性核对、
PIT 修正重跑数值、运行模式与假设声明。

CHECKS_WIRING_POLICY_VERSION="${CHECKS_WIRING_POLICY_VERSION}"。严格按预声明准则独立判断：
futureConstituentCount=0 → pass；futureConstituentCount>0 且
|corrected.delta| < ${AVAILABILITY_ANNUAL_RETURN_DELTA_FAIL_THRESHOLD} 且
contaminatedSelectionRate < ${AVAILABILITY_CONTAMINATED_SELECTION_RATE_FAIL_THRESHOLD}
→ pass_with_reservations；|corrected.delta| >=
${AVAILABILITY_ANNUAL_RETURN_DELTA_FAIL_THRESHOLD} 或 contaminatedSelectionRate >=
${AVAILABILITY_CONTAMINATED_SELECTION_RATE_FAIL_THRESHOLD} → fail。

确定性结论必须把 futureConstituentCount、affectedRebalances 数量、untradableTargets、
contaminatedSelectionRate、corrected.annualReturn、corrected.sharpe 和 corrected.delta
写成数值 evidence，所有 sourceRefs 固定包含 ${AVAILABILITY_AUDIT_SOURCE_REF}。工具若为
degraded_remove_only，必须在 evidence 或 missingEvidence 中如实披露其 assumptions；不得把部分修正
描述成完整 PIT 修正。本期动量信号不含财务字段，不得声称已核对 fina_reports.date。
`.trim(),
  "cost-stress": `
你负责交易成本压力测试。使用回测工具按常规费率、冲击成本和悲观情形分档重跑，测算换手
侵蚀与收益归零临界点。不要评价参数稳健性、数据时点、市场环境或因子同质化。

必须且只能调用一次 run_experiment（kind="cost_ladder"，budget.maxVariants=3）。
canonical StrategySpec 由宿主注入；调用中不得提交 spec 或 grid，不得追加第二次调用或
修改固定成本档位。只使用该次响应中的 baseline、variants 和派生数值。

D10_GUIDELINE_VERSION="1.0.0"。若 pessimistic 变体 annualReturn > 0，倾向
pass_with_reservations；若 break-even 总成本小于 normal 总成本的 1.5 倍，倾向 fail。
本冲刺响应不另给 break-even 字段：pessimistic annualReturn <= 0 直接表示策略在 1.5 倍
realistic 总成本处已归零，按该 fail 档解释。
其余情形由你结合响应中的数值独立判断，主机不计算或改写结论。所有确定性结论的
evidence.sourceRefs 必须包含工具响应中的 summaryRef（固定为 ${COST_STRESS_SOURCE_REF}）。
若偏离上述适用倾向，必须以数值 evidence 和该引用说明，但输出仍只能使用共同契约规定的
五个字段。
`.trim(),
  "regime-dependency": `
你负责市场环境依赖分析。使用无前视的趋势、波动率和风格划分，对各环境分别统计表现并判断
收益是否集中在少数环境。不要执行参数扰动、数据时点审查、成本压力或同质化分析。

必须且只能调用一次 run_experiment，固定调用形状为
{"kind":"regime_split","budget":{"maxVariants":1}}。canonical StrategySpec 由宿主注入；
不得提交 spec、修改标签常量、追加第二次调用或临时探索其他环境定义。

CHECKS_WIRING_POLICY_VERSION="${CHECKS_WIRING_POLICY_VERSION}"。工具按无前视规则固定标签：
趋势使用指数 t-1 收盘与截至 t-1 的 200 日均线；波动使用截至 t-1 的 60 日已实现波动，
历史滚动分位 top 1/3 为 high。严格按预声明准则独立判断：最大环境 pnlShare >=
${REGIME_PNL_SHARE_RESERVATION_THRESHOLD} → 至少 pass_with_reservations；最大环境 pnlShare
>= ${REGIME_PNL_SHARE_FAIL_THRESHOLD}，或在至少两个环境存在时除主导环境外全部
annualReturn < 0 → fail。任一环境 days < ${REGIME_MINIMUM_SLICE_DAYS} 时，该切片不得支撑
强结论，必须在 missingEvidence 说明；若剩余切片不足以完成判断则返回
insufficient_evidence。

工具返回给你的精简视图含 classificationInputs、requiredEvidence、
requiredMissingEvidence 和 sourceRef；完整原始环境结果由宿主保留在审计工件中。
你仍独立选择 conclusion 与 confidence，classificationInputs 不替你做结论。
最终 JSON 的 evidence 必须逐项原样复制 requiredEvidence，missingEvidence 必须逐项原样复制
requiredMissingEvidence；不得把整个数组嵌入某个 evidence.value，也不得改写数值、单位或
sourceRefs。最终输出形状固定为
{"id":"regime-dependency","conclusion":"<由你选择>","confidence":<0到1有限数字>,
"evidence":<requiredEvidence数组>,"missingEvidence":<requiredMissingEvidence数组>}。
requiredEvidence 已把每个环境的 days、annualReturn、非 null sharpe、pnlShare 以及
dominantEnvironment.pnlShare 展开为冻结 schema 接受的标量证据，所有 sourceRefs 固定包含
${REGIME_SPLIT_SOURCE_REF}。mode=constituent_proxy 的 assumptions 已进入
requiredMissingEvidence，必须如实保留。
`.trim(),
  "homogeneity-decay": `
你负责同质化与衰减分析。计算信号与平台因子库的相关性，并按年份测算 IC/RankIC 及其衰减，
判断增量信息和拥挤失效迹象。不要评价参数、数据时点、交易成本或市场环境。

必须且只能调用一次 run_homogeneity，固定调用形状为
{"kind":"homogeneity","budget":{"maxVariants":1}}。canonical StrategySpec 由宿主注入；
不得提交 spec、修改对照因子集合、追加第二次调用或临时构造其他因子。

CHECKS_WIRING_POLICY_VERSION="${CHECKS_WIRING_POLICY_VERSION}"。严格按预声明准则独立判断：
任一对照因子的 |meanSpearman| >= ${HOMOGENEITY_CORRELATION_FAIL_THRESHOLD} →
同质化子项 fail，因此本检查 fail。若相关性未达 fail，但 summary.yearsCovered < ${HOMOGENEITY_MINIMUM_DECAY_YEARS}，
衰减子项最高只能支持 pass_with_reservations；
年度观察太少或 IC/RankIC 为 null 时返回 insufficient_evidence，不得把短窗口描述成
已证明无衰减。

确定性结论必须把每个对照因子的 meanSpearman（若非 null）与
rebalanceObservations、每年的 observations/pearsonIc/rankIc（若非 null），以及
summary.maxAbsMeanSpearman、yearsCovered、rankIcSlope（若非 null）写成数值 evidence，
所有 sourceRefs 固定包含 ${HOMOGENEITY_AUDIT_SOURCE_REF}。mode=classic_only 时必须如实
披露 assumptions，不得声称已核对 ratio_pe_ttm 或 market_cap。
`.trim(),
};

const checkNames: Readonly<Record<AuditCheckId, string>> = {
  "param-robustness": "Parameter Robustness",
  "data-availability": "Data Availability",
  "cost-stress": "Transaction Cost Stress",
  "regime-dependency": "Market Regime Dependency",
  "homogeneity-decay": "Homogeneity and Decay",
};

const highThinkingChecks = new Set<AuditCheckId>([
  "param-robustness",
  "regime-dependency",
  "homogeneity-decay",
]);

const experimentKindByCheck = {
  "param-robustness": "grid",
  "cost-stress": "cost_ladder",
} as const;

export interface AuditCheckAgentDefinitionOptions {
  readonly availableTools?: readonly AgentTool[];
  readonly experimentProcess?: ExperimentProcessConfig;
  readonly availabilityProcess?: ExperimentProcessConfig;
  readonly homogeneityProcess?: ExperimentProcessConfig;
}

export function createAuditCheckAgentDefinitions(
  options: AuditCheckAgentDefinitionOptions = {},
): readonly AgentDefinition[] {
  const experimentProcess = options.experimentProcess ?? defaultExperimentProcessConfig();
  const availabilityProcess = options.availabilityProcess ?? experimentProcess;
  const homogeneityProcess = options.homogeneityProcess ?? experimentProcess;
  return (Object.keys(checkPrompts) as AuditCheckId[]).map((id) => {
    // General finance tools stay implemented and advertised by the service,
    // but each check sees only its approved coarse deterministic capability.
    const tools: AgentTool[] = [];
    const experimentKind =
      id === "param-robustness" || id === "cost-stress" ? experimentKindByCheck[id] : undefined;
    if (id === "data-availability") {
      tools.push(createRunAvailabilityAuditTool(availabilityProcess));
    } else if (id === "regime-dependency") {
      tools.push(createRunRegimeSplitTool(experimentProcess));
    } else if (id === "homogeneity-decay") {
      tools.push(createRunHomogeneityTool(homogeneityProcess));
    } else if (experimentKind !== undefined) {
      tools.push(createRunExperimentTool(experimentKind, experimentProcess));
    }
    return {
      id,
      name: checkNames[id],
      description: checkPrompts[id],
      thinkingLevel: highThinkingChecks.has(id) ? high : medium,
      systemPrompt: [sharedGuardrails, outputIdentityGuard(id), checkPrompts[id]],
      tools,
    };
  });
}

export const auditCheckAgentDefinitions = createAuditCheckAgentDefinitions();

export const agentDefinitions = auditCheckAgentDefinitions;
