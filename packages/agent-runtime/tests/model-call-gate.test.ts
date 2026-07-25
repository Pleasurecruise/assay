import { describe, expect, test } from "vitest";
import { ModelCallGate } from "../src/model-call-gate";

describe("ModelCallGate", () => {
  test("caps concurrent model calls and transfers a released slot once", async () => {
    const gate = new ModelCallGate(2);
    const first = await gate.acquire();
    const second = await gate.acquire();
    let thirdAcquired = false;
    const third = gate.acquire().then((lease) => {
      thirdAcquired = true;
      return lease;
    });

    expect(first.slotId).toBe(0);
    expect(second.slotId).toBe(1);
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    second.release();
    second.release();
    const thirdLease = await third;
    expect(thirdAcquired).toBe(true);
    expect(thirdLease.slotId).toBe(1);

    first.release();
    thirdLease.release();
    const afterDrain = await gate.acquire();
    afterDrain.release();
  });

  test.each([0, -1, 1.5])("rejects invalid limit %s", (limit) => {
    expect(() => new ModelCallGate(limit)).toThrow(
      "maxConcurrentModelCalls must be a positive integer",
    );
  });
});
