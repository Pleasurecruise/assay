import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planDiscriminativeMoireExperiments,
  SubprocessMoireExperimentExecutor,
  synthesizeDiscriminativeMoire,
  type DiscriminativeMoireExperiment,
  type DiscriminativeMoireOutcome,
  type MoireSynthesis,
} from "@assay/agents";
import {
  AUDIT_CHECK_IDS,
  AUDIT_CHECK_SCHEMA_VERSION,
  parseAuditArtifact,
  parseAuditCheckResult,
  type AuditArtifact,
  type AuditCheckId,
  type AuditCheckResult,
  type CanonicalStrategySpec,
  type ParallelAuditChecksResult,
} from "@assay/contracts";
import { freezeStrategySpec } from "@assay/intake";
import { buildExecutedAuditArtifact } from "../../../apps/a2a-server/src/audit-orchestrator";

export const MOIRE_MECHANISM_FIXTURE_VERSION = "moire-mechanism-fixture-v2";
export const MOIRE_MECHANISM_FIXTURE_PATH = resolve(
  "artifacts/v9/assay-moire-mechanism-fixtures.json",
);

const GENERATED_AT = "2026-07-25T00:00:00.000Z";
const CODE_REVISION = "moire-mechanism-fixture-v2";
const ADAPTER_ROOT = fileURLToPath(new URL("../../../services/panda-adapter/", import.meta.url));
const PREPARATION_SCRIPT = fileURLToPath(
  new URL(
    "../../../services/panda-adapter/tests/prepare_moire_mechanism_fixture.py",
    import.meta.url,
  ),
);
const DEFAULT_PYTHON =
  process.platform === "win32"
    ? join(ADAPTER_ROOT, ".venv", "Scripts", "python.exe")
    : join(ADAPTER_ROOT, ".venv", "bin", "python");

const FIXTURE_SPEC = {
  specVersion: "1",
  universe: { index: "000300.SH" },
  signal: {
    kind: "template",
    template: "momentum",
    params: { window: 20 },
  },
  selection: { topN: 4, weighting: "equal" },
  rebalance: { frequency: "monthly", at: "close" },
  window: { start: "20240102", end: "20250519" },
  costs: { model: "none" },
} as const satisfies CanonicalStrategySpec;

type StableJson =
  | null
  | boolean
  | number
  | string
  | readonly StableJson[]
  | { readonly [key: string]: StableJson };

export interface MoireEvidenceArchive {
  readonly sourceRef: string;
  readonly sha256: string;
  readonly canonicalJson: string;
}

export interface MoireMechanismFixtureCore {
  readonly fixtureId: string;
  readonly executionTemplate: "regime_slice_of_grid" | "corrected_cost_ladder";
  readonly experiment: DiscriminativeMoireExperiment;
  readonly outcome: DiscriminativeMoireOutcome;
  readonly synthesis: MoireSynthesis;
  readonly moireEvidence: MoireEvidenceArchive;
  readonly artifact: AuditArtifact;
}

export interface MoireMechanismFixture extends MoireMechanismFixtureCore {
  readonly recordDigest: string;
}

export interface MoireMechanismFixtureBundle {
  readonly schemaVersion: typeof MOIRE_MECHANISM_FIXTURE_VERSION;
  readonly artifactRole: "moire-mechanism-fixture";
  readonly generatedAt: typeof GENERATED_AT;
  readonly fixtures: readonly MoireMechanismFixture[];
}

interface FixtureDefinition {
  readonly id: "M1" | "M2";
  readonly fixtureId: string;
  readonly executionTemplate: MoireMechanismFixture["executionTemplate"];
  readonly checks: readonly AuditCheckResult[];
  readonly costBaselineMode?: "uncorrected";
}

function normalizeStableJson(value: unknown, location = "$"): StableJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeStableJson(item, `${location}[${String(index)}]`));
  }
  if (typeof value === "object" && value !== null) {
    const normalized: Record<string, StableJson> = {};
    for (const key of Object.keys(value).sort()) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested === undefined) {
        throw new Error(`${location}.${key} is undefined`);
      }
      normalized[key] = normalizeStableJson(nested, `${location}.${key}`);
    }
    return normalized;
  }
  throw new Error(`${location} is not stable JSON`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeStableJson(value));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordDigest(value: MoireMechanismFixtureCore): string {
  return `sha256:${sha256(stableJson(value))}`;
}

function independentEvidenceRef(
  fixtureId: string,
  checkId: AuditCheckId,
  metric: string,
  value: number,
): string {
  const digest = sha256(stableJson({ fixtureId, checkId, metric, value }));
  return `artifact:mechanism-input/${checkId}/sha256-${digest}`;
}

