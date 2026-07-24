import { canonicalizeStrategySpec, hashStrategySpec, type StrategySpec } from "@assay/contracts";

const RUN_EXPERIMENT_AUTHORIZATION_ERROR = "run_experiment is not authorized for this task";
const RUN_EXPERIMENT_CALL_LIMIT_ERROR = "run_experiment may be called at most once per task";
const RUN_EXPERIMENT_COMPLETION_ERROR = "run_experiment must complete successfully exactly once";

export interface RuntimeToolCallGuardResult {
  readonly runExperimentCallCount: number;
  readonly blockReason?: string;
}

/**
 * Apply task-scoped invariants before a tool reaches execution.
 *
 * The expected hash comes from the host's frozen audit metadata, never from
 * model text. Other tools pass through unchanged.
 */
export function guardRuntimeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  expectedSpecHash: string | undefined,
  trustedCanonicalSpec: string | undefined,
  runExperimentCallCount: number,
): RuntimeToolCallGuardResult {
  if (toolName !== "run_experiment") {
    return { runExperimentCallCount };
  }

  const nextCallCount = runExperimentCallCount + 1;
  if (runExperimentCallCount > 0) {
    return {
      runExperimentCallCount: nextCallCount,
      blockReason: RUN_EXPERIMENT_CALL_LIMIT_ERROR,
    };
  }
  if (
    expectedSpecHash === undefined ||
    !/^sha256:[a-f0-9]{64}$/i.test(expectedSpecHash) ||
    trustedCanonicalSpec === undefined
  ) {
    return {
      runExperimentCallCount: nextCallCount,
      blockReason: RUN_EXPERIMENT_AUTHORIZATION_ERROR,
    };
  }

  try {
    const trustedSpec = JSON.parse(trustedCanonicalSpec) as StrategySpec;
    const canonicalSpec = canonicalizeStrategySpec(trustedSpec);
    if (
      canonicalSpec !== trustedCanonicalSpec ||
      hashStrategySpec(canonicalSpec) !== expectedSpecHash
    ) {
      return {
        runExperimentCallCount: nextCallCount,
        blockReason: RUN_EXPERIMENT_AUTHORIZATION_ERROR,
      };
    }
    // Schema validation has already run. Bind the host-frozen object after
    // validation so the model neither copies nor controls StrategySpec.
    args.spec = trustedSpec;
  } catch {
    return {
      runExperimentCallCount: nextCallCount,
      blockReason: RUN_EXPERIMENT_AUTHORIZATION_ERROR,
    };
  }

  return { runExperimentCallCount: nextCallCount };
}

export function assertExactRunExperimentCompletion(
  required: boolean,
  attemptedCalls: number,
  successfulCalls: number,
): void {
  if (required && (attemptedCalls !== 1 || successfulCalls !== 1)) {
    throw new Error(RUN_EXPERIMENT_COMPLETION_ERROR);
  }
}
