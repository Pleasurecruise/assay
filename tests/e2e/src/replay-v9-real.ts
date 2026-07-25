import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  replayV9RealMechanism,
  V9_UNACCEPTED_DIAGNOSTIC_VERSION,
  type V9MechanismReplayReport,
} from "./v9-real-data";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrapV9ReplayCandidate(value: unknown): unknown {
  if (!isRecord(value) || value.artifactRole !== "unaccepted-diagnostic") {
    return value;
  }
  if (value.schemaVersion !== V9_UNACCEPTED_DIAGNOSTIC_VERSION || !isRecord(value.candidate)) {
    throw new Error("v9 diagnostic envelope is invalid");
  }
  return {
    ...value.candidate,
    artifactRole: "real-data-acceptance",
  };
}

export async function replayV9CandidateFile(path: string): Promise<V9MechanismReplayReport> {
  const bytes = await readFile(path, "utf8");
  const value: unknown = JSON.parse(bytes);
  return replayV9RealMechanism(unwrapV9ReplayCandidate(value));
}

export function formatV9ReplayReport(report: V9MechanismReplayReport): string {
  const lines = report.assertions.map((assertion) =>
    JSON.stringify({
      assertion: assertion.assertion,
      status: assertion.status,
      expected: assertion.expected,
      actual: assertion.actual,
    }),
  );
  lines.push(
    JSON.stringify({
      summary: report.passed ? "PASS" : "FAIL",
      assertionCount: report.assertions.length,
      mismatchCount: report.assertions.filter((assertion) => assertion.status !== "pass").length,
    }),
  );
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const inputPath = process.argv[2];
  if (inputPath === undefined || process.argv.length !== 3) {
    process.stderr.write("Usage: bun run v9:replay <candidate-or-diagnostic.json>\n");
    process.exitCode = 2;
  } else {
    try {
      const report = await replayV9CandidateFile(resolve(inputPath));
      process.stdout.write(formatV9ReplayReport(report));
      process.exitCode = report.passed ? 0 : 1;
    } catch {
      process.stderr.write("v9 replay could not read a valid candidate JSON file\n");
      process.exitCode = 2;
    }
  }
}
