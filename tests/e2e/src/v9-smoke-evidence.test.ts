import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { assertOutputSafe } from "./sprint-acceptance";

const artifactPath = resolve("artifacts/v9/assay-v9-agent-smoke-evidence.json");

interface SmokeAttempt {
  readonly callIndex: number;
  readonly agentId: string;
  readonly outcome: string;
  readonly outputSha256: string;
  readonly contractValidated?: boolean;
}

test("records the three required prompt smokes within the authorized live-call budget", () => {
  const raw = readFileSync(artifactPath, "utf8");
  const artifact = JSON.parse(raw) as {
    schemaVersion: string;
    artifactRole: string;
    promptCodeRevision: string;
    callBudget: {
      authorizedMinimum: number;
      authorizedMaximum: number;
      liveModelCallsUsed: number;
      successfulRequiredSmokes: number;
      failedContractAttempts: number;
    };
    requiredAgents: string[];
    attempts: SmokeAttempt[];
    assumptionsAndLimits: string[];
  };

  expect(artifact.schemaVersion).toBe("assay-v9-agent-smoke-evidence-v1");
  expect(artifact.artifactRole).toBe("runtime-cli-single-agent-smoke-evidence");
  expect(artifact.promptCodeRevision).toMatch(/^[a-f0-9]{40}$/u);
  expect(artifact.requiredAgents).toEqual([
    "data-availability",
    "regime-dependency",
    "homogeneity-decay",
  ]);
  expect(artifact.callBudget).toEqual({
    authorizedMinimum: 3,
    authorizedMaximum: 5,
    liveModelCallsUsed: 4,
    successfulRequiredSmokes: 3,
    failedContractAttempts: 1,
  });
  expect(artifact.attempts.map((attempt) => attempt.callIndex)).toEqual([1, 2, 3, 4]);
  expect(artifact.attempts.every((attempt) => /^[a-f0-9]{64}$/u.test(attempt.outputSha256))).toBe(
    true,
  );
  const passed = artifact.attempts.filter((attempt) => attempt.outcome === "passed");
  expect(passed.map((attempt) => attempt.agentId)).toEqual(artifact.requiredAgents);
  expect(passed.every((attempt) => attempt.contractValidated === true)).toBe(true);
  expect(artifact.assumptionsAndLimits).toHaveLength(3);
  assertOutputSafe(artifact);
});

test("locally retained smoke outputs match the recorded digests when present", () => {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    attempts: SmokeAttempt[];
  };
  const logByCall = new Map<number, string>([
    [1, ".cache/assay/run-logs/v9-smoke-data-availability-attempt1.json"],
    [2, ".cache/assay/run-logs/v9-smoke-data-availability.json"],
    [3, ".cache/assay/run-logs/v9-smoke-regime-dependency.json"],
    [4, ".cache/assay/run-logs/v9-smoke-homogeneity-decay.json"],
  ]);

  for (const attempt of artifact.attempts) {
    const relativePath = logByCall.get(attempt.callIndex);
    if (relativePath === undefined) {
      throw new Error(`missing smoke log mapping for call ${String(attempt.callIndex)}`);
    }
    const path = resolve(relativePath);
    if (!existsSync(path)) {
      continue;
    }
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      attempt.outputSha256,
    );
  }
});
