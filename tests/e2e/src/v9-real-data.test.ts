import { TaskState, type Task } from "@a2a-js/sdk";
import { expect, test } from "vitest";
import { loadV9OfflineMechanismFixture } from "./v9-real-data.fixture";
import {
  assertV9PitTimelineManifest,
  assertV9RealMechanism,
  assertV9TaskCompleted,
  runV9RealAcceptance,
  V9_REAL_ARTIFACT_PATH,
} from "./v9-real-data";

const enabled = process.env.ASSAY_V9_E2E === "1" && Reflect.has(globalThis, "Bun");
const liveTest = enabled ? test : test.skip;

test("accepts a provenance-bound offline mechanism fixture", async () => {
  const bundle = await loadV9OfflineMechanismFixture();

  expect(assertV9RealMechanism(bundle)).toEqual(bundle);
  expect(() =>
    assertV9RealMechanism({
      ...bundle,
      cacheSnapshot: {
        ...bundle.cacheSnapshot,
        priceSources: {
          ...bundle.cacheSnapshot.priceSources,
          fallbackFillCount: 0,
        },
      },
    }),
  ).toThrow(/fallback counts/u);
});

test("freezes 36 completed month ends plus one terminal PIT observation", () => {
  const dataAsOf = "2026-07-23";
  const memberCounts = Object.fromEntries(
    Array.from({ length: 36 }, (_, index) => [
      `202${String(3 + Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, "0")}-28`,
      300,
    ]),
  );
  memberCounts[dataAsOf] = 300;
  const timeline = {
    status: "ready",
    path: "pit-availability-v1/index-weights/000300_SH",
    completedMonthEnds: 36,
    terminalAsOf: [dataAsOf],
    quality: {
      pointCount: 37,
      terminalAsOfIsNotMonthEnd: true,
      memberCounts,
    },
  };

  expect(() => assertV9PitTimelineManifest(timeline, dataAsOf)).not.toThrow();
  expect(() =>
    assertV9PitTimelineManifest(
      {
        ...timeline,
        quality: { ...timeline.quality, pointCount: 36 },
      },
      dataAsOf,
    ),
  ).toThrow(/37 bounded membership observations/u);
  expect(() =>
    assertV9PitTimelineManifest(
      {
        ...timeline,
        terminalAsOf: ["2026-07-31"],
      },
      dataAsOf,
    ),
  ).toThrow(/36 completed month ends/u);
});

test("reports a safe terminal task stage before attempting Artifact extraction", () => {
  const failed = {
    status: {
      state: TaskState.TASK_STATE_FAILED,
      message: {
        metadata: {
          stage: "strategy_intake",
          correlationId: "1f8f01b7-f69e-4c3a-9f2f-d900648d77a8",
        },
      },
    },
  } as unknown as Pick<Task, "status">;
  expect(() => assertV9TaskCompleted(failed)).toThrow(
    "state=FAILED stage=strategy_intake correlationId=1f8f01b7-f69e-4c3a-9f2f-d900648d77a8",
  );

  const hostile = {
    status: {
      state: TaskState.TASK_STATE_FAILED,
      message: {
        metadata: {
          stage: "sk-live-secret-token",
          correlationId: "ep-secret-credential",
        },
      },
    },
  } as unknown as Pick<Task, "status">;
  let message = "";
  try {
    assertV9TaskCompleted(hostile);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("stage=unknown correlationId=unavailable");
  expect(message).not.toMatch(/secret|token|credential/u);

  const completed = {
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
    },
  } as Pick<Task, "status">;
  expect(() => assertV9TaskCompleted(completed)).not.toThrow();
});

liveTest(
  "runs the one terminal real-data five-check acceptance",
  async () => {
    await expect(runV9RealAcceptance()).resolves.toBe(V9_REAL_ARTIFACT_PATH);
  },
  360_000,
);
