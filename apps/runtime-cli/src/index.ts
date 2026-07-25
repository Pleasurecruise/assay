import { AgentRegistry, AgentRuntime } from "@assay/agent-runtime";
import { createAuditCheckAgentDefinitions, type ExperimentProcessConfig } from "@assay/agents";
import {
  AUDIT_CHECK_IDS,
  canonicalizeStrategySpec,
  hashStrategySpec,
  parseAuditCheckResult,
  parseStrategySpec,
  type AuditCheckId,
} from "@assay/contracts";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const modelId = process.env.ARK_MODEL_DEEPSEEK?.trim();
const apiKey = process.env.ARK_API_KEY?.trim();
const input = process.argv.slice(2).join(" ").trim();

if (!input) {
  throw new Error('Usage: bun run runtime -- "your research task"');
}
if (!apiKey) {
  throw new Error("ARK_API_KEY is required");
}
if (!modelId) {
  throw new Error("ARK_MODEL_DEEPSEEK is required");
}

const model = buildModel({
  id: modelId,
  requestModelId: modelId,
  name: "Volcano Ark smoke model",
  api: "openai-responses",
  provider: "volcengine-ark",
  baseUrl: process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 64_000,
  maxTokens: 8_192,
});

const agentId = process.env.ASSAY_AGENT_ID ?? "param-robustness";
if (!AUDIT_CHECK_IDS.some((candidate) => candidate === agentId)) {
  throw new Error(`ASSAY_AGENT_ID "${agentId}" is not a canonical audit check`);
}
const auditCheckId = agentId as AuditCheckId;
const toolFixture = process.env.ASSAY_TOOL_FIXTURE?.trim();
const fixtureProcess: ExperimentProcessConfig | undefined =
  toolFixture === undefined || toolFixture.length === 0
    ? undefined
    : {
        command: process.execPath,
        args: [toolFixture],
      };
const definitions =
  fixtureProcess === undefined
    ? createAuditCheckAgentDefinitions()
    : createAuditCheckAgentDefinitions({
        experimentProcess: fixtureProcess,
        availabilityProcess: fixtureProcess,
        homogeneityProcess: fixtureProcess,
      });
const frozenSpecInput = process.env.ASSAY_FROZEN_STRATEGY_SPEC_JSON?.trim();
const dataRef = process.env.ASSAY_DATA_REF?.trim();
const metadata =
  frozenSpecInput === undefined || frozenSpecInput.length === 0
    ? undefined
    : (() => {
        if (dataRef === undefined || dataRef.length === 0) {
          throw new Error("ASSAY_DATA_REF is required with ASSAY_FROZEN_STRATEGY_SPEC_JSON");
        }
        let rawSpec: unknown;
        try {
          rawSpec = JSON.parse(frozenSpecInput);
        } catch {
          throw new Error("ASSAY_FROZEN_STRATEGY_SPEC_JSON must contain valid JSON");
        }
        const spec = parseStrategySpec(rawSpec);
        const frozenStrategySpec = canonicalizeStrategySpec(spec);
        return {
          frozenStrategySpec,
          specHash: hashStrategySpec(frozenStrategySpec),
          dataRef,
        };
      })();
const runtime = new AgentRuntime({
  model,
  registry: new AgentRegistry(definitions),
  getApiKey: () => apiKey,
  onEvent: (event) => {
    if (event.type === "agent.delta") {
      process.stdout.write(event.delta);
    }
  },
});

const result = await runtime.run({
  agentId: auditCheckId,
  input,
  ...(metadata === undefined ? {} : { metadata }),
});

const unfencedOutput = result.output
  .trim()
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/, "")
  .trim();
if (!unfencedOutput) {
  throw new Error(`${auditCheckId} completed without a contract JSON output`);
}
let parsedOutput: unknown;
try {
  parsedOutput = JSON.parse(unfencedOutput);
} catch {
  throw new Error(`${auditCheckId} completed with invalid contract JSON`);
}
parseAuditCheckResult(parsedOutput, auditCheckId);

if (!result.output.endsWith("\n")) {
  process.stdout.write("\n");
}
