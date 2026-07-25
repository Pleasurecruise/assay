import {
  strategyForData,
  toCanonicalStrategySpec,
  type CanonicalStrategySpec,
} from "@assay/contracts";
import { describe, expect, test } from "vitest";
import { DeterministicStrategyDataPlanner, strategyDataKey } from "../src";

function goldenSpec(claims = { annualReturn: 0.18, sharpe: 1.9 }): CanonicalStrategySpec {
  return toCanonicalStrategySpec({
    specVersion: "1",
    universe: { index: "000300.SH" },
    signal: {
      kind: "template",
      template: "momentum",
      params: { window: 20 },
    },
    selection: { topN: 50, weighting: "equal" },
    rebalance: { frequency: "monthly", at: "close" },
    window: { start: "20230723", end: "20260723" },
    costs: { model: "standard" },
    claims,
  });
}

describe("DeterministicStrategyDataPlanner", () => {
  test("produces the stable claims-free local plan for the golden strategy", () => {
    const strategy = strategyForData(goldenSpec());
    const plan = new DeterministicStrategyDataPlanner().plan(strategy);

    expect(plan).toEqual({
      schemaVersion: "assay-local-data-plan-v1",
      strategyKey: "sha256-a9d796047db6ccb208f3d82df70287afbb50ddca1fd544f67718155a4dc1bddb",
      indexSymbol: "000300.SH",
      window: { start: "20230723", end: "20260723" },
      requiredCoverage: { start: "2023-07-23", end: "2026-07-23" },
      requirements: [
        "trade_calendar",
        "pit_membership",
        "adjusted_close",
        "trade_status",
        "index_daily",
        "comparator_factors",
      ],
    });
    expect(strategyDataKey(strategy)).toBe(plan.strategyKey);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    expect(plan).not.toHaveProperty("operation");
    expect(JSON.stringify(plan)).not.toMatch(/"operation"|"fields"|"factors"/);
  });

  test("produces an identical plan when only claims change", () => {
    const planner = new DeterministicStrategyDataPlanner();
    const first = planner.plan(strategyForData(goldenSpec()));
    const second = planner.plan(strategyForData(goldenSpec({ annualReturn: 0.3, sharpe: 3 })));

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("changes the strategy key and local identity when strategy fields change", () => {
    const changed = toCanonicalStrategySpec({
      ...goldenSpec(),
      universe: { index: "399300.SZ" },
      rebalance: { frequency: "weekly", at: "close" },
      window: { start: "20240102", end: "20251231" },
    });

    const plan = new DeterministicStrategyDataPlanner().plan(strategyForData(changed));

    expect(plan.strategyKey).not.toBe(
      "sha256-a9d796047db6ccb208f3d82df70287afbb50ddca1fd544f67718155a4dc1bddb",
    );
    expect(plan.indexSymbol).toBe("399300.SZ");
    expect(plan.window).toEqual({ start: "20240102", end: "20251231" });
    expect(plan.requiredCoverage).toEqual({
      start: "2024-01-02",
      end: "2025-12-31",
    });
  });

  test("requires local signal factors only for non-price signals", () => {
    const library = toCanonicalStrategySpec({
      ...goldenSpec(),
      signal: { kind: "library", name: "quality_score" },
    });

    const plan = new DeterministicStrategyDataPlanner().plan(strategyForData(library));

    expect(plan.requirements.at(-1)).toBe("strategy_signal_factors");
  });

  test("reuses the same market package when only the execution cost model changes", () => {
    const planner = new DeterministicStrategyDataPlanner();
    const standard = planner.plan(strategyForData(goldenSpec()));
    const noCosts = planner.plan(
      strategyForData(
        toCanonicalStrategySpec({
          ...goldenSpec(),
          costs: { model: "none" },
        }),
      ),
    );

    expect(noCosts).toEqual(standard);
  });

  test("does not accept a claims-bearing canonical spec at its type boundary", () => {
    const planner = new DeterministicStrategyDataPlanner();
    const claimsBearingSpec = goldenSpec();
    const compileTimeBoundary = (): void => {
      // @ts-expect-error Data planning must use strategyForData first.
      planner.plan(claimsBearingSpec);
    };

    expect(compileTimeBoundary).toBeTypeOf("function");
  });
});
