import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { AgentDefinition, AgentSubmissionValidator } from "@assay/agent-runtime";
import {
  COST_STRESS_SOURCE_REF,
  PARAMETER_GRID_SOURCE_REF,
  PARAMETER_RETENTION_PASS_THRESHOLD,
  PARAMETER_RETENTION_RESERVATION_THRESHOLD,
  SPRINT_PARAMETER_GRID_TOP_N,
  SPRINT_PARAMETER_GRID_WINDOWS,
  type CheckConclusion,
  type CheckEvidence,
  type MissingEvidence,
} from "@assay/contracts";
import { assertHostDataRef, type HostDataRefRequest } from "./data-ref";
import { computeOverfitStatistics, type OverfitStatistics } from "./pbo";

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

export interface RunExperimentRequest extends HostDataRefRequest {
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
  readonly summaryRef?: typeof PARAMETER_GRID_SOURCE_REF | typeof COST_STRESS_SOURCE_REF;
  /**
   * Grid responses only: per-variant daily returns aligned with `variants`,
   * inlined by the engine so the host can compute overfitting statistics
   * without replicating Python-side artifact path derivation.
   */
  readonly variantDailyReturns?: readonly (readonly number[])[];
}

interface ParameterGridAgentView {
  readonly engineVersion: string;
  readonly baseline: Omit<ExperimentResultSummary, "params">;
  readonly parameterSummary: {
    readonly baselineSharpe: number;
    readonly medianVariantSharpe: number;
    readonly neighborhoodSharpeRetention: number | null;
    readonly variantCount: number;
    readonly minVariantSharpe: number;
    readonly maxVariantSharpe: number;
    readonly overfitStatistics: OverfitStatistics | null;
  };
  readonly summaryRef: typeof PARAMETER_GRID_SOURCE_REF;
  readonly submissionContract: ParameterRobustnessSubmissionContract;
}