function check(
  fixtureId: string,
  id: AuditCheckId,
  conclusion: AuditCheckResult["conclusion"],
  confidence: number,
  metric: string,
  value: number,
  unit: string,
): AuditCheckResult {
  return parseAuditCheckResult(
    {
      id,
      conclusion,
      confidence,
      evidence: [
        {
          metric,
          value,
          unit,
          sourceRefs: [independentEvidenceRef(fixtureId, id, metric, value)],
        },
      ],
      missingEvidence: [],
    },
    id,
  );
}

function orderedChecks(
  values: Readonly<Record<AuditCheckId, AuditCheckResult>>,
): readonly AuditCheckResult[] {
  return AUDIT_CHECK_IDS.map((id) => parseAuditCheckResult(values[id], id));
}

function fixtureDefinitions(): readonly FixtureDefinition[] {
  const m1Id = "M1-regime-slice-of-grid-v2";
  const m2Id = "M2-corrected-cost-ladder-v2";
  return [
    {
      id: "M1",
      fixtureId: m1Id,
      executionTemplate: "regime_slice_of_grid",
      checks: orderedChecks({
        "param-robustness": check(
          m1Id,
          "param-robustness",
          "fail",
          0.8,
          "neighborhoodSharpeRetention",
          0.35,
          "ratio",
        ),
        "data-availability": check(
          m1Id,
          "data-availability",
          "pass",
          0.9,
          "futureConstituentCount",
          0,
          "count",
        ),
        "cost-stress": check(
          m1Id,
          "cost-stress",
          "pass",
          0.9,
          "pessimisticAnnualReturn",
          0.08,
          "fraction/year",
        ),
        "regime-dependency": check(
          m1Id,
          "regime-dependency",
          "pass_with_reservations",
          0.85,
          "dominantEnvironment.pnlShare",
          0.76,
          "ratio",
        ),
        "homogeneity-decay": check(
          m1Id,
          "homogeneity-decay",
          "pass",
          0.9,
          "summary.maxAbsMeanSpearman",
          0.4,
          "absolute correlation",
        ),
      }),
    },
    {
      id: "M2",
      fixtureId: m2Id,
      executionTemplate: "corrected_cost_ladder",
      costBaselineMode: "uncorrected",
      checks: orderedChecks({
        "param-robustness": check(
          m2Id,
          "param-robustness",
          "pass",
          0.9,
          "neighborhoodSharpeRetention",
          0.85,
          "ratio",
        ),
        "data-availability": check(
          m2Id,
          "data-availability",
          "fail",
          0.85,
          "corrected.delta",
          -0.03,
          "annual return",
        ),
        "cost-stress": check(
          m2Id,
          "cost-stress",
          "pass_with_reservations",
          0.8,
          "pessimisticAnnualReturn",
          0.02,
          "fraction/year",
        ),
        "regime-dependency": check(
          m2Id,
          "regime-dependency",
          "pass",
          0.9,
          "dominantEnvironment.pnlShare",
          0.55,
          "ratio",
        ),
        "homogeneity-decay": check(
          m2Id,
          "homogeneity-decay",
          "pass",
          0.9,
          "summary.maxAbsMeanSpearman",
          0.4,
          "absolute correlation",
        ),
      }),
    },
  ];
}

async function prepareHostCaches(root: string, canonicalSpec: string): Promise<void> {
  const python = process.env.ASSAY_FIXTURE_PYTHON ?? DEFAULT_PYTHON;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(python, [PREPARATION_SCRIPT, "--root", root], {
      cwd: ADAPTER_ROOT,
      env: {
        ...process.env,
        PYTHONPATH: join(ADAPTER_ROOT, "src"),
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        callback();
      }
    };
    child.once("error", () =>
      finish(() => reject(new Error("Moiré fixture preparation could not start"))),
    );
    child.once("close", (code) =>
      finish(() =>
        code === 0 ? resolvePromise() : reject(new Error("Moiré fixture preparation failed")),
      ),
    );
    child.stdin.once("error", () =>
      finish(() => reject(new Error("Moiré fixture preparation input failed"))),
    );
    child.stdin.end(`${canonicalSpec}\n`);
  });
}

function evidencePath(root: string, outcome: DiscriminativeMoireOutcome): string {
  const match = new RegExp(`^artifact:moire/${outcome.id}/sha256-([a-f0-9]{64})$`, "u").exec(
    outcome.sourceRef,
  );
  if (match?.[1] === undefined) {
    throw new Error("Moiré fixture outcome lacks a content-addressed evidence reference");
  }
  return join(root, "moire", outcome.id, `sha256-${match[1]}.json`);
}

