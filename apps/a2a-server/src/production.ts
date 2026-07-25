import { AgentRegistry, AgentRuntime, createRuntimeTimelineLogger } from "@assay/agent-runtime";
import {
  createAuditCheckAgentDefinitions,
  ParallelAuditCheckRunner,
  SubprocessMoireExperimentExecutor,
} from "@assay/agents";
import { createPandaDataTools, PandaDataProcessGateway } from "@assay/finance-tools";
import { ArkResponsesStrategyParser, StrategyIntake } from "@assay/intake";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ProductionA2AConfig } from "./configuration";
import { createExecutionTimelineLogger } from "./execution-timeline";
import { AssayAgentExecutor } from "./executor";
import { InMemoryAuditArtifactStore } from "./artifact-store";
import { SubprocessClaimReproducer } from "./claim-reproducer";
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
  const auditApiKeys = [...new Set([config.arkApiKey, ...(config.arkApiKeys ?? [])])];
  let nextAuditApiKey = 0;
  const runtime = new AgentRuntime({
    model,
    maxConcurrentModelCalls: 3,
    registry: new AgentRegistry(
      createAuditCheckAgentDefinitions({ availableTools: pandaDataTools }),
    ),
    getApiKey: () => {
      const apiKey = auditApiKeys[nextAuditApiKey % auditApiKeys.length] as string;
      nextAuditApiKey += 1;
      return apiKey;
    },
    onEvent: createRuntimeTimelineLogger(),
  });
  const runner = new ParallelAuditCheckRunner(runtime, {
    enableDiscriminativeMoire: true,
    moireExecutor: new SubprocessMoireExperimentExecutor(),
    moirePlanningContext: {
      // The independent cost-stress tool runs on the frozen as-of panel.
      // M2 alone is authorized to rerun the ladder on the PIT-corrected panel.
      costBaselineMode: "uncorrected",
    },
  });
  const executor = new AssayAgentExecutor({
    intake,
    runner,
    claimReproducer: new SubprocessClaimReproducer(),
    artifactStore: new InMemoryAuditArtifactStore(),
    dataAsOf: config.dataAsOf,
    codeRevision: config.codeRevision,
    executionTimelineLogger: createExecutionTimelineLogger(),
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