export interface ParameterRobustnessSubmissionContract {
  readonly requiredConclusion: Exclude<CheckConclusion, "not_applicable">;
  readonly requiredEvidence: readonly CheckEvidence[];
  readonly requiredMissingEvidence: readonly MissingEvidence[];
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
const BASE_RESULT_KEYS = ["engineVersion", "baseline", "variants"] as const;
const AUDIT_RESULT_KEYS = [...BASE_RESULT_KEYS, "summaryRef"] as const;
const GRID_RESULT_KEYS = [...AUDIT_RESULT_KEYS, "variantDailyReturns"] as const;
const SUMMARY_KEYS = ["params", "annualReturn", "sharpe", "maxDrawdown", "annualTurnover"] as const;
const OVERFIT_EVIDENCE_FIELDS = [
  ["pbo", "ratio"],
  ["combinationsEvaluated", "count"],
  ["degradationSlope", "ratio"],
  ["dailyBaselineSharpe", "ratio"],
  ["sampleLength", "count"],
  ["effectiveTrials", "count"],
  ["expectedMaxSharpeDaily", "ratio"],
  ["deflatedSharpeRatio", "ratio"],
  ["minTrackRecordDays", "days"],
] as const satisfies readonly (readonly [keyof OverfitStatistics, string])[];
const OVERFIT_MISSING_REQUIREMENT_PREFIX = "overfitStatistics.";
// Values live in @assay/contracts so Intake gating, this frozen grid, and the
// check prompt can never drift apart.
export const SPRINT_PARAMETER_GRID: ExperimentGrid = Object.freeze({
  signalParams: Object.freeze({ window: SPRINT_PARAMETER_GRID_WINDOWS }),
  topN: SPRINT_PARAMETER_GRID_TOP_N,
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
  assertHostDataRef(value.dataRef, "run_experiment");
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

function parseResult(stdout: string, kind: ExperimentKind): RunExperimentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("run_experiment subprocess returned invalid JSON");
  }
  const expectedKeys =
    kind === "baseline" ? BASE_RESULT_KEYS : kind === "grid" ? GRID_RESULT_KEYS : AUDIT_RESULT_KEYS;
  if (!isRecord(parsed) || !hasExactKeys(parsed, expectedKeys)) {
    throw new Error(
      `run_experiment subprocess response must contain exactly ${expectedKeys.join(", ")}`,
    );
  }
  if (typeof parsed.engineVersion !== "string" || parsed.engineVersion.trim().length === 0) {
    throw new Error("run_experiment subprocess response.engineVersion must be a non-empty string");
  }
  if (!Array.isArray(parsed.variants)) {
    throw new Error("run_experiment subprocess response must include a variants array");
  }
  const expectedSummaryRef =
    kind === "grid"
      ? PARAMETER_GRID_SOURCE_REF
      : kind === "cost_ladder"
        ? COST_STRESS_SOURCE_REF
        : undefined;
  if (expectedSummaryRef !== undefined && parsed.summaryRef !== expectedSummaryRef) {
    throw new Error(`run_experiment ${kind} response.summaryRef is invalid`);
  }
  const variants = parsed.variants.map((variant, index) =>
    parseResultSummary(variant, `response.variants[${String(index)}]`),
  );
  return {
    engineVersion: parsed.engineVersion,
    baseline: parseResultSummary(parsed.baseline, "response.baseline"),
    variants,
    ...(expectedSummaryRef === undefined ? {} : { summaryRef: expectedSummaryRef }),
    ...(kind === "grid"
      ? {
          variantDailyReturns: parseVariantDailyReturns(
            parsed.variantDailyReturns,
            variants.length,
          ),
        }
      : {}),
  };
}

function parseVariantDailyReturns(
  value: unknown,
  variantCount: number,
): readonly (readonly number[])[] {
  if (!Array.isArray(value) || value.length !== variantCount) {
    throw new Error(
      "run_experiment grid response.variantDailyReturns must align with response.variants",
    );
  }
  let sampleLength: number | undefined;
  return value.map((series, index) => {
    if (!Array.isArray(series) || series.length === 0) {
      throw new Error(
        `run_experiment grid response.variantDailyReturns[${String(index)}] must be a non-empty array`,
      );
    }
    sampleLength ??= series.length;
    if (series.length !== sampleLength) {
      throw new Error(
        "run_experiment grid response.variantDailyReturns series must share one sample length",
      );
    }
    return series.map((entry, position) =>
      parseFiniteMetric(
        entry,
        `response.variantDailyReturns[${String(index)}][${String(position)}]`,
      ),
    );
  });
}

function gridParameter(params: Readonly<Record<string, unknown>>, name: "window" | "topN"): number {
  const value = params[name];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`run_experiment grid response ${name} parameter must be an integer`);
  }
  return value as number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("run_experiment grid response omitted non-baseline variants");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const upper = sorted[midpoint] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[midpoint - 1] as number) + upper) / 2;
}

function frozenParameterRobustnessConclusion(
  neighborhoodSharpeRetention: number | null,
): ParameterRobustnessSubmissionContract["requiredConclusion"] {
  if (neighborhoodSharpeRetention === null || !Number.isFinite(neighborhoodSharpeRetention)) {
    return "insufficient_evidence";
  }
  if (neighborhoodSharpeRetention >= PARAMETER_RETENTION_PASS_THRESHOLD) {
    return "pass";
  }
  return neighborhoodSharpeRetention >= PARAMETER_RETENTION_RESERVATION_THRESHOLD
    ? "pass_with_reservations"
    : "fail";
}

function overfitMissingEvidence(metric: keyof OverfitStatistics): MissingEvidence {
  return {
    requirement: `${OVERFIT_MISSING_REQUIREMENT_PREFIX}${metric}`,
    reason: "The frozen parameter-grid returns could not produce this overfitting statistic.",
    sourceRefs: [PARAMETER_GRID_SOURCE_REF],
  };
}