async function archiveMoireEvidence(
  root: string,
  outcome: DiscriminativeMoireOutcome,
): Promise<MoireEvidenceArchive> {
  const content = await readFile(evidencePath(root, outcome));
  const digest = sha256(content);
  if (!outcome.sourceRef.endsWith(`sha256-${digest}`)) {
    throw new Error("Moiré evidence bytes do not match the subprocess sourceRef");
  }
  const canonicalJson = content.toString("utf8");
  const parsed: unknown = JSON.parse(canonicalJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Moiré evidence artifact must be a JSON object");
  }
  return {
    sourceRef: outcome.sourceRef,
    sha256: digest,
    canonicalJson,
  };
}

function buildArtifact(
  definition: FixtureDefinition,
  refinedChecks: readonly AuditCheckResult[],
  frozen: ReturnType<typeof freezeStrategySpec>,
): AuditArtifact {
  const identity = {
    auditId: `audit-${definition.fixtureId}`,
    subjectId: `strategy-${definition.fixtureId}`,
    traceId: `trace-${definition.fixtureId}`,
  };
  const result: ParallelAuditChecksResult = {
    schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
    auditId: identity.auditId,
    subjectId: identity.subjectId,
    traceId: identity.traceId,
    checks: refinedChecks,
    startedAt: GENERATED_AT,
    completedAt: GENERATED_AT,
  };
  const built = buildExecutedAuditArtifact({
    frozen,
    identity,
    result,
    generatedAt: GENERATED_AT,
  });
  const builtResult = built.results[0];
  if (builtResult === undefined) {
    throw new Error("Moiré mechanism fixture Artifact omitted its result");
  }
  return parseAuditArtifact({
    ...built,
    results: [
      {
        ...builtResult,
        assumptionsAndLimits: [
          "Synthetic known-answer mechanism fixture; no market claim is made.",
          "M1 reuses a host-prepared content-addressed grid and M2 uses a host-persisted PIT-corrected context.",
          "The fixture is fully offline and does not call a model or data provider.",
        ],
        parsingAssumptions: [
          "The canonical StrategySpec was frozen directly by the offline mechanism fixture; no model was called.",
        ],
      },
    ],
  });
}

async function executeFixture(
  definition: FixtureDefinition,
  root: string,
  executor: SubprocessMoireExperimentExecutor,
  frozen: ReturnType<typeof freezeStrategySpec>,
): Promise<MoireMechanismFixture> {
  const planned = planDiscriminativeMoireExperiments(definition.checks, {
    costBaselineMode: definition.costBaselineMode,
  });
  if (
    planned.length !== 1 ||
    planned[0]?.id !== definition.id ||
    planned[0].kind !== definition.executionTemplate
  ) {
    throw new Error(`${definition.id} fixture did not plan exactly its frozen template`);
  }
  const experiment = planned[0];
  const outcome = await executor.execute(experiment, {
    auditId: `audit-${definition.fixtureId}`,
    subjectId: `strategy-${definition.fixtureId}`,
    traceId: `trace-${definition.fixtureId}`,
    dataRef: "legacy-cache:offline-moire-fixture",
    frozenStrategySpec: frozen.canonicalJson,
    specHash: frozen.specHash,
  });
  const synthesis = synthesizeDiscriminativeMoire(experiment, outcome);
  const refinedChecks = definition.checks.map((value) =>
    value.id === experiment.checkId
      ? parseAuditCheckResult(
          {
            ...value,
            refinedByMoire: synthesis.refinedByMoire,
          },
          value.id,
        )
      : value,
  );
  const core: MoireMechanismFixtureCore = {
    fixtureId: definition.fixtureId,
    executionTemplate: definition.executionTemplate,
    experiment,
    outcome,
    synthesis,
    moireEvidence: await archiveMoireEvidence(root, outcome),
    artifact: buildArtifact(definition, refinedChecks, frozen),
  };
  return {
    ...core,
    recordDigest: recordDigest(core),
  };
}

