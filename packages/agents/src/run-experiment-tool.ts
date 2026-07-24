import { spawn } from "node:child_process";
import type { AgentDefinition } from "@assay/agent-runtime";

export type ExperimentKind = "baseline" | "grid" | "cost_ladder";
export type AgentExperimentKind = Exclude<ExperimentKind, "baseline">;

export interface ExperimentBudget {
  readonly maxVariants: number;
}

export interface ExperimentGrid {
  readonly signalParams: {
    readonly window: readonly number[];
  };
  readonly topN: readonly number[];
}

export interface RunExperimentRequest {
  readonly kind: ExperimentKind;
  readonly spec: object;
  readonly grid?: ExperimentGrid;
  readonly universeMode?: "asOf";
  readonly budget: ExperimentBudget;
}

export interface ExperimentResultSummary {
  readonly params: Readonly<Record<string, unknown>>;
  readonly annualReturn: number;
  readonly sharpe: number;
  readonly maxDrawdown: number;
  readonly annualTurnover: number;
}

export interface RunExperimentResult {
  readonly engineVersion: string;
  readonly baseline: ExperimentResultSummary;
  readonly variants: readonly ExperimentResultSummary[];
}

export interface ExperimentProcessConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxOutputBytes?: number;
}

type AgentTool = NonNullable<AgentDefinition["tools"]>[number];

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RESULT_KEYS = ["engineVersion", "baseline", "variants"] as const;
const SUMMARY_KEYS = ["params", "annualReturn", "sharpe", "maxDrawdown", "annualTurnover"] as const;
export const SPRINT_PARAMETER_GRID: ExperimentGrid = Object.freeze({
  signalParams: Object.freeze({ window: Object.freeze([14, 17, 20, 23, 26]) }),
  topN: Object.freeze([30, 50, 70]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function parseFiniteMetric(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`run_experiment subprocess ${location} must be a finite number`);
  }
  return value;
}

function assertRequest(
  value: RunExperimentRequest,
  expectedKind?: ExperimentKind,
): asserts value is RunExperimentRequest {
  if (expectedKind !== undefined && value.kind !== expectedKind) {
    throw new Error(`run_experiment expected kind "${expectedKind}"`);
  }
  if (value.kind !== "baseline" && value.kind !== "grid" && value.kind !== "cost_ladder") {
    throw new Error("run_experiment kind must be baseline, grid, or cost_ladder");
  }
  if (!isRecord(value.spec)) {
    throw new Error("run_experiment spec must be an object");
  }
  if (
    !isRecord(value.budget) ||
    !Number.isSafeInteger(value.budget.maxVariants) ||
    value.budget.maxVariants <= 0
  ) {
    throw new Error("run_experiment budget.maxVariants must be a positive integer");
  }
  const maximumVariants = value.kind === "grid" ? 15 : value.kind === "cost_ladder" ? 3 : 1;
  if (value.budget.maxVariants > maximumVariants) {
    throw new Error(
      `run_experiment ${value.kind} budget.maxVariants cannot exceed ${maximumVariants}`,
    );
  }
  if (value.kind === "grid") {
    if (value.universeMode !== undefined) {
      throw new Error("run_experiment grid does not accept universeMode");
    }
    if (
      !isRecord(value.grid) ||
      !isRecord(value.grid.signalParams) ||
      !Array.isArray(value.grid.signalParams.window) ||
      value.grid.signalParams.window.length === 0 ||
      !value.grid.signalParams.window.every(
        (window) => Number.isSafeInteger(window) && window > 0,
      ) ||
      !Array.isArray(value.grid.topN) ||
      value.grid.topN.length === 0 ||
      !value.grid.topN.every((topN) => Number.isSafeInteger(topN) && topN > 0 && topN <= 200)
    ) {
      throw new Error(
        "run_experiment grid must contain signalParams.window and topN integer arrays",
      );
    }
    if (value.grid.signalParams.window.length * value.grid.topN.length > value.budget.maxVariants) {
      throw new Error("run_experiment grid exceeds budget.maxVariants");
    }
  }
  if (value.kind === "cost_ladder" && value.grid !== undefined) {
    throw new Error("run_experiment cost_ladder does not accept a caller-supplied grid");
  }
  if (value.kind === "cost_ladder" && value.universeMode !== undefined) {
    throw new Error("run_experiment cost_ladder does not accept universeMode");
  }
  if (value.kind === "baseline") {
    if (value.grid !== undefined) {
      throw new Error("run_experiment baseline does not accept a caller-supplied grid");
    }
    if (value.universeMode !== "asOf") {
      throw new Error('run_experiment baseline universeMode must be "asOf"');
    }
    if (value.budget.maxVariants !== 1) {
      throw new Error("run_experiment baseline budget.maxVariants must equal 1");
    }
  }
}

function parseResultSummary(value: unknown, location: string): ExperimentResultSummary {
  if (!isRecord(value) || !hasExactKeys(value, SUMMARY_KEYS)) {
    throw new Error(
      `run_experiment subprocess ${location} must contain exactly ${SUMMARY_KEYS.join(", ")}`,
    );
  }
  if (!isRecord(value.params)) {
    throw new Error(`run_experiment subprocess ${location}.params must be an object`);
  }
  return {
    params: value.params,
    annualReturn: parseFiniteMetric(value.annualReturn, `${location}.annualReturn`),
    sharpe: parseFiniteMetric(value.sharpe, `${location}.sharpe`),
    maxDrawdown: parseFiniteMetric(value.maxDrawdown, `${location}.maxDrawdown`),
    annualTurnover: parseFiniteMetric(value.annualTurnover, `${location}.annualTurnover`),
  };
}

function parseResult(stdout: string): RunExperimentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("run_experiment subprocess returned invalid JSON");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, RESULT_KEYS)) {
    throw new Error(
      `run_experiment subprocess response must contain exactly ${RESULT_KEYS.join(", ")}`,
    );
  }
  if (typeof parsed.engineVersion !== "string" || parsed.engineVersion.trim().length === 0) {
    throw new Error("run_experiment subprocess response.engineVersion must be a non-empty string");
  }
  if (!Array.isArray(parsed.variants)) {
    throw new Error("run_experiment subprocess response must include a variants array");
  }
  return {
    engineVersion: parsed.engineVersion,
    baseline: parseResultSummary(parsed.baseline, "response.baseline"),
    variants: parsed.variants.map((variant, index) =>
      parseResultSummary(variant, `response.variants[${String(index)}]`),
    ),
  };
}

