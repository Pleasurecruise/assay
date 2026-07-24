import { spawn } from "node:child_process";
import type { AgentDefinition } from "@assay/agent-runtime";
import {
  AUDIT_TOOL_CONTRACT_VERSION,
  HOMOGENEITY_AUDIT_SOURCE_REF,
  HOMOGENEITY_COMPARATORS,
  type AnnualInformationCoefficient,
  type HomogeneityAuditResult,
  type HomogeneityComparator,
  type HomogeneityComparison,
  type RunHomogeneityRequest,
} from "@assay/contracts";
import type { ExperimentProcessConfig } from "./run-experiment-tool";

export { HOMOGENEITY_AUDIT_SOURCE_REF };
export type { HomogeneityAuditResult, RunHomogeneityRequest };

type AgentTool = NonNullable<AgentDefinition["tools"]>[number];

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CLASSIC_COMPARATORS: readonly HomogeneityComparator[] = [
  "momentum_20",
  "reversal_5",
  "volatility_20",
];
const RESULT_KEYS = [
  "contractVersion",
  "engineVersion",
  "kind",
  "mode",
  "comparisons",
  "annualIc",
  "summary",
  "sourceRef",
  "assumptions",
] as const;

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
    throw new Error(`run_homogeneity ${path} must be a non-empty string`);
  }
  return value;
}

function boundedMetricOrNull(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`run_homogeneity ${path} must be null or a finite number in [-1, 1]`);
  }
  return value;
}

