import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createAuditCheckAgentDefinitions } from "../src/definitions";
import {
  AVAILABILITY_AUDIT_SOURCE_REF,
  runAvailabilityAuditSubprocess,
} from "../src/run-availability-audit-tool";

const mockProcess = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/mock-availability-runner.mjs", import.meta.url))],
};

describe("run_availability_audit tool", () => {
  test("accepts the bounded PIT correction response", async () => {
    const result = await runAvailabilityAuditSubprocess(mockProcess, {
      kind: "availability_audit",
      spec: { specVersion: "1" },
      budget: { maxVariants: 1 },
    });

    expect(result).toEqual({
      contractVersion: "1.0.0",
      engineVersion: "mock-availability-v1",
      mode: "full_pit",
      futureConstituentCount: 12,
      affectedRebalances: ["2024-01-31", "2024-02-29"],
      sampleSymbols: ["000001.SZ", "600000.SH"],
      untradableTargets: 3,
      contaminatedSelectionRate: 0.12,
      corrected: {
        annualReturn: 0.13,
        sharpe: 0.9,
        delta: -0.04,
      },
      sourceRef: AVAILABILITY_AUDIT_SOURCE_REF,
      assumptions: [],
    });
  });

  test("rejects a contaminated-selection rate outside [0, 1]", async () => {
    await expect(
      runAvailabilityAuditSubprocess(mockProcess, {
        kind: "availability_audit",
        spec: { specVersion: "1", mockInvalidRate: true },
        budget: { maxVariants: 1 },
      }),
    ).rejects.toThrow("contaminatedSelectionRate must be between 0 and 1");
  });

  test("exposes one fixed call and the frozen evaluation policy", () => {
    const definition = createAuditCheckAgentDefinitions({
      availabilityProcess: mockProcess,
      experimentProcess: mockProcess,
    }).find((candidate) => candidate.id === "data-availability");
    const tool = definition?.tools?.[0];

    expect(tool?.name).toBe("run_availability_audit");
    expect(tool?.examples).toEqual([
      {
        caption: "Run the one approved PIT availability audit",
        call: {
          kind: "availability_audit",
          budget: { maxVariants: 1 },
        },
      },
    ]);
    expect(tool?.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        kind: { enum: ["availability_audit"] },
        budget: { properties: { maxVariants: { enum: [1] } } },
      },
    });
    const prompt = definition?.systemPrompt.join("\n") ?? "";
    expect(prompt).toContain('CHECKS_WIRING_POLICY_VERSION="1.0.0"');
    expect(prompt).toContain("|corrected.delta| < 0.02");
    expect(prompt).toContain("contaminatedSelectionRate < 0.1");
    expect(prompt).toContain(AVAILABILITY_AUDIT_SOURCE_REF);
    expect(prompt).toContain("必须且只能调用一次 run_availability_audit");
  });
});
