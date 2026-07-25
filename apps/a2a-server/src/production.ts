import { AgentRegistry, AgentRuntime, createRuntimeTimelineLogger } from "@assay/agent-runtime";
import {
  createAuditCheckAgentDefinitions,
  defaultExperimentProcessConfig,
  defaultMoireProcessConfig,
  ParallelAuditCheckRunner,
  SubprocessMoireExperimentExecutor,
  type ExperimentProcessConfig,
} from "@assay/agents";
import { ArkResponsesStrategyParser, StrategyIntake } from "@assay/intake";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ProductionA2AConfig } from "./configuration";
import { createExecutionTimelineLogger } from "./execution-timeline";
import { AssayAgentExecutor } from "./executor";
import { InMemoryAuditArtifactStore } from "./artifact-store";
import { createAssayAuth } from "./auth";
import { SubprocessClaimReproducer } from "./claim-reproducer";
import { AssayDatabase } from "./database";
import { LocalDataPackageError, LocalDataPackageResolver } from "./local-data-package";
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

function bindLocalDataRoots(
  config: ExperimentProcessConfig,
  auditOutputRoot: string,
  localDataPackageRoot: string,
): ExperimentProcessConfig {
  return {
    ...config,
    env: {
      ...config.env,
      ASSAY_AUDIT_OUTPUT_ROOT: auditOutputRoot,
      ASSAY_LOCAL_DATA_PACKAGE_ROOT: localDataPackageRoot,
    },
  };
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
  const experimentProcess = bindLocalDataRoots(
    defaultExperimentProcessConfig(),
    config.auditOutputRoot,
    config.localDataPackageRoot,
  );
  const moireProcess = bindLocalDataRoots(
    defaultMoireProcessConfig(),
    config.auditOutputRoot,
    config.localDataPackageRoot,
  );
  const runtime = new AgentRuntime({
    model,
    modelApiKeys: [config.arkApiKey],
    registry: new AgentRegistry(
      createAuditCheckAgentDefinitions({
        experimentProcess,
        availabilityProcess: experimentProcess,
        homogeneityProcess: experimentProcess,
      }),
    ),
    onEvent: createRuntimeTimelineLogger(),
  });
  const runner = new ParallelAuditCheckRunner(runtime, {
    enableDiscriminativeMoire: true,
    moireExecutor: new SubprocessMoireExperimentExecutor(moireProcess),
    moirePlanningContext: {
      // The independent cost-stress tool runs on the frozen as-of panel.
      // M2 alone is authorized to rerun the ladder on the PIT-corrected panel.
      costBaselineMode: "uncorrected",
    },
  });
  const dataResolver = new LocalDataPackageResolver({
    root: config.localDataPackageRoot,
  });
  let dataPackagesConfigured = false;
  try {
    await dataResolver.validateRegistry();
    dataPackagesConfigured = true;
  } catch (error) {
    if (!(error instanceof LocalDataPackageError)) {
      throw error;
    }
  }
  const executor = new AssayAgentExecutor({
    intake,
    runner,
    dataResolver,
    claimReproducer: new SubprocessClaimReproducer(experimentProcess),
    artifactStore: new InMemoryAuditArtifactStore(),
    dataAsOf: config.dataAsOf,
    codeRevision: config.codeRevision,
    executionTimelineLogger: createExecutionTimelineLogger(),
  });
  return createAssayA2AApp({
    executor,
    a2aBearerToken: config.a2aBearerToken,
    authService,
    database,
    publicUrl: config.publicUrl,
    corsOrigins: config.corsOrigins,
    capabilities: {
      skill: "audit_strategy",
      dataProvider: "LocalDataPackage",
      dataTools: [],
      backtester: "assay-backtester@1",
      dataPackagesConfigured,
    },
  });
}