function finiteMetricOrNull(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`run_homogeneity ${path} must be null or a finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`run_homogeneity ${path} must be a non-negative integer`);
  }
  return value as number;
}

function isComparator(value: unknown): value is HomogeneityComparator {
  return HOMOGENEITY_COMPARATORS.some((candidate) => candidate === value);
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new Error(`run_homogeneity ${path} must be an array of non-empty strings`);
  }
  return value;
}

function parseComparison(value: unknown, index: number): HomogeneityComparison {
  const path = `comparisons[${String(index)}]`;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["comparator", "meanSpearman", "rebalanceObservations"])
  ) {
    throw new Error(
      `run_homogeneity ${path} must contain exactly comparator, meanSpearman, rebalanceObservations`,
    );
  }
  if (!isComparator(value.comparator)) {
    throw new Error(`run_homogeneity ${path}.comparator is not approved`);
  }
  return {
    comparator: value.comparator,
    meanSpearman: boundedMetricOrNull(value.meanSpearman, `${path}.meanSpearman`),
    rebalanceObservations: nonNegativeInteger(
      value.rebalanceObservations,
      `${path}.rebalanceObservations`,
    ),
  };
}

function parseAnnualIc(value: unknown, index: number): AnnualInformationCoefficient {
  const path = `annualIc[${String(index)}]`;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["year", "observations", "pearsonIc", "rankIc"])
  ) {
    throw new Error(
      `run_homogeneity ${path} must contain exactly year, observations, pearsonIc, rankIc`,
    );
  }
  const year = nonEmptyString(value.year, `${path}.year`);
  if (!/^\d{4}$/.test(year)) {
    throw new Error(`run_homogeneity ${path}.year must use YYYY format`);
  }
  return {
    year,
    observations: nonNegativeInteger(value.observations, `${path}.observations`),
    pearsonIc: boundedMetricOrNull(value.pearsonIc, `${path}.pearsonIc`),
    rankIc: boundedMetricOrNull(value.rankIc, `${path}.rankIc`),
  };
}

function sameMembers(
  actual: readonly HomogeneityComparator[],
  expected: readonly HomogeneityComparator[],
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((candidate) => actual.includes(candidate)) &&
    new Set(actual).size === actual.length
  );
}

function parseResult(stdout: string): HomogeneityAuditResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("run_homogeneity subprocess returned invalid JSON");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, RESULT_KEYS)) {
    throw new Error(`run_homogeneity response must contain exactly ${RESULT_KEYS.join(", ")}`);
  }
  if (parsed.contractVersion !== AUDIT_TOOL_CONTRACT_VERSION) {
    throw new Error(
      `run_homogeneity contractVersion must equal ${AUDIT_TOOL_CONTRACT_VERSION}`,
    );
  }
  const engineVersion = nonEmptyString(parsed.engineVersion, "engineVersion");
  if (parsed.kind !== "homogeneity") {
    throw new Error("run_homogeneity response.kind must equal homogeneity");
  }
  if (parsed.mode !== "full_factor_library" && parsed.mode !== "classic_only") {
    throw new Error(
      "run_homogeneity response.mode must be full_factor_library or classic_only",
    );
  }
  if (!Array.isArray(parsed.comparisons)) {
    throw new Error("run_homogeneity comparisons must be an array");
  }
  const comparisons = parsed.comparisons.map(parseComparison);
  const expectedComparators =
    parsed.mode === "full_factor_library" ? HOMOGENEITY_COMPARATORS : CLASSIC_COMPARATORS;
  if (!sameMembers(comparisons.map((comparison) => comparison.comparator), expectedComparators)) {
    throw new Error(
      `run_homogeneity ${parsed.mode} comparisons must contain each approved comparator exactly once`,
    );
  }
  if (!Array.isArray(parsed.annualIc)) {
    throw new Error("run_homogeneity annualIc must be an array");
  }
  const annualIc = parsed.annualIc.map(parseAnnualIc);
  if (new Set(annualIc.map((row) => row.year)).size !== annualIc.length) {
    throw new Error("run_homogeneity annualIc years must be unique");
  }
  if (
    !isRecord(parsed.summary) ||
    !hasExactKeys(parsed.summary, [
      "nearestComparator",
      "maxAbsMeanSpearman",
      "yearsCovered",
      "rankIcSlope",
    ])
  ) {
    throw new Error(
      "run_homogeneity summary must contain exactly nearestComparator, maxAbsMeanSpearman, yearsCovered, rankIcSlope",
    );
  }
  const summary = parsed.summary;
  if (summary.nearestComparator !== null && !isComparator(summary.nearestComparator)) {
    throw new Error("run_homogeneity summary.nearestComparator is not approved");
  }
  if (
    summary.nearestComparator !== null &&
    !comparisons.some((comparison) => comparison.comparator === summary.nearestComparator)
  ) {
    throw new Error("run_homogeneity summary.nearestComparator must appear in comparisons");
  }
  const maxAbsMeanSpearman = boundedMetricOrNull(
    summary.maxAbsMeanSpearman,
    "summary.maxAbsMeanSpearman",
  );
  if (maxAbsMeanSpearman !== null && maxAbsMeanSpearman < 0) {
    throw new Error("run_homogeneity summary.maxAbsMeanSpearman must be non-negative");
  }
  const yearsCovered = nonNegativeInteger(summary.yearsCovered, "summary.yearsCovered");
  if (yearsCovered !== annualIc.length) {
    throw new Error("run_homogeneity summary.yearsCovered must equal annualIc length");
  }
  if (parsed.sourceRef !== HOMOGENEITY_AUDIT_SOURCE_REF) {
    throw new Error(`run_homogeneity sourceRef must equal ${HOMOGENEITY_AUDIT_SOURCE_REF}`);
  }
  return {
    contractVersion: AUDIT_TOOL_CONTRACT_VERSION,
    engineVersion,
    kind: "homogeneity",
    mode: parsed.mode,
    comparisons,
    annualIc,
    summary: {
      nearestComparator: summary.nearestComparator,
      maxAbsMeanSpearman,
      yearsCovered,
      rankIcSlope: finiteMetricOrNull(summary.rankIcSlope, "summary.rankIcSlope"),
    },
    sourceRef: HOMOGENEITY_AUDIT_SOURCE_REF,
    assumptions: stringArray(parsed.assumptions, "assumptions"),
  };
}

function assertRequest(request: RunHomogeneityRequest): void {
  if (
    request.kind !== "homogeneity" ||
    !isRecord(request.spec) ||
    !isRecord(request.budget) ||
    request.budget.maxVariants !== 1
  ) {
    throw new Error("run_homogeneity requires kind=homogeneity and budget.maxVariants=1");
  }
}

export async function runHomogeneitySubprocess(
  config: ExperimentProcessConfig,
  request: RunHomogeneityRequest,
): Promise<HomogeneityAuditResult> {
  assertRequest(request);
  if (!config.command.trim()) {
    throw new Error("run_homogeneity subprocess command cannot be empty");
  }
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("run_homogeneity maxOutputBytes must be a positive integer");
  }

  return await new Promise<HomogeneityAuditResult>((resolve, reject) => {
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
    child.once("error", () => fail("run_homogeneity subprocess could not start"));
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGTERM");
        fail("run_homogeneity subprocess output exceeded the configured limit");
      } else {
        stdout.push(chunk);
      }
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        fail("run_homogeneity subprocess failed");
        return;
      }
      try {
        const result = parseResult(Buffer.concat(stdout).toString("utf8").trim());
        finish(() => resolve(result));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
    child.stdin.once("error", () => fail("run_homogeneity subprocess input failed"));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

export function createRunHomogeneityTool(config: ExperimentProcessConfig): AgentTool {
  return {
    name: "run_homogeneity",
    label: "Run approved homogeneity and decay audit",
    description:
      "Run the one approved cross-sectional factor-correlation and annual IC/RankIC audit.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "budget"],
      properties: {
        kind: { type: "string", enum: ["homogeneity"] },
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
        caption: "Run the one approved homogeneity and decay audit",
        call: {
          kind: "homogeneity",
          budget: { maxVariants: 1 },
        },
      },
    ],
    async execute(_toolCallId, params) {
      const request = params as RunHomogeneityRequest;
      assertRequest(request);
      const result = await runHomogeneitySubprocess(config, request);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
