import { spawn } from "node:child_process";
import type { AgentDefinition } from "@assay/agent-runtime";
import {
  AUDIT_TOOL_CONTRACT_VERSION,
  REGIME_MINIMUM_SLICE_DAYS,
  REGIME_SPLIT_SOURCE_REF,
  type CheckEvidence,
  type MissingEvidence,
  type RegimeEnvironmentResult,
  type RegimeSplitResult,
  type RunRegimeSplitRequest,
} from "@assay/contracts";
import type { ExperimentProcessConfig } from "./run-experiment-tool";

export { REGIME_SPLIT_SOURCE_REF };
export type { RegimeSplitResult, RunRegimeSplitRequest };

type AgentTool = NonNullable<AgentDefinition["tools"]>[number];

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RESULT_KEYS = [
  "contractVersion",
  "engineVersion",
  "kind",
  "mode",
  "environments",
  "dominantEnvironment",
  "sourceRef",
  "assumptions",
] as const;
const ENVIRONMENT_KEYS = [
  "id",
  "trend",
  "volatility",
  "days",
  "annualReturn",
  "sharpe",
  "pnlShare",
] as const;
interface RegimeSplitAgentView {
  readonly engineVersion: string;
  readonly mode: RegimeSplitResult["mode"];
  readonly classificationInputs: {
    readonly dominantEnvironmentId: string;
    readonly dominantPnlShare: number;
    readonly nonDominantEnvironmentCount: number;
    readonly allNonDominantAnnualReturnsNegative: boolean;
    readonly thinSliceIds: readonly string[];
    readonly sufficientSliceCount: number;
  };
  readonly requiredEvidence: readonly CheckEvidence[];
  readonly requiredMissingEvidence: readonly MissingEvidence[];
  readonly sourceRef: typeof REGIME_SPLIT_SOURCE_REF;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`run_experiment regime_split ${path} must be a finite number`);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`run_experiment regime_split ${path} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new Error(`run_experiment regime_split ${path} must be an array of non-empty strings`);
  }
  return value;
}

function parseEnvironment(value: unknown, index: number): RegimeEnvironmentResult {
  const path = `environments[${String(index)}]`;
  if (!isRecord(value) || !hasExactKeys(value, ENVIRONMENT_KEYS)) {
    throw new Error(
      `run_experiment regime_split ${path} must contain exactly ${ENVIRONMENT_KEYS.join(", ")}`,
    );
  }
  const id = nonEmptyString(value.id, `${path}.id`);
  if (value.trend !== "up" && value.trend !== "down") {
    throw new Error(`run_experiment regime_split ${path}.trend must be up or down`);
  }
  if (value.volatility !== "high" && value.volatility !== "normal") {
    throw new Error(`run_experiment regime_split ${path}.volatility must be high or normal`);
  }
  if (!Number.isSafeInteger(value.days) || (value.days as number) <= 0) {
    throw new Error(`run_experiment regime_split ${path}.days must be a positive integer`);
  }
  if (
    value.sharpe !== null &&
    (typeof value.sharpe !== "number" || !Number.isFinite(value.sharpe))
  ) {
    throw new Error(`run_experiment regime_split ${path}.sharpe must be finite or null`);
  }
  return {
    id,
    trend: value.trend,
    volatility: value.volatility,
    days: value.days as number,
    annualReturn: finiteNumber(value.annualReturn, `${path}.annualReturn`),
    sharpe: value.sharpe,
    pnlShare: finiteNumber(value.pnlShare, `${path}.pnlShare`),
  };
}

function parseResult(stdout: string): RegimeSplitResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("run_experiment regime_split subprocess returned invalid JSON");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, RESULT_KEYS)) {
    throw new Error(
      `run_experiment regime_split response must contain exactly ${RESULT_KEYS.join(", ")}`,
    );
  }
  if (parsed.contractVersion !== AUDIT_TOOL_CONTRACT_VERSION) {
    throw new Error(
      `run_experiment regime_split contractVersion must equal ${AUDIT_TOOL_CONTRACT_VERSION}`,
    );
  }
  const engineVersion = nonEmptyString(parsed.engineVersion, "engineVersion");
  if (parsed.kind !== "regime_split") {
    throw new Error("run_experiment regime_split response.kind must equal regime_split");
  }
  if (parsed.mode !== "index_daily" && parsed.mode !== "constituent_proxy") {
    throw new Error(
      "run_experiment regime_split response.mode must be index_daily or constituent_proxy",
    );
  }
  if (!Array.isArray(parsed.environments) || parsed.environments.length === 0) {
    throw new Error("run_experiment regime_split environments must be a non-empty array");
  }
  const environments = parsed.environments.map(parseEnvironment);
  if (new Set(environments.map((environment) => environment.id)).size !== environments.length) {
    throw new Error("run_experiment regime_split environment ids must be unique");
  }
  if (
    !isRecord(parsed.dominantEnvironment) ||
    !hasExactKeys(parsed.dominantEnvironment, ["id", "pnlShare"])
  ) {
    throw new Error(
      "run_experiment regime_split dominantEnvironment must contain exactly id, pnlShare",
    );
  }
  const dominantId = nonEmptyString(parsed.dominantEnvironment.id, "dominantEnvironment.id");
  const dominantPnlShare = finiteNumber(
    parsed.dominantEnvironment.pnlShare,
    "dominantEnvironment.pnlShare",
  );
  const matchingEnvironment = environments.find((environment) => environment.id === dominantId);
  if (matchingEnvironment === undefined || matchingEnvironment.pnlShare !== dominantPnlShare) {
    throw new Error(
      "run_experiment regime_split dominantEnvironment must match one environment exactly",
    );
  }
  if (parsed.sourceRef !== REGIME_SPLIT_SOURCE_REF) {
    throw new Error(`run_experiment regime_split sourceRef must equal ${REGIME_SPLIT_SOURCE_REF}`);
  }
  return {
    contractVersion: AUDIT_TOOL_CONTRACT_VERSION,
    engineVersion,
    kind: "regime_split",
    mode: parsed.mode,
    environments,
    dominantEnvironment: {
      id: dominantId,
      pnlShare: dominantPnlShare,
    },
    sourceRef: REGIME_SPLIT_SOURCE_REF,
    assumptions: stringArray(parsed.assumptions, "assumptions"),
  };
}

function assertRequest(request: RunRegimeSplitRequest): void {
  if (
    request.kind !== "regime_split" ||
    !isRecord(request.spec) ||
    !isRecord(request.budget) ||
    request.budget.maxVariants !== 1
  ) {
    throw new Error("run_experiment requires kind=regime_split and budget.maxVariants=1");
  }
}

function environmentEvidence(environment: RegimeEnvironmentResult): readonly CheckEvidence[] {
  const sourceRefs = [REGIME_SPLIT_SOURCE_REF] as const;
  return [
    {
      metric: `${environment.id}.days`,
      value: environment.days,
      unit: "trading_days",
      sourceRefs,
    },
    {
      metric: `${environment.id}.annualReturn`,
      value: environment.annualReturn,
      unit: "annualized_decimal",
      sourceRefs,
    },
    ...(environment.sharpe === null
      ? []
      : [
          {
            metric: `${environment.id}.sharpe`,
            value: environment.sharpe,
            unit: "ratio",
            sourceRefs,
          },
        ]),
    {
      metric: `${environment.id}.pnlShare`,
      value: environment.pnlShare,
      unit: "fraction_of_total_pnl",
      sourceRefs,
    },
  ];
}

export function regimeSplitAgentView(result: RegimeSplitResult): RegimeSplitAgentView {
  const thinSlices = result.environments.filter(
    (environment) => environment.days < REGIME_MINIMUM_SLICE_DAYS,
  );
  const nonDominant = result.environments.filter(
    (environment) => environment.id !== result.dominantEnvironment.id,
  );
  const requiredMissingEvidence: MissingEvidence[] = thinSlices.map((environment) => ({
    requirement: `${environment.id} must have at least ${String(REGIME_MINIMUM_SLICE_DAYS)} trading days`,
    reason: `${environment.id} has ${String(environment.days)} trading days and cannot support a strong regime conclusion.`,
    sourceRefs: [REGIME_SPLIT_SOURCE_REF],
  }));
  if (result.assumptions.length > 0) {
    requiredMissingEvidence.push({
      requirement: `disclose ${result.mode} regime-split assumptions`,
      reason: result.assumptions.join(" "),
      sourceRefs: [REGIME_SPLIT_SOURCE_REF],
    });
  }

  return {
    engineVersion: result.engineVersion,
    mode: result.mode,
    classificationInputs: {
      dominantEnvironmentId: result.dominantEnvironment.id,
      dominantPnlShare: result.dominantEnvironment.pnlShare,
      nonDominantEnvironmentCount: nonDominant.length,
      allNonDominantAnnualReturnsNegative:
        nonDominant.length > 0 &&
        nonDominant.every((environment) => environment.annualReturn < 0),
      thinSliceIds: thinSlices.map((environment) => environment.id),
      sufficientSliceCount: result.environments.length - thinSlices.length,
    },
    requiredEvidence: [
      ...result.environments.flatMap(environmentEvidence),
      {
        metric: "dominantEnvironment.pnlShare",
        value: result.dominantEnvironment.pnlShare,
        unit: "fraction_of_total_pnl",
        sourceRefs: [REGIME_SPLIT_SOURCE_REF],
      },
    ],
    requiredMissingEvidence,
    sourceRef: REGIME_SPLIT_SOURCE_REF,
  };
}

export async function runRegimeSplitSubprocess(
  config: ExperimentProcessConfig,
  request: RunRegimeSplitRequest,
): Promise<RegimeSplitResult> {
  assertRequest(request);
  if (!config.command.trim()) {
    throw new Error("run_experiment regime_split subprocess command cannot be empty");
  }
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("run_experiment regime_split maxOutputBytes must be a positive integer");
  }

  return await new Promise<RegimeSplitResult>((resolve, reject) => {
    const child = spawn(config.command, [...(config.args ?? [])], {
      cwd: config.cwd,
      env: config.env === undefined ? process.env : { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
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
    child.once("error", () => fail("run_experiment regime_split subprocess could not start"));
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGTERM");
        fail("run_experiment regime_split subprocess output exceeded the configured limit");
      } else {
        stdout.push(chunk);
      }
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        fail("run_experiment regime_split subprocess failed");
        return;
      }
      try {
        const result = parseResult(Buffer.concat(stdout).toString("utf8").trim());
        finish(() => resolve(result));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
    child.stdin.once("error", () => fail("run_experiment regime_split subprocess input failed"));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

export function createRunRegimeSplitTool(config: ExperimentProcessConfig): AgentTool {
  return {
    name: "run_experiment",
    label: "Run approved market-regime split",
    description:
      "Run the one approved no-lookahead market-regime split in the deterministic subprocess.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "budget"],
      properties: {
        kind: { type: "string", enum: ["regime_split"] },
        budget: {
          type: "object",
          additionalProperties: false,
          required: ["maxVariants"],
          properties: {
            maxVariants: { type: "integer", enum: [1] },
          },
        },
      },
    },
    strict: true,
    approval: "read",
    intent: "omit",
    examples: [
      {
        caption: "Run the one approved market-regime split",
        call: {
          kind: "regime_split",
          budget: { maxVariants: 1 },
        },
      },
    ],
    async execute(_toolCallId, params) {
      const request = params as RunRegimeSplitRequest;
      assertRequest(request);
      const result = await runRegimeSplitSubprocess(config, request);
      return {
        content: [{ type: "text", text: JSON.stringify(regimeSplitAgentView(result)) }],
        details: result,
      };
    },
  };
}
