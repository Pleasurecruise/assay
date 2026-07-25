import { spawn } from "node:child_process";
import type { AgentDefinition } from "@assay/agent-runtime";
import {
  AUDIT_TOOL_CONTRACT_VERSION,
  AVAILABILITY_AUDIT_SOURCE_REF,
  type AvailabilityAuditResult,
} from "@assay/contracts";
import { assertHostDataRef, type HostDataRefRequest } from "./data-ref";
import type { ExperimentProcessConfig } from "./run-experiment-tool";

export { AVAILABILITY_AUDIT_SOURCE_REF };
export type { AvailabilityAuditResult };

export interface RunAvailabilityAuditRequest extends HostDataRefRequest {
  readonly kind: "availability_audit";
  readonly spec: object;
  readonly budget: {
    readonly maxVariants: 1;
  };
}

type AgentTool = NonNullable<AgentDefinition["tools"]>[number];

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RESULT_KEYS = [
  "contractVersion",
  "engineVersion",
  "mode",
  "futureConstituentCount",
  "affectedRebalances",
  "sampleSymbols",
  "untradableTargets",
  "contaminatedSelectionRate",
  "corrected",
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

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`run_availability_audit ${path} must be a finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`run_availability_audit ${path} must be a non-negative integer`);
  }
  return value as number;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(`run_availability_audit ${path} must be an array of non-empty strings`);
  }
  return value;
}

function parseResult(stdout: string): AvailabilityAuditResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("run_availability_audit subprocess returned invalid JSON");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, RESULT_KEYS)) {
    throw new Error(
      `run_availability_audit response must contain exactly ${RESULT_KEYS.join(", ")}`,
    );
  }
  if (typeof parsed.engineVersion !== "string" || parsed.engineVersion.length === 0) {
    throw new Error("run_availability_audit engineVersion must be a non-empty string");
  }
  if (parsed.contractVersion !== AUDIT_TOOL_CONTRACT_VERSION) {
    throw new Error(
      `run_availability_audit contractVersion must equal ${AUDIT_TOOL_CONTRACT_VERSION}`,
    );
  }
  if (parsed.mode !== "full_pit" && parsed.mode !== "degraded_remove_only") {
    throw new Error("run_availability_audit mode must be full_pit or degraded_remove_only");
  }
  if (
    !isRecord(parsed.corrected) ||
    !hasExactKeys(parsed.corrected, ["annualReturn", "sharpe", "delta"])
  ) {
    throw new Error(
      "run_availability_audit corrected must contain exactly annualReturn, sharpe, delta",
    );
  }
  const contaminatedSelectionRate = finiteNumber(
    parsed.contaminatedSelectionRate,
    "contaminatedSelectionRate",
  );
  if (contaminatedSelectionRate < 0 || contaminatedSelectionRate > 1) {
    throw new Error("run_availability_audit contaminatedSelectionRate must be between 0 and 1");
  }
  if (parsed.sourceRef !== AVAILABILITY_AUDIT_SOURCE_REF) {
    throw new Error(`run_availability_audit sourceRef must equal ${AVAILABILITY_AUDIT_SOURCE_REF}`);
  }
  return {
    contractVersion: AUDIT_TOOL_CONTRACT_VERSION,
    engineVersion: parsed.engineVersion,
    mode: parsed.mode,
    futureConstituentCount: nonNegativeInteger(
      parsed.futureConstituentCount,
      "futureConstituentCount",
    ),
    affectedRebalances: stringArray(parsed.affectedRebalances, "affectedRebalances"),
    sampleSymbols: stringArray(parsed.sampleSymbols, "sampleSymbols"),
    untradableTargets: nonNegativeInteger(parsed.untradableTargets, "untradableTargets"),
    contaminatedSelectionRate,
    corrected: {
      annualReturn: finiteNumber(parsed.corrected.annualReturn, "corrected.annualReturn"),
      sharpe: finiteNumber(parsed.corrected.sharpe, "corrected.sharpe"),
      delta: finiteNumber(parsed.corrected.delta, "corrected.delta"),
    },
    sourceRef: AVAILABILITY_AUDIT_SOURCE_REF,
    assumptions: stringArray(parsed.assumptions, "assumptions"),
  };
}

function assertRequest(request: RunAvailabilityAuditRequest): void {
  assertHostDataRef(request.dataRef, "run_availability_audit");
  if (
    request.kind !== "availability_audit" ||
    !isRecord(request.spec) ||
    !isRecord(request.budget) ||
    request.budget.maxVariants !== 1
  ) {
    throw new Error(
      "run_availability_audit requires kind=availability_audit and budget.maxVariants=1",
    );
  }
}

export async function runAvailabilityAuditSubprocess(
  config: ExperimentProcessConfig,
  request: RunAvailabilityAuditRequest,
): Promise<AvailabilityAuditResult> {
  assertRequest(request);
  return await new Promise<AvailabilityAuditResult>((resolve, reject) => {
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
    child.once("error", () => fail("run_availability_audit subprocess could not start"));
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        fail("run_availability_audit subprocess output exceeded the configured limit");
      } else {
        stdout.push(chunk);
      }
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        fail("run_availability_audit subprocess failed");
        return;
      }
      try {
        const result = parseResult(Buffer.concat(stdout).toString("utf8").trim());
        finish(() => resolve(result));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
    child.stdin.once("error", () => fail("run_availability_audit subprocess input failed"));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

export function createRunAvailabilityAuditTool(config: ExperimentProcessConfig): AgentTool {
  return {
    name: "run_availability_audit",
    label: "Run point-in-time availability audit",
    description: "Run the one approved point-in-time constituent and tradability correction audit.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "budget"],
      properties: {
        kind: { type: "string", enum: ["availability_audit"] },
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
        caption: "Run the one approved PIT availability audit",
        call: {
          kind: "availability_audit",
          budget: { maxVariants: 1 },
        },
      },
    ],
    async execute(_toolCallId, params) {
      const request = params as RunAvailabilityAuditRequest;
      assertRequest(request);
      const result = await runAvailabilityAuditSubprocess(config, request);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
