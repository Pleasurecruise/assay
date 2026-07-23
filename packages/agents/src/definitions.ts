import type { AgentDefinition } from "@assay/agent-runtime";
import type { AuditCheckId } from "@assay/contracts";

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
missingEvidence 至少一项。
`.trim();

const checkPrompts: Readonly<Record<AuditCheckId, string>> = {
  "param-robustness": `
你负责参数稳健性检查。使用回测工具执行参数邻域扰动和时间窗平移，比较原点与邻域表现，
识别过拟合和对历史起点的敏感性。不要评价数据可得性、交易成本、市场环境或因子同质化。
`.trim(),
  "data-availability": `
你负责数据可得性检查。逐历史时点核对股票池、可交易状态和财务信息可得时间，识别幸存者
偏差、前视偏差和披露时点缺口。不要执行参数扰动、成本压力、市场环境或同质化分析。
`.trim(),
  "cost-stress": `
你负责交易成本压力测试。使用回测工具按常规费率、冲击成本和悲观情形分档重跑，测算换手
侵蚀与收益归零临界点。不要评价参数稳健性、数据时点、市场环境或因子同质化。
`.trim(),
  "regime-dependency": `
你负责市场环境依赖分析。使用无前视的趋势、波动率和风格划分，对各环境分别统计表现并判断
收益是否集中在少数环境。不要执行参数扰动、数据时点审查、成本压力或同质化分析。
`.trim(),
  "homogeneity-decay": `
你负责同质化与衰减分析。计算信号与平台因子库的相关性，并按年份测算 IC/RankIC 及其衰减，
判断增量信息和拥挤失效迹象。不要评价参数、数据时点、交易成本或市场环境。
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

export const auditCheckAgentDefinitions: readonly AgentDefinition[] = (
  Object.keys(checkPrompts) as AuditCheckId[]
).map((id) => ({
  id,
  name: checkNames[id],
  description: checkPrompts[id],
  thinkingLevel: highThinkingChecks.has(id) ? high : medium,
  systemPrompt: [sharedGuardrails, checkPrompts[id]],
}));

export const agentDefinitions = auditCheckAgentDefinitions;
