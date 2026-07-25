import { fileURLToPath } from "node:url";
import { toCanonicalStrategySpec } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import {
  claimComparisonTriggersWatchCap,
  SubprocessClaimReproducer,
} from "../src/claim-reproducer";

const mockProcess = {
  command: process.execPath,
  args: [
    fileURLToPath(
      new URL(
        "../../../packages/agents/tests/fixtures/mock-experiment-runner.mjs",
        import.meta.url,
      ),
    ),
  ],
};
const DATA_REF =
  "assay-local-data-v1:audit_test:g01:sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const spec = toCanonicalStrategySpec({
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
  claims: { annualReturn: 0.18, sharpe: 2 },
});

describe("SubprocessClaimReproducer", () => {
  test("reproduces claims under the frozen as-of and no-cost convention", async () => {
    const comparison = await new SubprocessClaimReproducer(mockProcess).reproduce(spec, DATA_REF);

    expect(comparison).toEqual({
      claimed: { annualReturn: 0.18, sharpe: 2 },
      reproduced: {
        annualReturn: 0.12,
        sharpe: 1.3,
        maxDrawdown: -0.09,
      },
      gaps: {
        annualReturn: 0.06,
        sharpe: 0.7,
      },
      knownConventionDiffs: [],
    });
    expect(claimComparisonTriggersWatchCap(comparison)).toBe(true);
  });

  test("does not run a process when the frozen spec has no claims", async () => {
    const withoutClaims = toCanonicalStrategySpec({
      ...spec,
      claims: undefined,
    });
    const comparison = await new SubprocessClaimReproducer({
      command: "this-command-must-not-run",
    }).reproduce(withoutClaims, DATA_REF);

    expect(comparison).toBeNull();
  });

  test("does not cap a disclosed convention difference", () => {
    expect(
      claimComparisonTriggersWatchCap({
        claimed: { sharpe: 2 },
        reproduced: { annualReturn: 0.12, sharpe: 1.3, maxDrawdown: -0.09 },
        gaps: { sharpe: 0.7 },
        knownConventionDiffs: ["The submitted ClaimProfile uses a different close convention."],
      }),
    ).toBe(false);
  });
});
