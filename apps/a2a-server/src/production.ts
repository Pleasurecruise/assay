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
import { createAssayAuth } from "./auth";
import { SubprocessClaimReproducer } from "./claim-reproducer";
import { AssayDatabase } from "./database";
import { createAssayA2AApp, type AssayA2AApp } from "./server";

export { readProductionConfig, type ProductionA2AConfig } from "./configuration";

type AuthEnabledProductionConfig = ProductionA2AConfig &
  Required<
    Pick<
      ProductionA2AConfig,
      "authBaseUrl" | "betterAuthSecret" | "databasePath" | "googleClientId" | "googleClientSecret"
    >
  >;

function hasCompleteAuthConfig(config: ProductionA2AConfig): config is AuthEnabledProductionConfig {
  return (
    config.authBaseUrl !== undefined &&
    config.betterAuthSecret !== undefined &&
    config.databasePath !== undefined &&
    config.googleClientId !== undefined &&
    config.googleClientSecret !== undefined
  );
}

export async function createProductionA2AApp(config: ProductionA2AConfig): Promise<AssayA2AApp> {
  const authConfigValues = [
    config.authBaseUrl,
    config.betterAuthSecret,
    config.databasePath,
    config.googleClientId,
    config.googleClientSecret,
  ];
  const hasAnyAuthConfig = authConfigValues.some((value) => value !== undefined);
  if (!hasCompleteAuthConfig(config) && hasAnyAuthConfig) {
    throw new Error("Production auth configuration must be provided completely or omitted");
  }
  const database = hasCompleteAuthConfig(config)
    ? new AssayDatabase(config.databasePath)
    : undefined;
  const authService =
    database === undefined || !hasCompleteAuthConfig(config)
      ? undefined
      : createAssayAuth(
          {
            baseUrl: config.authBaseUrl,
            secret: config.betterAuthSecret,
            trustedOrigins: config.corsOrigins,
            googleClientId: config.googleClientId,
            googleClientSecret: config.googleClientSecret,
          },
          database,
        );
  await authService?.initialize();
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
  const auditApiKeys = [
    ...new Set(
      [config.arkApiKey, ...(config.arkApiKeys ?? [])]
        .map((apiKey) => apiKey.trim())
        .filter((apiKey) => apiKey.length > 0),
    ),
  ].slice(0, 4);
  const runtime = new AgentRuntime({
    model,
    modelApiKeys: auditApiKeys,
    registry: new AgentRegistry(
      createAuditCheckAgentDefinitions({ availableTools: pandaDataTools }),
    ),
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
    authService,
    database,
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
