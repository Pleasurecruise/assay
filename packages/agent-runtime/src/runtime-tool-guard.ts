import { canonicalizeStrategySpec, hashStrategySpec, type StrategySpec } from "@assay/contracts";

export const TRUSTED_SPEC_TOOL_NAMES = [
  "run_experiment",
  "run_availability_audit",
  "run_homogeneity",
] as const;

function isTrustedSpecTool(toolName: string): boolean {
  return TRUSTED_SPEC_TOOL_NAMES.some((candidate) => candidate === toolName);
}

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
  if (!isTrustedSpecTool(toolName)) {
    return { runExperimentCallCount };
  }

  const nextCallCount = runExperimentCallCount + 1;
  if (runExperimentCallCount > 0) {
    return {
      runExperimentCallCount: nextCallCount,
      blockReason: `${toolName} may be called at most once per task`,
    };
  }
  if (
    expectedSpecHash === undefined ||
    !/^sha256:[a-f0-9]{64}$/i.test(expectedSpecHash) ||
    trustedCanonicalSpec === undefined
  ) {
    return {
      runExperimentCallCount: nextCallCount,
      blockReason: `${toolName} is not authorized for this task`,
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
        blockReason: `${toolName} is not authorized for this task`,
      };
    }
    // Schema validation has already run. Bind the host-frozen object after
    // validation so the model neither copies nor controls StrategySpec.
    args.spec = trustedSpec;
  } catch {
    return {
      runExperimentCallCount: nextCallCount,
      blockReason: `${toolName} is not authorized for this task`,
    };
  }

  return { runExperimentCallCount: nextCallCount };
}

export function assertExactRunExperimentCompletion(
  required: boolean,
  attemptedCalls: number,
  successfulCalls: number,
  toolName = "run_experiment",
): void {
  if (required && (attemptedCalls !== 1 || successfulCalls !== 1)) {
    throw new Error(`${toolName} must complete successfully exactly once`);
  }
}