export async function buildMoireMechanismFixtureBundle(): Promise<MoireMechanismFixtureBundle> {
  const frozen = freezeStrategySpec(FIXTURE_SPEC, {
    dataAsOf: "2025-05-19",
    capabilitySnapshotId: "offline-moire-mechanism-fixture-v2",
    codeRevision: CODE_REVISION,
  });
  const root = await mkdtemp(join(tmpdir(), "assay-moire-mechanism-"));
  try {
    await prepareHostCaches(root, frozen.canonicalJson);
    const python = process.env.ASSAY_FIXTURE_PYTHON ?? DEFAULT_PYTHON;
    const executor = new SubprocessMoireExperimentExecutor({
      command: python,
      args: ["-m", "panda_adapter.moire_stdio"],
      cwd: ADAPTER_ROOT,
      env: {
        PYTHONPATH: join(ADAPTER_ROOT, "src"),
        ASSAY_MARKET_DATA_CACHE: join(root, "market.csv"),
        ASSAY_BACKTEST_ARTIFACT_ROOT: join(root, "backtest"),
        ASSAY_MOIRE_ARTIFACT_ROOT: join(root, "moire"),
        ASSAY_PIT_CACHE_ROOT: join(root, "pit"),
        ASSAY_V9_CACHE_ROOT: join(root, "v9-cache"),
      },
      maxOutputBytes: 1024 * 1024,
    });
    const fixtures: MoireMechanismFixture[] = [];
    for (const definition of fixtureDefinitions()) {
      fixtures.push(await executeFixture(definition, root, executor, frozen));
    }
    const bundle: MoireMechanismFixtureBundle = {
      schemaVersion: MOIRE_MECHANISM_FIXTURE_VERSION,
      artifactRole: "moire-mechanism-fixture",
      generatedAt: GENERATED_AT,
      fixtures,
    };
    verifyMoireMechanismFixtureBundle(bundle);
    return bundle;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function serializeMoireMechanismFixtureBundle(bundle: MoireMechanismFixtureBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function verifyMoireMechanismFixtureBundle(bundle: MoireMechanismFixtureBundle): void {
  if (
    bundle.schemaVersion !== MOIRE_MECHANISM_FIXTURE_VERSION ||
    bundle.artifactRole !== "moire-mechanism-fixture" ||
    bundle.generatedAt !== GENERATED_AT
  ) {
    throw new Error("Moiré mechanism fixture bundle identity is invalid");
  }
  if (
    bundle.fixtures.length !== 2 ||
    bundle.fixtures[0]?.executionTemplate !== "regime_slice_of_grid" ||
    bundle.fixtures[1]?.executionTemplate !== "corrected_cost_ladder"
  ) {
    throw new Error("Moiré mechanism fixture templates are incomplete or out of order");
  }
  for (const fixture of bundle.fixtures) {
    const { recordDigest: archivedDigest, ...core }: MoireMechanismFixture = fixture;
    if (archivedDigest !== recordDigest(core)) {
      throw new Error(`${fixture.fixtureId} record digest is invalid`);
    }
    const evidenceDigest = sha256(fixture.moireEvidence.canonicalJson);
    if (
      fixture.moireEvidence.sourceRef !== fixture.outcome.sourceRef ||
      fixture.moireEvidence.sha256 !== evidenceDigest ||
      !fixture.moireEvidence.sourceRef.endsWith(`sha256-${evidenceDigest}`)
    ) {
      throw new Error(`${fixture.fixtureId} Moiré evidence digest is invalid`);
    }
    const evidence: unknown = JSON.parse(fixture.moireEvidence.canonicalJson);
    if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
      throw new Error(`${fixture.fixtureId} Moiré evidence is invalid`);
    }
    const artifact = parseAuditArtifact(fixture.artifact);
    const result = artifact.results[0];
    if (result === undefined) {
      throw new Error(`${fixture.fixtureId} Artifact omitted its result`);
    }
    const independentChecks = result.checks.map((value) => {
      const { refinedByMoire: _refinement, ...independent } = value;
      return parseAuditCheckResult(independent, value.id);
    });
    const planned = planDiscriminativeMoireExperiments(independentChecks, {
      costBaselineMode: fixture.experiment.id === "M2" ? "uncorrected" : undefined,
    });
    if (stableJson(planned) !== stableJson([fixture.experiment])) {
      throw new Error(`${fixture.fixtureId} Artifact checks do not reproduce its trigger`);
    }
    const synthesis = synthesizeDiscriminativeMoire(fixture.experiment, fixture.outcome);
    if (stableJson(synthesis) !== stableJson(fixture.synthesis)) {
      throw new Error(`${fixture.fixtureId} deterministic synthesis is invalid`);
    }
    const refined = result.checks.find((value) => value.id === fixture.experiment.checkId);
    if (refined?.refinedByMoire !== fixture.synthesis.refinedByMoire) {
      throw new Error(`${fixture.fixtureId} Artifact omitted the deterministic refinement`);
    }
  }
  const m1 = bundle.fixtures[0];
  const m2 = bundle.fixtures[1];
  if (
    m1?.outcome.id !== "M1" ||
    m1.synthesis.changed !== true ||
    m1.outcome.dominantRetention < 0.7 ||
    m1.outcome.otherEnvironmentRetentions.length === 0 ||
    m1.outcome.otherEnvironmentRetentions.some((value) => value.retention >= 0.4)
  ) {
    throw new Error("M1 mechanism fixture did not localize parameter fragility");
  }
  if (
    m2?.outcome.id !== "M2" ||
    m2.outcome.correctedCostConclusion !== "fail" ||
    m2.synthesis.changed !== true ||
    m2.synthesis.effectiveConclusion !== "fail"
  ) {
    throw new Error("M2 mechanism fixture did not reproduce the corrected tier flip");
  }
}