/**
 * Thin process boundary around the deterministic backtest engine.
 *
 * Exactly one JSON request is written to stdin and exactly one JSON response is
 * accepted from stdout. The LLM never receives a shell or Python execution
 * primitive; it can only invoke this coarse experiment protocol.
 */
export async function runExperimentSubprocess(
  config: ExperimentProcessConfig,
  request: RunExperimentRequest,
): Promise<RunExperimentResult> {
  assertRequest(request);
  if (!config.command.trim()) {
    throw new Error("run_experiment subprocess command cannot be empty");
  }

  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("run_experiment maxOutputBytes must be a positive integer");
  }

  return await new Promise<RunExperimentResult>((resolve, reject) => {
    const child = spawn(config.command, [...(config.args ?? [])], {
      cwd: config.cwd,
      env: config.env === undefined ? process.env : { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };
    const fail = (error: Error): void => {
      finish(() => reject(error));
    };

    child.once("error", (error) => fail(error));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        child.kill("SIGTERM");
        fail(new Error("run_experiment subprocess stdout exceeded the configured limit"));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= maxOutputBytes) {
        stderrChunks.push(chunk);
      }
    });
    child.once("close", (code, closeSignal) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        fail(
          new Error(
            `run_experiment subprocess failed (${closeSignal ?? `exit ${String(code)}`})${
              stderr ? `: ${stderr}` : ""
            }`,
          ),
        );
        return;
      }
      try {
        const result = parseResult(Buffer.concat(stdoutChunks).toString("utf8").trim());
        if (request.kind === "baseline" && result.variants.length !== 0) {
          throw new Error("run_experiment baseline subprocess must not return variants");
        }
        finish(() => resolve(result));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stdin.once("error", (error) => fail(error));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

export function defaultExperimentProcessConfig(): ExperimentProcessConfig {
  return {
    command: process.env.ASSAY_EXPERIMENT_PYTHON ?? "python3",
    args: ["-m", process.env.ASSAY_EXPERIMENT_MODULE ?? "panda_adapter.experiment_stdio"],
  };
}

function parametersFor(kind: AgentExperimentKind): AgentTool["parameters"] {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "budget"],
    properties: {
      kind: { type: "string", enum: [kind] },
      budget: {
        type: "object",
        additionalProperties: false,
        required: ["maxVariants"],
        properties: {
          maxVariants: {
            type: "integer",
            enum: [kind === "grid" ? 15 : 3],
          },
        },
      },
    },
  };
}

const GRID_EXAMPLE = {
  kind: "grid",
  budget: { maxVariants: 15 },
} as const;

const COST_LADDER_EXAMPLE = {
  kind: "cost_ladder",
  budget: { maxVariants: 3 },
} as const;

export function createRunExperimentTool(
  kind: AgentExperimentKind,
  config: ExperimentProcessConfig = defaultExperimentProcessConfig(),
): AgentTool {
  return {
    name: "run_experiment",
    label: "Run approved backtest experiment",
    description:
      kind === "grid"
        ? "Run one parameter-grid experiment in the deterministic backtest subprocess."
        : "Run one fixed cost-ladder experiment in the deterministic backtest subprocess.",
    parameters: parametersFor(kind),
    strict: true,
    // The subprocess is an implementation detail; this capability only reads
    // frozen inputs and returns deterministic calculations, so the runtime
    // policy may safely expose it as a read-only tool.
    approval: "read",
    intent: "omit",
    examples: [
      {
        caption:
          kind === "grid"
            ? "Run the one approved parameter grid"
            : "Run the one approved cost ladder",
        call: kind === "grid" ? GRID_EXAMPLE : COST_LADDER_EXAMPLE,
      },
    ],
    async execute(_toolCallId, params) {
      // AgentRuntime injects the trusted frozen spec after schema validation.
      const boundRequest = params as RunExperimentRequest;
      const request: RunExperimentRequest =
        kind === "grid"
          ? {
              ...boundRequest,
              grid: SPRINT_PARAMETER_GRID,
              budget: { maxVariants: 15 },
            }
          : boundRequest;
      assertRequest(request, kind);
      const result = await runExperimentSubprocess(config, request);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