function createParameterRobustnessSubmissionContract(
  neighborhoodSharpeRetention: number | null,
  overfitStatistics: OverfitStatistics | null,
): ParameterRobustnessSubmissionContract {
  const requiredEvidence: CheckEvidence[] = [];
  const requiredMissingEvidence: MissingEvidence[] = [];
  for (const [metric, unit] of OVERFIT_EVIDENCE_FIELDS) {
    const value = overfitStatistics?.[metric] ?? null;
    if (typeof value === "number" && Number.isFinite(value)) {
      requiredEvidence.push({
        metric,
        value,
        unit,
        sourceRefs: [PARAMETER_GRID_SOURCE_REF],
      });
    } else {
      requiredMissingEvidence.push(overfitMissingEvidence(metric));
    }
  }
  return {
    requiredConclusion: frozenParameterRobustnessConclusion(neighborhoodSharpeRetention),
    requiredEvidence,
    requiredMissingEvidence,
  };
}

function parameterGridAgentView(result: RunExperimentResult): ParameterGridAgentView {
  if (
    result.summaryRef !== PARAMETER_GRID_SOURCE_REF ||
    result.variants.length !==
      SPRINT_PARAMETER_GRID.signalParams.window.length * SPRINT_PARAMETER_GRID.topN.length
  ) {
    throw new Error("run_experiment grid response is not the frozen parameter grid");
  }
  const baselineWindow = gridParameter(result.baseline.params, "window");
  const baselineTopN = gridParameter(result.baseline.params, "topN");
  const baselineEquivalent = result.variants.filter(
    (variant) =>
      gridParameter(variant.params, "window") === baselineWindow &&
      gridParameter(variant.params, "topN") === baselineTopN,
  );
  if (baselineEquivalent.length !== 1) {
    throw new Error(
      "run_experiment grid response must contain exactly one baseline-equivalent variant",
    );
  }
  const baselineVariantIndex = result.variants.indexOf(
    baselineEquivalent[0] as ExperimentResultSummary,
  );
  const overfitStatistics =
    result.variantDailyReturns === undefined
      ? null
      : computeOverfitStatistics(result.variantDailyReturns, baselineVariantIndex);
  const nonBaselineSharpes = result.variants
    .filter((variant) => variant !== baselineEquivalent[0])
    .map((variant) => variant.sharpe);
  const medianVariantSharpe = median(nonBaselineSharpes);
  const minVariantSharpe = Math.min(...nonBaselineSharpes);
  const maxVariantSharpe = Math.max(...nonBaselineSharpes);
  const neighborhoodSharpeRetention =
    result.baseline.sharpe > 0 ? medianVariantSharpe / result.baseline.sharpe : null;
  return {
    engineVersion: result.engineVersion,
    baseline: {
      annualReturn: result.baseline.annualReturn,
      sharpe: result.baseline.sharpe,
      maxDrawdown: result.baseline.maxDrawdown,
      annualTurnover: result.baseline.annualTurnover,
    },
    parameterSummary: {
      baselineSharpe: result.baseline.sharpe,
      medianVariantSharpe,
      neighborhoodSharpeRetention,
      variantCount: nonBaselineSharpes.length,
      minVariantSharpe,
      maxVariantSharpe,
      overfitStatistics,
    },
    summaryRef: PARAMETER_GRID_SOURCE_REF,
    submissionContract: createParameterRobustnessSubmissionContract(
      neighborhoodSharpeRetention,
      overfitStatistics,
    ),
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameEvidence(left: CheckEvidence, right: CheckEvidence): boolean {
  return (
    left.metric === right.metric &&
    Object.is(left.value, right.value) &&
    left.unit === right.unit &&
    sameStringArray(left.sourceRefs, right.sourceRefs)
  );
}

function sameMissingEvidence(left: MissingEvidence, right: MissingEvidence): boolean {
  return (
    left.requirement === right.requirement &&
    left.reason === right.reason &&
    sameStringArray(left.sourceRefs, right.sourceRefs)
  );
}

function parameterSubmissionContractFromDetails(
  details: unknown,
): ParameterRobustnessSubmissionContract {
  if (!isRecord(details) || !isRecord(details.submissionContract)) {
    throw new Error(
      "Parameter-robustness submission validation requires the host evidence contract.",
    );
  }
  const contract = details.submissionContract;
  if (
    (contract.requiredConclusion !== "pass" &&
      contract.requiredConclusion !== "pass_with_reservations" &&
      contract.requiredConclusion !== "fail" &&
      contract.requiredConclusion !== "insufficient_evidence") ||
    !Array.isArray(contract.requiredEvidence) ||
    !Array.isArray(contract.requiredMissingEvidence)
  ) {
    throw new Error("Parameter-robustness host evidence contract is invalid.");
  }
  return contract as unknown as ParameterRobustnessSubmissionContract;
}

export const validateParameterRobustnessSubmission: AgentSubmissionValidator = ({
  submission,
  evidenceTool,
}) => {
  if (evidenceTool.name !== "run_experiment") {
    throw new Error("Parameter-robustness submission requires run_experiment evidence.");
  }
  const contract = parameterSubmissionContractFromDetails(evidenceTool.details);
  if (submission.conclusion !== contract.requiredConclusion) {
    throw new Error(
      `Parameter-robustness conclusion must equal the frozen retention conclusion "${contract.requiredConclusion}".`,
    );
  }

  const overfitMetrics = new Set(OVERFIT_EVIDENCE_FIELDS.map(([metric]) => metric));
  const submittedOverfitEvidence = submission.evidence.filter((item) =>
    overfitMetrics.has(item.metric as keyof OverfitStatistics),
  );
  if (
    submittedOverfitEvidence.length !== contract.requiredEvidence.length ||
    contract.requiredEvidence.some((expected) => {
      const matches = submittedOverfitEvidence.filter(
        (actual) => actual.metric === expected.metric,
      );
      return matches.length !== 1 || !sameEvidence(matches[0] as CheckEvidence, expected);
    })
  ) {
    throw new Error(
      "Parameter-robustness overfitting evidence must exactly match the host-required evidence.",
    );
  }

  const submittedOverfitMissingEvidence = submission.missingEvidence.filter((item) =>
    item.requirement.startsWith(OVERFIT_MISSING_REQUIREMENT_PREFIX),
  );
  if (
    submittedOverfitMissingEvidence.length !== contract.requiredMissingEvidence.length ||
    contract.requiredMissingEvidence.some((expected) => {
      const matches = submittedOverfitMissingEvidence.filter(
        (actual) => actual.requirement === expected.requirement,
      );
      return matches.length !== 1 || !sameMissingEvidence(matches[0] as MissingEvidence, expected);
    })
  ) {
    throw new Error(
      "Parameter-robustness unavailable overfitting statistics must exactly match the host-required missing evidence.",
    );
  }
};

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
        const result = parseResult(
          Buffer.concat(stdoutChunks).toString("utf8").trim(),
          request.kind,
        );
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

export function pythonModuleProcessConfig(
  moduleName: string,
  environment: NodeJS.ProcessEnv = process.env,
): ExperimentProcessConfig {
  const configuredPython = environment.ASSAY_EXPERIMENT_PYTHON?.trim();
  if (configuredPython !== undefined && configuredPython.length > 0) {
    return {
      command: configuredPython,
      args: ["-m", moduleName],
    };
  }
  return {
    command: environment.ASSAY_UV_COMMAND?.trim() || "uv",
    args: [
      "run",
      "--project",
      resolve(environment.ASSAY_PANDA_ADAPTER_PROJECT?.trim() || "services/panda-adapter"),
      "python",
      "-m",
      moduleName,
    ],
  };
}

export function defaultExperimentProcessConfig(): ExperimentProcessConfig {
  return pythonModuleProcessConfig(
    process.env.ASSAY_EXPERIMENT_MODULE ?? "panda_adapter.experiment_stdio",
  );
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
      // AgentRuntime injects the trusted frozen spec and task data reference
      // after schema validation.
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
      const agentView = kind === "grid" ? parameterGridAgentView(result) : result;
      return {
        content: [{ type: "text", text: JSON.stringify(agentView) }],
        details:
          kind === "grid"
            ? {
                ...result,
                submissionContract: (agentView as ParameterGridAgentView).submissionContract,
              }
            : result,
      };
    },
  };
}
