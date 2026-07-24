import { canonicalizeStrategySpec, hashStrategySpec, type StrategySpec } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import {
  assertExactRunExperimentCompletion,
  guardRuntimeToolCall,
} from "../src/runtime-tool-guard";

const strategySpec = {
  specVersion: "1",
  universe: { index: "000300.SH" },
  signal: {
    kind: "template",
    template: "momentum",
    params: { window: 20 },
  },
  selection: { topN: 50 },
  rebalance: { frequency: "monthly" },
  window: { start: "20230101", end: "20251231" },
} as const satisfies StrategySpec;

function specHash(value: StrategySpec): string {
  return hashStrategySpec(canonicalizeStrategySpec(value));
}

describe("guardRuntimeToolCall", () => {
  test("injects one host-frozen spec whose canonical bytes match the frozen hash", () => {
    const args: Record<string, unknown> = {
      kind: "grid",
      budget: { maxVariants: 15 },
    };
    expect(
      guardRuntimeToolCall(
        "run_experiment",
        args,
        specHash(strategySpec),
        canonicalizeStrategySpec(strategySpec),
        0,
      ),
    ).toEqual({ runExperimentCallCount: 1 });
    expect(args.spec).toEqual(JSON.parse(canonicalizeStrategySpec(strategySpec)));
  });

  test("applies the same one-call trusted-spec binding to the availability audit", () => {
    const args: Record<string, unknown> = {
      kind: "availability_audit",
      budget: { maxVariants: 1 },
    };
    expect(
      guardRuntimeToolCall(
        "run_availability_audit",
        args,
        specHash(strategySpec),
        canonicalizeStrategySpec(strategySpec),
        0,
      ),
    ).toEqual({ runExperimentCallCount: 1 });
    expect(args.spec).toEqual(JSON.parse(canonicalizeStrategySpec(strategySpec)));

    expect(
      guardRuntimeToolCall(
        "run_availability_audit",
        {},
        specHash(strategySpec),
        canonicalizeStrategySpec(strategySpec),
        1,
      ),
    ).toEqual({
      runExperimentCallCount: 2,
      blockReason: "run_availability_audit may be called at most once per task",
    });
  });

  test("applies the same one-call trusted-spec binding to the homogeneity audit", () => {
    const args: Record<string, unknown> = {
      kind: "homogeneity",
      budget: { maxVariants: 1 },
    };
    expect(
      guardRuntimeToolCall(
        "run_homogeneity",
        args,
        specHash(strategySpec),
        canonicalizeStrategySpec(strategySpec),
        0,
      ),
    ).toEqual({ runExperimentCallCount: 1 });
    expect(args.spec).toEqual(JSON.parse(canonicalizeStrategySpec(strategySpec)));

    expect(
      guardRuntimeToolCall(
        "run_homogeneity",
        {},
        specHash(strategySpec),
        canonicalizeStrategySpec(strategySpec),
        1,
      ),
    ).toEqual({
      runExperimentCallCount: 2,
      blockReason: "run_homogeneity may be called at most once per task",
    });
  });

  test.each([
    ["missing hash", undefined],
    ["invalid hash", "not-a-sha256-digest"],
  ])("fails closed when the task has a %s", (_label, expectedHash) => {
    const result = guardRuntimeToolCall(
      "run_experiment",
      {},
      expectedHash,
      canonicalizeStrategySpec(strategySpec),
      0,
    );

    expect(result).toEqual({
      runExperimentCallCount: 1,
      blockReason: "run_experiment is not authorized for this task",
    });
  });

  test("overwrites model-controlled spec content without echoing it", () => {
    const sensitiveValue = "Bearer secret at /Users/example/private.json";
    const args: Record<string, unknown> = { spec: { sensitiveValue } };
    const result = guardRuntimeToolCall(
      "run_experiment",
      args,
      specHash(strategySpec),
      canonicalizeStrategySpec(strategySpec),
      0,
    );

    expect(result).toEqual({ runExperimentCallCount: 1 });
    expect(JSON.stringify(args)).not.toContain(sensitiveValue);
    expect(JSON.stringify(args)).not.toContain("/Users/");
    expect(JSON.stringify(args)).not.toContain("Bearer");
  });

  test("fails closed when the trusted canonical spec does not match the frozen hash", () => {
    const changedSpec: StrategySpec = {
      ...strategySpec,
      selection: { topN: 30 },
    };
    const expectedHash = specHash(strategySpec);
    const changedHash = specHash(changedSpec);
    const result = guardRuntimeToolCall(
      "run_experiment",
      {},
      expectedHash,
      canonicalizeStrategySpec(changedSpec),
      0,
    );

    expect(result.blockReason).toBe("run_experiment is not authorized for this task");
    expect(result.blockReason).not.toContain(expectedHash);
    expect(result.blockReason).not.toContain(changedHash);
  });

  test.each([
    ["missing trusted spec", undefined],
    ["invalid trusted JSON", "{not-json"],
    ["noncanonical trusted JSON", JSON.stringify(strategySpec, null, 2)],
  ])("fails closed on %s", (_label, trustedCanonicalSpec) => {
    expect(
      guardRuntimeToolCall("run_experiment", {}, specHash(strategySpec), trustedCanonicalSpec, 0),
    ).toEqual({
      runExperimentCallCount: 1,
      blockReason: "run_experiment is not authorized for this task",
    });
  });

  test("blocks every run_experiment attempt after the first", () => {
    const first = guardRuntimeToolCall(
      "run_experiment",
      {},
      specHash(strategySpec),
      canonicalizeStrategySpec(strategySpec),
      0,
    );
    const second = guardRuntimeToolCall(
      "run_experiment",
      {},
      specHash(strategySpec),
      canonicalizeStrategySpec(strategySpec),
      first.runExperimentCallCount,
    );

    expect(second).toEqual({
      runExperimentCallCount: 2,
      blockReason: "run_experiment may be called at most once per task",
    });
  });

  test("does not change the behavior or call count of other tools", () => {
    expect(guardRuntimeToolCall("market_data", {}, undefined, undefined, 0)).toEqual({
      runExperimentCallCount: 0,
    });
  });
});

describe("assertExactRunExperimentCompletion", () => {
  test("accepts exactly one successful call when the tool is required", () => {
    expect(() => assertExactRunExperimentCompletion(true, 1, 1)).not.toThrow();
  });

  test.each([
    [0, 0],
    [1, 0],
    [2, 1],
    [2, 2],
  ])("rejects attempted=%i successful=%i", (attempted, successful) => {
    expect(() => assertExactRunExperimentCompletion(true, attempted, successful)).toThrow(
      "run_experiment must complete successfully exactly once",
    );
  });

  test("does not constrain agents without the experiment tool", () => {
    expect(() => assertExactRunExperimentCompletion(false, 0, 0)).not.toThrow();
  });
});
