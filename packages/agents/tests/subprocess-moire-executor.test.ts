import { fileURLToPath } from "node:url";
import {
  canonicalizeStrategySpec,
  hashStrategySpec,
  type CanonicalStrategySpec,
} from "@assay/contracts";
import { describe, expect, test } from "vitest";
import type { M1MoireExperiment, M2MoireExperiment } from "../src/moire";
import { SubprocessMoireExperimentExecutor } from "../src/subprocess-moire-executor";

const spec: CanonicalStrategySpec = {
  specVersion: "1",
  universe: { index: "000300.SH" },
  signal: {
    kind: "template",
    template: "momentum",
    params: { window: 20 },
  },
  selection: { topN: 50, weighting: "equal" },
  rebalance: { frequency: "monthly", at: "close" },
  window: { start: "20230101", end: "20251231" },
  costs: { model: "standard" },
};
const frozenStrategySpec = canonicalizeStrategySpec(spec);
const context = {
  auditId: "audit-moire-subprocess",
  traceId: "trace-moire-subprocess",
  subjectId: "strategy-moire-subprocess",
  dataRef:
    "assay-local-data-v1:audit_test:test-package:sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  frozenStrategySpec,
  specHash: hashStrategySpec(frozenStrategySpec),
};
const fixturePath = fileURLToPath(new URL("./fixtures/mock-moire-runner.mjs", import.meta.url));
const m1: M1MoireExperiment = {
  id: "M1",
  policyVersion: "1.0.0",
  kind: "regime_slice_of_grid",
  checkId: "param-robustness",
  pairedCheckId: "regime-dependency",
  instruction: "fixture",
  trigger: {
    parameterRetention: 0.35,
    dominantRegimePnlShare: 0.76,
  },
};
const m2: M2MoireExperiment = {
  id: "M2",
  policyVersion: "1.0.0",
  kind: "corrected_cost_ladder",
  checkId: "cost-stress",
  pairedCheckId: "data-availability",
  instruction: "fixture",
  trigger: {
    correctedAnnualReturnDelta: -0.03,
    costBaselineMode: "uncorrected",
    originalCostConclusion: "pass_with_reservations",
  },
};

describe("SubprocessMoireExperimentExecutor", () => {
  test("executes strict path-free M1 and M2 host templates", async () => {
    const executor = new SubprocessMoireExperimentExecutor({
      command: process.execPath,
      args: [fixturePath],
    });

    await expect(executor.execute(m1, context)).resolves.toEqual({
      id: "M1",
      kind: "regime_slice_of_grid",
      sourceRef:
        "artifact:moire/M1/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      dominantEnvironmentId: "up-normal",
      dominantRetention: 0.75,
      otherEnvironmentRetentions: [
        { environmentId: "down-high", retention: 0.3 },
        { environmentId: "down-normal", retention: 0.25 },
      ],
    });
    await expect(executor.execute(m2, context)).resolves.toEqual({
      id: "M2",
      kind: "corrected_cost_ladder",
      sourceRef:
        "artifact:moire/M2/sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      correctedCostConclusion: "fail",
    });
  });

  test("rejects a non-artifact source, missing data ref, and mismatched frozen hash", async () => {
    const invalidSource = new SubprocessMoireExperimentExecutor({
      command: process.execPath,
      args: [fixturePath],
      env: { MOCK_INVALID_MOIRE: "1" },
    });
    await expect(invalidSource.execute(m1, context)).rejects.toThrow(
      "content-addressed artifact:moire/M1 reference",
    );
    await expect(
      invalidSource.execute(m1, {
        ...context,
        dataRef: " ",
      }),
    ).rejects.toThrow("Moiré subprocess dataRef must be a non-empty string");
    await expect(
      invalidSource.execute(m1, {
        ...context,
        specHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      }),
    ).rejects.toThrow("host-frozen strategy");
  });
});
