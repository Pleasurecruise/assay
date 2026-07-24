import { AgentRegistry, AgentRuntime } from "@assay/agent-runtime";
import { createAuditCheckAgentDefinitions, ParallelAuditCheckRunner } from "@assay/agents";
import { createPandaDataTools, PandaDataProcessGateway } from "@assay/finance-tools";
import { ArkResponsesStrategyParser, StrategyIntake } from "@assay/intake";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ProductionA2AConfig } from "./configuration";
import { AssayAgentExecutor } from "./executor";
import { InMemoryAuditArtifactStore } from "./artifact-store";
import { createAssayA2AApp, type AssayA2AApp } from "./server";

export { readProductionConfig, type ProductionA2AConfig } from "./configuration";

export function createProductionA2AApp(config: ProductionA2AConfig): AssayA2AApp {
  const parser = new ArkResponsesStrategyParser({
    apiKey: config.arkApiKey,
    baseUrl: config.arkBaseUrl,
    model: config.arkModel,
  });
  const intake = new StrategyIntake({
    parser,
    dataAsOf: config.dataAsOf,
    capabilitySnapshotId: config.capabilitySnapshotId,
    codeRevision: config.codeRevision,
  });
  const model = buildModel({
    id: config.arkModel,
    requestModelId: config.arkModel,
    name: "Ark DeepSeek",
    api: "openai-responses",
    // Ark speaks the Responses wire protocol, but it is not the first-party
    // OpenAI provider. Keeping a distinct provider id prevents pi-ai from
    // sending OpenAI-only fields such as stream_options.
    provider: "volcengine-ark",
    baseUrl: config.arkBaseUrl,
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
  const pandaDataGateway = new PandaDataProcessGateway();
  const pandaDataTools = createPandaDataTools(pandaDataGateway);
  const runtime = new AgentRuntime({
    model,
    registry: new AgentRegistry(
      createAuditCheckAgentDefinitions({ availableTools: pandaDataTools }),
    ),
    getApiKey: () => config.arkApiKey,
  });
  const runner = new ParallelAuditCheckRunner(runtime);
  const executor = new AssayAgentExecutor({
    intake,
    runner,
    artifactStore: new InMemoryAuditArtifactStore(),
    dataAsOf: config.dataAsOf,
    codeRevision: config.codeRevision,
  });
  return createAssayA2AApp({
    executor,
    publicUrl: config.publicUrl,
    corsOrigins: config.corsOrigins,
    capabilities: {
      skill: "audit_strategy",
      dataProvider: "PandaData",
      dataTools: pandaDataTools.map((tool) => tool.name),
      backtester: "assay-backtester@1",
      dataCredentialsConfigured: config.pandaDataConfigured,
    },
  });
}
