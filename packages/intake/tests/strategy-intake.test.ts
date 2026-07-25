import { describe, expect, test } from "vitest";
import { hashStrategySpec } from "@assay/contracts";
import { StrategyIntake, type NaturalLanguageStrategyParser } from "../src";

const completeCandidate = {
  specVersion: "1",
  universe: { index: "000300.sh" },
  signal: { kind: "template", template: "momentum", params: {} },
  selection: { topN: 50 },
  rebalance: { frequency: "monthly" },
  window: { start: "20210101", end: "20251231" },
};

function createIntake(parser: NaturalLanguageStrategyParser): StrategyIntake {
  return new StrategyIntake({
    parser,
    dataAsOf: "2026-07-23",
    capabilitySnapshotId: "skeleton:static",
    codeRevision: "test-revision",
  });
}

describe("StrategyIntake", () => {
  test("validates, expands defaults, and hashes exactly the frozen subject bytes", async () => {
    const intake = createIntake({
      parse: async () => completeCandidate,
    });

    const result = await intake.intakeText("complete strategy");
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      throw new Error("Expected ready intake result");
    }

    expect(result.frozen.spec.universe.index).toBe("000300.SH");
    expect(result.frozen.spec.selection.weighting).toBe("equal");
    expect(result.frozen.spec.rebalance.at).toBe("close");
    expect(result.frozen.spec.costs.model).toBe("standard");
    expect(result.frozen.defaultsApplied).toEqual([
      "signal.params.window=20",
      "selection.weighting=equal",
      "rebalance.at=close",
      "costs.model=standard",
    ]);
    expect(result.frozen.specHash).toBe(hashStrategySpec(result.frozen.canonicalJson));
    expect(JSON.parse(result.frozen.canonicalJson)).toEqual(result.frozen.spec);
  });

  test("uses the sprint trailing-three-year rung when the input omits a window", async () => {
    const { window: _window, ...withoutWindow } = completeCandidate;
    const intake = createIntake({
      parse: async () => withoutWindow,
    });

    const result = await intake.intakeText("strategy without an explicit period");

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      throw new Error("Expected ready intake result");
    }
    expect(result.frozen.spec.window).toEqual({
      start: "20230723",
      end: "20260723",
    });
    expect(result.frozen.defaultsApplied).toContain(
      "window=20230723..20260723 (sprint trailing-3y default)",
    );
  });

  test("normalizes the two known sprint parser quirks without changing the contract", async () => {
    const intake = createIntake({
      parse: async () => ({
        ...completeCandidate,
        universe: { index: "000300" },
        signal: {
          kind: "template",
          template: "momentum",
          params: { window: 20, direction: "high" },
        },
      }),
    });

    const result = await intake.intakeText("沪深 300 动量");

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      throw new Error("Expected ready intake result");
    }
    expect(result.frozen.spec.universe.index).toBe("000300.SH");
    expect(result.frozen.spec.signal).toEqual({
      kind: "template",
      template: "momentum",
      params: { window: 20 },
    });
  });

  test("normalizes an explicit annual-return percentage to a decimal ratio", async () => {
    const intake = createIntake({
      parse: async () => ({
        ...completeCandidate,
      }),
    });

    const result = await intake.intakeText(
      "沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9",
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      throw new Error("Expected ready intake result");
    }
    expect(result.frozen.spec.claims?.annualReturn).toBe(0.18);
    expect(result.frozen.spec.claims?.sharpe).toBe(1.9);
    expect(result.frozen.claims).toEqual({ annualReturn: 0.18, sharpe: 1.9 });
    expect(Object.hasOwn(result.frozen.strategy, "claims")).toBe(false);
  });

  test("keeps the claims-free strategy projection stable when only claims change", async () => {
    const first = await createIntake({
      parse: async () => completeCandidate,
    }).intakeText("沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9");
    const second = await createIntake({
      parse: async () => completeCandidate,
    }).intakeText("沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 30% 夏普 3.0");

    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    if (first.kind !== "ready" || second.kind !== "ready") {
      throw new Error("Expected ready intake results");
    }
    expect(first.frozen.strategy).toEqual(second.frozen.strategy);
    expect(first.frozen.claims).toEqual({ annualReturn: 0.18, sharpe: 1.9 });
    expect(second.frozen.claims).toEqual({ annualReturn: 0.3, sharpe: 3 });
    expect(first.frozen.specHash).not.toBe(second.frozen.specHash);
  });

  test("returns every missing field as an insufficient-information early exit", async () => {
    const intake = createIntake({
      parse: async () => ({
        specVersion: "1",
        universe: { index: "000300.SH" },
        window: {},
      }),
    });

    const result = await intake.intakeText("沪深 300 动量策略");
    expect(result).toMatchObject({
      kind: "early_exit",
      reasonCode: "insufficient_information",
    });
    if (result.kind !== "early_exit") {
      throw new Error("Expected early exit");
    }
    expect(result.missingInformation.length).toBeGreaterThanOrEqual(4);
  });

  test("allows prose containing one code-like phrase to reach the model parser", async () => {
    let parserInput: string | undefined;
    const intake = createIntake({
      parse: async (input) => {
        parserInput = input;
        return completeCandidate;
      },
    });

    const input = "import signals from the factor library";
    const result = await intake.intakeText(input);

    expect(result.kind).toBe("ready");
    expect(parserInput).toBe(input);
  });

  test("rejects executable Python with two distinct code patterns before parsing", async () => {
    let parserCalled = false;
    const intake = createIntake({
      parse: async () => {
        parserCalled = true;
        return completeCandidate;
      },
    });

    const result = await intake.intakeText(
      "import pandas as pd\ndef signal(frame):\n    return frame.close",
    );
    expect(result).toMatchObject({
      kind: "early_exit",
      reasonCode: "unsupported_input",
    });
    expect(parserCalled).toBe(false);
  });

  test("early-exits when the baseline window is outside the audited grid support", async () => {
    const intake = createIntake({
      parse: async () => ({
        ...completeCandidate,
        signal: { kind: "template", template: "momentum", params: { window: 60 } },
      }),
    });

    const result = await intake.intakeText("沪深 300 六十日动量");

    expect(result).toMatchObject({
      kind: "early_exit",
      reasonCode: "unsupported_input",
    });
    if (result.kind !== "early_exit") {
      throw new Error("Expected early exit");
    }
    expect(
      result.issues.some(
        (issue) =>
          issue.path === "/signal/params/window" && issue.code === "parameter_outside_audited_grid",
      ),
    ).toBe(true);
  });

  test("early-exits when topN is outside the audited grid support", async () => {
    const intake = createIntake({
      parse: async () => ({
        ...completeCandidate,
        selection: { topN: 40 },
      }),
    });

    const result = await intake.intakeText("沪深 300 动量前 40 只");

    expect(result).toMatchObject({
      kind: "early_exit",
      reasonCode: "unsupported_input",
    });
    if (result.kind !== "early_exit") {
      throw new Error("Expected early exit");
    }
    expect(
      result.issues.some(
        (issue) =>
          issue.path === "/selection/topN" && issue.code === "parameter_outside_audited_grid",
      ),
    ).toBe(true);
  });

  test("does not let a legacy intake option override the frozen sprint grid", async () => {
    const intake = new StrategyIntake({
      parser: {
        parse: async () => ({
          ...completeCandidate,
          selection: { topN: 40 },
        }),
      },
      dataAsOf: "2026-07-23",
      capabilitySnapshotId: "skeleton:static",
      codeRevision: "test-revision",
      // @ts-expect-error The sprint grid is contract-owned and not configurable at Intake.
      parameterGridSupport: { windows: [20], topN: [40] },
    });

    const result = await intake.intakeText("尝试覆盖冻结支持域的策略");

    expect(result).toMatchObject({
      kind: "early_exit",
      reasonCode: "unsupported_input",
    });
  });

  test("rejects a fenced code block without requiring a second code pattern", async () => {
    let parserCalled = false;
    const intake = createIntake({
      parse: async () => {
        parserCalled = true;
        return completeCandidate;
      },
    });

    const result = await intake.intakeText("```python\nprint('signal')\n```");

    expect(result).toMatchObject({
      kind: "early_exit",
      reasonCode: "unsupported_input",
    });
    expect(parserCalled).toBe(false);
  });
});
