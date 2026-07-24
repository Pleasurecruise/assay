import { describe, expect, test } from "vitest";
import {
  canonicalizeStrategySpec,
  hashStrategySpec,
  parseStrategyAuditRequest,
  parseStrategySpec,
  toCanonicalStrategySpec,
  validateStrategySpec,
} from "../src";

function completeTemplateSpec(): Record<string, unknown> {
  return {
    specVersion: "1",
    universe: { index: "000300.SH" },
    signal: {
      kind: "template",
      template: "momentum",
      params: { window: 20 },
    },
    selection: { topN: 50, weighting: "equal" },
    rebalance: { frequency: "monthly", at: "close" },
    window: { start: "20210101", end: "20251231" },
    costs: { model: "standard" },
    claims: { annualReturn: 0.18, sharpe: 1.9 },
  };
}

describe("StrategySpec contract", () => {
  test("aggregates every missing required field", () => {
    const result = validateStrategySpec({
      specVersion: "1",
      universe: {},
      selection: {},
      rebalance: {},
      window: { end: "20251231" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected validation to fail");
    }
    expect(result.reasonCode).toBe("insufficient_information");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.signal",
        "$.universe.index",
        "$.selection.topN",
        "$.rebalance.frequency",
        "$.window.start",
      ]),
    );
  });

  test.each([
    [{ kind: "formula", expr: "RANK(CLOSE/DELAY(CLOSE,20))" }, "$.signal.kind"],
    [{ kind: "python", code: "def factor(frame): return frame.close" }, "$.signal.kind"],
    [{ kind: "template", template: "custom_python", params: {} }, "$.signal.template"],
  ])("classifies out-of-family signal %j as unsupported", (signal, expectedPath) => {
    const result = validateStrategySpec({
      ...completeTemplateSpec(),
      signal,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected validation to fail");
    }
    expect(result.reasonCode).toBe("unsupported_input");
    expect(result.issues.some((issue) => issue.path === expectedPath)).toBe(true);
  });

  test.each([
    ["topN below range", { selection: { topN: 0, weighting: "equal" } }],
    ["topN above range", { selection: { topN: 201, weighting: "equal" } }],
    ["window exceeds five years", { window: { start: "20200101", end: "20250102" } }],
    ["invalid calendar date", { window: { start: "20210229", end: "20251231" } }],
  ])("rejects %s without silently coercing it", (_name, replacement) => {
    const result = validateStrategySpec({
      ...completeTemplateSpec(),
      ...replacement,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected validation to fail");
    }
    expect(result.reasonCode).toBe("insufficient_information");
  });

  test("rejects an end date later than the provider data cutoff", () => {
    const result = validateStrategySpec(completeTemplateSpec(), {
      dataAsOf: "2025-12-30",
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected validation to fail");
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "$.window.end",
        code: "invalid_value",
      }),
    );
  });

  test("uses a verified library-factor catalog only when one is supplied", () => {
    const value = {
      ...completeTemplateSpec(),
      signal: { kind: "library", name: "quality_factor" },
    };

    expect(validateStrategySpec(value).success).toBe(true);
    expect(
      validateStrategySpec(value, {
        availableLibraryFactors: new Set(["momentum_factor"]),
      }),
    ).toEqual(
      expect.objectContaining({
        success: false,
        reasonCode: "unsupported_input",
      }),
    );
    expect(
      validateStrategySpec(value, {
        availableLibraryFactors: ["quality_factor"],
      }).success,
    ).toBe(true);
  });

  test("expands defaults and normalizes the index in the canonical object", () => {
    const parsed = parseStrategySpec({
      specVersion: "1",
      universe: { index: "000300.sh" },
      signal: { kind: "template", template: "volatility", params: {} },
      selection: { topN: 50 },
      rebalance: { frequency: "monthly" },
      window: { start: "20210101", end: "20251231" },
    });

    expect(toCanonicalStrategySpec(parsed)).toEqual({
      specVersion: "1",
      universe: { index: "000300.SH" },
      signal: {
        kind: "template",
        template: "volatility",
        params: { window: 20, direction: "low" },
      },
      selection: { topN: 50, weighting: "equal" },
      rebalance: { frequency: "monthly", at: "close" },
      window: { start: "20210101", end: "20251231" },
      costs: { model: "standard" },
    });
  });

  test("canonical serialization and hash are stable across key order and explicit defaults", () => {
    const first = parseStrategySpec({
      specVersion: "1",
      universe: { index: "000300.sh" },
      signal: { kind: "template", template: "momentum" },
      selection: { topN: 50 },
      rebalance: { frequency: "monthly" },
      window: { start: "20210101", end: "20251231" },
    });
    const second = parseStrategySpec({
      costs: { model: "standard" },
      window: { end: "20251231", start: "20210101" },
      rebalance: { at: "close", frequency: "monthly" },
      selection: { weighting: "equal", topN: 50 },
      signal: { params: { window: 20 }, template: "momentum", kind: "template" },
      universe: { index: "000300.SH" },
      specVersion: "1",
    });

    const firstBytes = canonicalizeStrategySpec(first);
    const secondBytes = canonicalizeStrategySpec(second);
    expect(firstBytes).toBe(
      '{"specVersion":"1","universe":{"index":"000300.SH"},"signal":{"kind":"template","template":"momentum","params":{"window":20}},"selection":{"topN":50,"weighting":"equal"},"rebalance":{"frequency":"monthly","at":"close"},"window":{"start":"20210101","end":"20251231"},"costs":{"model":"standard"}}',
    );
    expect(secondBytes).toBe(firstBytes);
    expect(hashStrategySpec(secondBytes)).toBe(hashStrategySpec(firstBytes));
    expect(hashStrategySpec(`${firstBytes}\n`)).not.toBe(hashStrategySpec(firstBytes));
    expect(hashStrategySpec(firstBytes)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("parses the structured request with the existing skill and subject vocabulary", () => {
    const request = parseStrategyAuditRequest({
      requestSchemaVersion: "1.0.0",
      skill: "audit_strategy",
      subject: {
        id: "strategy_01",
        input: {
          kind: "strategy_spec",
          spec: completeTemplateSpec(),
        },
      },
    });

    expect(request.skill).toBe("audit_strategy");
    expect(request.subject.id).toBe("strategy_01");
    expect(request.subject.input.spec.specVersion).toBe("1");
  });
});
