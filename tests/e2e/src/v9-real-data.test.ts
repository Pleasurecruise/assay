import { TaskState, type Task } from "@a2a-js/sdk";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import {
  acceptanceCandidateFromV9MechanismFixture,
  loadV9OfflineMechanismFixture,
} from "./v9-real-data.fixture";
import {
  assertV9GoldenSuiteStructure,
  assertV9PitTimelineManifest,
  assertV9RealMechanism,
  assertV9TaskCompleted,
  persistV9UnacceptedDiagnostic,
  replayV9RealMechanism,
  runV9RealAcceptance,
  v9UnacceptedDiagnosticPath,
  V9_GOLDEN_SUITE_ARTIFACT_PATH,
  V9_GOLDEN_SUITE_VERSION,
  V9_REAL_BUNDLE_VERSION,
  V9_REAL_DATA_MODE,
  V9_REAL_POLL_TIMEOUT_MS,
  V9_UNACCEPTED_DIAGNOSTIC_VERSION,
  type V9RealAcceptanceBundle,
} from "./v9-real-data";
import { formatV9ReplayReport, replayV9CandidateFile } from "./replay-v9-real";
import { GOLDEN_SHARED_RUNTIME_CHECKSUMS, GOLDEN_STRATEGY_CASES } from "./golden-cases";

const enabled = process.env.ASSAY_V9_E2E === "1" && Reflect.has(globalThis, "Bun");
const liveTest = enabled ? test : test.skip;

