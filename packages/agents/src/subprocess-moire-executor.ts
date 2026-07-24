import { spawn } from "node:child_process";
import { canonicalizeStrategySpec, hashStrategySpec, type StrategySpec } from "@assay/contracts";
import type {
  DiscriminativeMoireExperiment,
  DiscriminativeMoireOutcome,
  M1MoireOutcome,
  M2MoireOutcome,
} from "./moire";
import type {
  MoireExperimentExecutionContext,
  MoireExperimentExecutor,
} from "./parallel-check-runner";
import {
  defaultExperimentProcessConfig,
  type ExperimentProcessConfig,
} from "./run-experiment-tool";

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const M1_RESULT_KEYS = [
  "id",
  "kind",
  "sourceRef",
  "dominantEnvironmentId",
  "dominantRetention",
  "otherEnvironmentRetentions",
] as const;
const M2_RESULT_KEYS = ["id", "kind", "sourceRef", "correctedCostConclusion"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Moiré subprocess ${path} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Moiré subprocess ${path} must be a finite number`);
  }
  return value;
}

function sourceRef(value: unknown, experimentId: "M1" | "M2"): string {
  const reference = nonEmptyString(value, "sourceRef");
  const expectedPattern = new RegExp(`^artifact:moire/${experimentId}/sha256-[a-f0-9]{64}$`, "u");
  if (!expectedPattern.test(reference)) {
    throw new Error(
      `Moiré subprocess sourceRef must be a content-addressed artifact:moire/${experimentId} reference`,
    );
  }
  return reference;
}

function parseM1(value: Record<string, unknown>): M1MoireOutcome {
  if (!hasExactKeys(value, M1_RESULT_KEYS)) {
    throw new Error(`Moiré M1 response must contain exactly ${M1_RESULT_KEYS.join(", ")}`);
  }
  if (value.id !== "M1" || value.kind !== "regime_slice_of_grid") {
    throw new Error("Moiré M1 response id and kind are invalid");
  }
  if (!Array.isArray(value.otherEnvironmentRetentions)) {
    throw new Error("Moiré M1 otherEnvironmentRetentions must be an array");
  }
  const seen = new Set<string>();
  const dominantEnvironmentId = nonEmptyString(
    value.dominantEnvironmentId,
    "dominantEnvironmentId",
  );
  const otherEnvironmentRetentions = value.otherEnvironmentRetentions.map((item, index) => {
    if (!isRecord(item) || !hasExactKeys(item, ["environmentId", "retention"])) {
      throw new Error(
        `Moiré M1 otherEnvironmentRetentions[${String(index)}] must contain exactly environmentId, retention`,
      );
    }
    const environmentId = nonEmptyString(
      item.environmentId,
      `otherEnvironmentRetentions[${String(index)}].environmentId`,
    );
    if (environmentId === dominantEnvironmentId || seen.has(environmentId)) {
      throw new Error("Moiré M1 environment ids must be unique");
    }
    seen.add(environmentId);
    return {
      environmentId,
      retention: finiteNumber(
        item.retention,
        `otherEnvironmentRetentions[${String(index)}].retention`,
      ),
    };
  });
  return {
    id: "M1",
    kind: "regime_slice_of_grid",
    sourceRef: sourceRef(value.sourceRef, "M1"),
    dominantEnvironmentId,
    dominantRetention: finiteNumber(value.dominantRetention, "dominantRetention"),
    otherEnvironmentRetentions,
  };
}

function parseM2(value: Record<string, unknown>): M2MoireOutcome {
  if (!hasExactKeys(value, M2_RESULT_KEYS)) {
    throw new Error(`Moiré M2 response must contain exactly ${M2_RESULT_KEYS.join(", ")}`);
  }
  if (value.id !== "M2" || value.kind !== "corrected_cost_ladder") {
    throw new Error("Moiré M2 response id and kind are invalid");
  }
  if (
    value.correctedCostConclusion !== "pass" &&
    value.correctedCostConclusion !== "pass_with_reservations" &&
    value.correctedCostConclusion !== "fail"
  ) {
    throw new Error("Moiré M2 correctedCostConclusion is invalid");
  }
  return {
    id: "M2",
    kind: "corrected_cost_ladder",
    sourceRef: sourceRef(value.sourceRef, "M2"),
    correctedCostConclusion: value.correctedCostConclusion,
  };
}

function parseOutcome(
  stdout: string,
  experiment: DiscriminativeMoireExperiment,
): DiscriminativeMoireOutcome {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Moiré subprocess returned invalid JSON");
  }
  if (!isRecord(value)) {
    throw new Error("Moiré subprocess response must be an object");
  }
  const outcome = experiment.id === "M1" ? parseM1(value) : parseM2(value);
  if (outcome.id !== experiment.id || outcome.kind !== experiment.kind) {
    throw new Error("Moiré subprocess response does not match the requested experiment");
  }
  return outcome;
}

function trustedSpec(context: MoireExperimentExecutionContext): StrategySpec {
  if (
    context.frozenStrategySpec === undefined ||
    context.specHash === undefined ||
    !/^sha256:[a-f0-9]{64}$/iu.test(context.specHash)
  ) {
    throw new Error("Moiré subprocess requires a host-frozen strategy");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(context.frozenStrategySpec);
  } catch {
    throw new Error("Moiré subprocess requires a host-frozen strategy");
  }
  const spec = parsed as StrategySpec;
  if (
    canonicalizeStrategySpec(spec) !== context.frozenStrategySpec ||
    hashStrategySpec(context.frozenStrategySpec) !== context.specHash
  ) {
    throw new Error("Moiré subprocess requires a host-frozen strategy");
  }
  return spec;
}

export function defaultMoireProcessConfig(): ExperimentProcessConfig {
  const experiment = defaultExperimentProcessConfig();
  return {
    ...experiment,
    args: ["-m", process.env.ASSAY_MOIRE_MODULE ?? "panda_adapter.moire_stdio"],
  };
}

export class SubprocessMoireExperimentExecutor implements MoireExperimentExecutor {
  readonly #config: ExperimentProcessConfig;

  constructor(config: ExperimentProcessConfig = defaultMoireProcessConfig()) {
    this.#config = config;
  }

  async execute(
    experiment: DiscriminativeMoireExperiment,
    context: MoireExperimentExecutionContext,
  ): Promise<DiscriminativeMoireOutcome> {
    const spec = trustedSpec(context);
    const config = this.#config;
    if (!config.command.trim()) {
      throw new Error("Moiré subprocess command cannot be empty");
    }
    const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error("Moiré subprocess maxOutputBytes must be a positive integer");
    }

    return await new Promise<DiscriminativeMoireOutcome>((resolve, reject) => {
      const child = spawn(config.command, [...(config.args ?? [])], {
        cwd: config.cwd,
        env: config.env === undefined ? process.env : { ...process.env, ...config.env },
        // The protocol is stdout-only. Discard subprocess diagnostics so
        // provider or local-path details can never enter the host timeline,
        // while also preventing an unread stderr pipe from blocking exit.
        stdio: ["pipe", "pipe", "ignore"],
      });
      const stdout: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (!settled) {
          settled = true;
          callback();
        }
      };
      const fail = (message: string): void => finish(() => reject(new Error(message)));
      child.once("error", () => fail("Moiré subprocess could not start"));
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          child.kill("SIGTERM");
          fail("Moiré subprocess output exceeded the configured limit");
        } else {
          stdout.push(chunk);
        }
      });
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          fail("Moiré subprocess failed");
          return;
        }
        try {
          const outcome = parseOutcome(Buffer.concat(stdout).toString("utf8").trim(), experiment);
          finish(() => resolve(outcome));
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      });
      child.stdin.once("error", () => fail("Moiré subprocess input failed"));
      child.stdin.end(`${JSON.stringify({ kind: experiment.kind, spec })}\n`);
    });
  }
}
