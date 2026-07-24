import { AgentRegistry, AgentRuntime } from "@assay/agent-runtime";
import { agentDefinitions, ParallelAuditCheckRunner } from "@assay/agents";
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
    provider: "openai",
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
  const runtime = new AgentRuntime({
    model,
    registry: new AgentRegistry(agentDefinitions),
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
    corsOrigin: config.corsOrigin,
  });
}