test("accepts a provenance-bound offline mechanism fixture", async () => {
  const fixture = await loadV9OfflineMechanismFixture();
  const bundle = acceptanceCandidateFromV9MechanismFixture(fixture);

  expect(fixture.artifactRole).toBe("mechanism-fixture");
  expect(fixture.candidate).not.toHaveProperty("artifactRole");
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

test("freezes the three-case suite envelope in G01, G02, G03 order", async () => {
  const fixture = await loadV9OfflineMechanismFixture();
  const bundle = acceptanceCandidateFromV9MechanismFixture(fixture);
  const suite = {
    schemaVersion: V9_GOLDEN_SUITE_VERSION,
    artifactRole: "real-data-acceptance-suite",
    generatedAt: bundle.generatedAt,
    codeRevision: bundle.codeRevision,
    registryCapabilityDigest: `sha256-${"a".repeat(64)}`,
    sharedChecksums: GOLDEN_SHARED_RUNTIME_CHECKSUMS,
    cases: GOLDEN_STRATEGY_CASES.map((goldenCase, index) => ({
      label: goldenCase.label,
      packageId: goldenCase.packageId,
      strategyKey: goldenCase.strategyKey,
      runtimeManifestDigest: `sha256-${String(index + 1).repeat(64)}`,
      acceptance: {
        ...bundle,
        schemaVersion: V9_REAL_BUNDLE_VERSION,
        artifactRole: "real-data-acceptance",
        input: goldenCase.input,
        dataMode: V9_REAL_DATA_MODE,
      },
    })),
  };

  expect(() => assertV9GoldenSuiteStructure(suite)).not.toThrow();
  expect(() =>
    assertV9GoldenSuiteStructure({
      ...suite,
      cases: [...suite.cases].reverse(),
    }),
  ).toThrow(/frozen G01, G02, G03 order/u);
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
    path: "pit-membership/index-weights/000300_SH",
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

test("isolates a safe unaccepted candidate from the formal Artifact path", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "assay-v9-diagnostic-"));
  try {
    const bundle = acceptanceCandidateFromV9MechanismFixture(await loadV9OfflineMechanismFixture());
    const diagnosticPath = v9UnacceptedDiagnosticPath(bundle, temporaryRoot);

    const diagnostic = await persistV9UnacceptedDiagnostic(bundle, temporaryRoot);
    const serialized = await readFile(diagnosticPath, "utf8");

    expect(diagnostic).toMatchObject({
      schemaVersion: V9_UNACCEPTED_DIAGNOSTIC_VERSION,
      artifactRole: "unaccepted-diagnostic",
      acceptanceStatus: "unaccepted",
      reasonCode: "PRE_ASSERTION_CANDIDATE",
      capturedFrom: "completed-a2a-task",
    });
    expect(diagnostic.candidate).not.toHaveProperty("artifactRole");
    expect(() => assertV9RealMechanism(diagnostic)).toThrow(/bundle\.artifactRole/u);
    expect(
      assertV9RealMechanism({
        ...diagnostic.candidate,
        artifactRole: "real-data-acceptance",
      }),
    ).toEqual(bundle);
    expect(serialized).not.toContain(temporaryRoot);
    if (process.platform !== "win32") {
      expect((await stat(diagnosticPath)).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(temporaryRoot)).toEqual([basename(diagnosticPath)]);
    const replayed = await replayV9CandidateFile(diagnosticPath);
    expect(replayed.passed).toBe(true);
    expect(formatV9ReplayReport(replayed)).toContain('"summary":"PASS","assertionCount":');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("keeps a rejected candidate while leaving any formal Artifact untouched", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "assay-v9-rejected-"));
  try {
    const formalPath = join(temporaryRoot, "formal.json");
    const sentinel = '{"formal":"previous-accepted-bytes"}\n';
    await writeFile(formalPath, sentinel, "utf8");
    const bundle = acceptanceCandidateFromV9MechanismFixture(await loadV9OfflineMechanismFixture());
    const diagnosticPath = v9UnacceptedDiagnosticPath(bundle, temporaryRoot);
    const result = bundle.artifact.results[0];
    if (result === undefined) {
      throw new Error("offline fixture omitted its strategy result");
    }
    const rejected: V9RealAcceptanceBundle = {
      ...bundle,
      artifact: {
        ...bundle.artifact,
        results: [{ ...result, verdict: result.verdict === "KEEP" ? "WATCH" : "KEEP" }],
      },
    };

    await persistV9UnacceptedDiagnostic(rejected, temporaryRoot);

    expect(() => assertV9RealMechanism(rejected)).toThrow(/verdict\.productionPolicy/u);
    expect(await readFile(formalPath, "utf8")).toBe(sentinel);
    expect(JSON.parse(await readFile(diagnosticPath, "utf8"))).toMatchObject({
      artifactRole: "unaccepted-diagnostic",
      reasonCode: "PRE_ASSERTION_CANDIDATE",
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses to persist an unsafe candidate diagnostic", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "assay-v9-unsafe-"));
  try {
    const bundle = acceptanceCandidateFromV9MechanismFixture(await loadV9OfflineMechanismFixture());
    const result = bundle.artifact.results[0];
    if (result === undefined) {
      throw new Error("offline fixture omitted its strategy result");
    }
    for (const unsafeSummary of [
      "unsafe local path /Users/example/private.json",
      "unsafe local path /home/example/private.json",
      "unsafe local path /tmp/example/private.json",
      "unsafe credential sk-example-secret-value",
    ]) {
      const unsafe: V9RealAcceptanceBundle = {
        ...bundle,
        artifact: {
          ...bundle.artifact,
          results: [{ ...result, summary: unsafeSummary }],
        },
      };

      await expect(persistV9UnacceptedDiagnostic(unsafe, temporaryRoot)).rejects.toThrow(
        /local |credential/u,
      );
    }
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses protected roots and never overwrites an earlier candidate diagnostic", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "assay-v9-exclusive-"));
  try {
    const bundle = acceptanceCandidateFromV9MechanismFixture(await loadV9OfflineMechanismFixture());
    const diagnosticPath = v9UnacceptedDiagnosticPath(bundle, temporaryRoot);

    await persistV9UnacceptedDiagnostic(bundle, temporaryRoot);
    const originalBytes = await readFile(diagnosticPath, "utf8");
    await expect(persistV9UnacceptedDiagnostic(bundle, temporaryRoot)).rejects.toThrow(
      "already exists; refusing to overwrite",
    );
    expect(await readFile(diagnosticPath, "utf8")).toBe(originalBytes);

    await expect(persistV9UnacceptedDiagnostic(bundle, resolve("artifacts/v9"))).rejects.toThrow(
      "must stay outside the repository or inside the dedicated diagnostic cache",
    );
    await expect(
      persistV9UnacceptedDiagnostic(bundle, resolve("tests/e2e/fixtures")),
    ).rejects.toThrow("must stay outside the repository or inside the dedicated diagnostic cache");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a diagnostic-cache symlink that resolves into formal repository storage", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "assay-v9-symlink-"));
  const symlinkRoot = resolve(
    ".cache/assay/run-logs",
    `physical-escape-${basename(temporaryRoot)}`,
  );
  try {
    const bundle = acceptanceCandidateFromV9MechanismFixture(await loadV9OfflineMechanismFixture());
    await mkdir(dirname(symlinkRoot), { recursive: true });
    await symlink(
      resolve("artifacts"),
      symlinkRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(persistV9UnacceptedDiagnostic(bundle, symlinkRoot)).rejects.toThrow(
      "resolves across its physical repository boundary",
    );
  } finally {
    await unlink(symlinkRoot).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("requires canonical source provenance on the same item as numeric evidence", async () => {
  const bundle = acceptanceCandidateFromV9MechanismFixture(await loadV9OfflineMechanismFixture());
  const result = bundle.artifact.results[0];
  const parameterCheck = result?.checks.find((check) => check.id === "param-robustness");
  const requiredSourceRef = parameterCheck?.evidence[0]?.sourceRefs[0];
  if (result === undefined || parameterCheck === undefined || requiredSourceRef === undefined) {
    throw new Error("offline fixture omitted parameter evidence provenance");
  }
  const separatedEvidence = [
    ...parameterCheck.evidence.map((item) =>
      typeof item.value === "number"
        ? { ...item, sourceRefs: ["fixture:separated-numeric-source"] }
        : item,
    ),
    {
      metric: "canonicalSourceOnly",
      value: "present without a numeric value",
      unit: "text",
      sourceRefs: [requiredSourceRef],
    },
  ];
  const report = replayV9RealMechanism({
    ...bundle,
    artifact: {
      ...bundle.artifact,
      results: [
        {
          ...result,
          checks: result.checks.map((check) =>
            check.id === parameterCheck.id ? { ...check, evidence: separatedEvidence } : check,
          ),
        },
      ],
    },
  });

  expect(
    report.assertions.find(
      (assertion) => assertion.assertion === "checks.param-robustness.sourceRef",
    )?.status,
  ).toBe("pass");
  expect(
    report.assertions.find(
      (assertion) => assertion.assertion === "checks.param-robustness.executionEvidence",
    ),
  ).toMatchObject({
    status: "fail",
    actual: {
      numericEvidenceWithRequiredSourceRefCount: 0,
    },
  });
});

test("replays every assertion and reports expected versus actual without pinning outcomes", async () => {
  const bundle = acceptanceCandidateFromV9MechanismFixture(await loadV9OfflineMechanismFixture());
  const result = bundle.artifact.results[0];
  if (result === undefined) {
    throw new Error("offline fixture omitted its strategy result");
  }
  const wrongVerdict = result.verdict === "KEEP" ? "WATCH" : "KEEP";
  const report = replayV9RealMechanism({
    ...bundle,
    artifact: {
      ...bundle.artifact,
      results: [{ ...result, verdict: wrongVerdict }],
    },
  });
  const verdictAssertion = report.assertions.find(
    (assertion) => assertion.assertion === "verdict.productionPolicy",
  );

  expect(report.passed).toBe(false);
  expect(verdictAssertion).toMatchObject({
    status: "fail",
    expected: result.verdict,
    actual: wrongVerdict,
  });
  expect(
    report.assertions
      .filter((assertion) => assertion.status !== "pass")
      .map(({ assertion }) => assertion),
  ).toEqual(["verdict.productionPolicy"]);
});

liveTest(
  "runs the sequential G01, G02, G03 real-data five-check suite",
  async () => {
    await expect(runV9RealAcceptance()).resolves.toBe(V9_GOLDEN_SUITE_ARTIFACT_PATH);
  },
  V9_REAL_POLL_TIMEOUT_MS * GOLDEN_STRATEGY_CASES.length + 60_000,
);
