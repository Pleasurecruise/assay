import { describe, expect, test } from "vitest";
import { ModelCallGate } from "../src/model-call-gate";

describe("ModelCallGate", () => {
  test("caps concurrent model calls and transfers a released slot once", async () => {
    const gate = new ModelCallGate(2);
    const releaseFirst = await gate.acquire();
    const releaseSecond = await gate.acquire();
    let thirdAcquired = false;
    const third = gate.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    releaseFirst();
    releaseFirst();
    const releaseThird = await third;
    expect(thirdAcquired).toBe(true);

    releaseSecond();
    releaseThird();
    const releaseAfterDrain = await gate.acquire();
    releaseAfterDrain();
  });

  test.each([0, -1, 1.5])("rejects invalid limit %s", (limit) => {
    expect(() => new ModelCallGate(limit)).toThrow(
      "maxConcurrentModelCalls must be a positive integer",
    );
  });
});
