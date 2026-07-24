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

  test("returns every missing field as an insufficient-information early exit", async () => {
    const intake = createIntake({
      parse: async () => ({
        specVersion: "1",
        universe: { index: "000300.SH" },
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
