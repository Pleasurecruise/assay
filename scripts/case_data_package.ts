import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { strategyForData, toCanonicalStrategySpec } from "@assay/contracts";
import {
  DeterministicStrategyDataPlanner,
  LOCAL_DATA_REQUIREMENTS,
  STRATEGY_DATA_PLAN_SCHEMA_VERSION,
  type DataPlan,
  type LocalDataRequirement,
} from "@assay/finance-tools";

export const CASE_DATA_PACKAGE_SCHEMA_VERSION = "assay-case-data-package-v1" as const;
export const CASE_DATA_REGISTRY_SCHEMA_VERSION = "assay-case-data-registry-v1" as const;
export const CASE_DATA_PACKAGE_ROOT = "data/packages" as const;
export const CASE_DATA_REGISTRY_FILENAME = "registry.json" as const;
export const CSI300_MOMENTUM_SOURCE_DATA_PACKAGE_ID =
  "csi300-momentum-20d-monthly-top50-equal" as const;
export const CSI300_MOMENTUM_14D_TOP30_PACKAGE_ID =
  "csi300-momentum-14d-monthly-top30-equal" as const;
export const CSI300_MOMENTUM_20D_TOP50_PACKAGE_ID =
  "csi300-momentum-20d-monthly-top50-equal" as const;
export const CSI300_MOMENTUM_26D_TOP70_PACKAGE_ID =
  "csi300-momentum-26d-monthly-top70-equal" as const;
/** Compatibility name retained for callers of the original single-package API. */
export const CSI300_MOMENTUM_CASE_PACKAGE_ID = CSI300_MOMENTUM_20D_TOP50_PACKAGE_ID;

const SHA256 = /^sha256-[a-f0-9]{64}$/u;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const COMPACT_DATE = /^\d{8}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const REQUIRED_CASE_DATA_REQUIREMENTS = LOCAL_DATA_REQUIREMENTS.filter(
  (requirement) => requirement !== "strategy_signal_factors",
);
const DATASET_NAMES = [
  "equityDaily",
  "indexMembership",
  "historicalMemberDaily",
  "indexDaily",
  "comparatorFactors",
] as const;

export type CaseDatasetName = (typeof DATASET_NAMES)[number];
export type CaseStatus = "ready" | "degraded";

export interface CaseIntegrity {
  readonly kind: "file" | "tree";
  readonly sha256: `sha256-${string}`;
  readonly files: number;
  readonly bytes: number;
}

export interface CaseDataset {
  readonly status: CaseStatus;
  readonly path: string | null;
  readonly mode: string;
  readonly reasonCode: string | null;
  readonly assumptions: readonly string[];
  readonly statistics: {
    readonly rowCount: number;
    readonly symbols: number;
    readonly tradingDates: number;
  };
  readonly integrity: CaseIntegrity | null;
}

export interface CaseProvenance {
  readonly path: string;
  readonly integrity: CaseIntegrity;
}

export interface CaseDataPackageManifest {
  readonly schemaVersion: typeof CASE_DATA_PACKAGE_SCHEMA_VERSION;
  readonly packageId: string;
  readonly generatedAt: string;
  readonly strategyKey: `sha256-${string}`;
  readonly universe: {
    readonly indexSymbol: string;
    readonly membershipMode: "point_in_time";
  };
  readonly window: { readonly start: string; readonly end: string };
  readonly coverage: { readonly start: string; readonly end: string; readonly asOf: string };
  readonly state: CaseStatus;
  readonly assumptions: readonly string[];
  readonly datasets: Readonly<Record<CaseDatasetName, CaseDataset>>;
  readonly provenance: {
    readonly sourceSummary: CaseProvenance;
    readonly fallbackRecords: CaseProvenance;
    readonly preparationReport: CaseProvenance;
    readonly incompleteAttempts: CaseProvenance | null;
  };
}

export interface LoadedCaseDataPackage {
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly manifest: CaseDataPackageManifest;
  readonly manifestBytes: Buffer;
}

export interface CaseDataPackageBinding {
  readonly packageId: string;
  readonly sourceDataPackageId: string;
  readonly dataPlan: DataPlan;
}

export interface CaseDataPackageRegistry {
  readonly schemaVersion: typeof CASE_DATA_REGISTRY_SCHEMA_VERSION;
  readonly bindings: readonly CaseDataPackageBinding[];
}

export interface LoadedCaseDataBinding {
  readonly binding: CaseDataPackageBinding;
  readonly source: LoadedCaseDataPackage;
}

export interface ExportCsi300CasePackageOptions {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly marketDataCache: string;
  readonly v9CacheRoot: string;
  readonly pitCacheRoot: string;
}

interface TreeFile {
  readonly path: string;
  readonly absolutePath: string | null;
  readonly contents: Buffer;
}

interface Stats {
  readonly rowCount: number;
  readonly symbols: number;
  readonly tradingDates: number;
}

const PATHS: Readonly<Record<CaseDatasetName, string>> = {
  equityDaily: "datasets/equity-daily.csv",
  indexMembership: "datasets/index-membership/000300.SH",
  historicalMemberDaily: "datasets/historical-member-daily.csv",
  indexDaily: "datasets/index-daily.csv",
  comparatorFactors: "datasets/comparator-factors.csv",
};

const SOURCE_NAMES = {
  historicalMemberDaily: "historicalMembers",
  indexDaily: "indexDaily",
  comparatorFactors: "comparatorFactors",
} as const;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256Bytes(contents: Uint8Array): `sha256-${string}` {
  return `sha256-${createHash("sha256").update(contents).digest("hex")}`;
}

function safeRelative(path: string, location: string): void {
  requireValue(
    path.length > 0 &&
      !isAbsolute(path) &&
      !path.includes("\\") &&
      path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    `${location} is unsafe`,
  );
}

function inside(parent: string, candidate: string): boolean {
  const part = relative(parent, candidate);
  return part.length > 0 && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

function contained(root: string, path: string, location: string): string {
  safeRelative(path, location);
  const candidate = resolve(root, path);
  requireValue(inside(root, candidate), `${location} escapes its root`);
  return candidate;
}

async function requirePath(
  path: string,
  kind: "file" | "directory",
  location: string,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(`${location} is missing`);
  }
  requireValue(!stat.isSymbolicLink(), `${location} cannot be a symlink`);
  requireValue(kind === "file" ? stat.isFile() : stat.isDirectory(), `${location} has wrong type`);
}

export async function collectTreeFiles(root: string): Promise<readonly TreeFile[]> {
  await requirePath(root, "directory", "data tree");
  const files: TreeFile[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      requireValue(!entry.isSymbolicLink(), "data trees cannot contain symlinks");
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, path);
      else {
        requireValue(entry.isFile(), "data tree contains an unsupported entry");
        files.push({ path, absolutePath, contents: await readFile(absolutePath) });
      }
    }
  }
  await visit(root);
  return files.sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
  );
}

export function treeDigest(
  files: readonly Pick<TreeFile, "path" | "contents">[],
): `sha256-${string}` {
  requireValue(files.length > 0, "data tree is empty");
  const digest = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
  )) {
    digest.update(file.path, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(file.contents);
  }
  return `sha256-${digest.digest("hex")}`;
}

function fileIntegrity(contents: Uint8Array): CaseIntegrity {
  return { kind: "file", sha256: sha256Bytes(contents), files: 1, bytes: contents.byteLength };
}

function treeIntegrity(files: readonly TreeFile[]): CaseIntegrity {
  return {
    kind: "tree",
    sha256: treeDigest(files),
    files: files.length,
    bytes: files.reduce((total, file) => total + file.contents.byteLength, 0),
  };
}

function integer(value: unknown, location: string): number {
  requireValue(Number.isSafeInteger(value) && Number(value) >= 0, `${location} is invalid`);
  return Number(value);
}

function integrity(value: unknown, location: string): CaseIntegrity {
  requireValue(
    isRecord(value) &&
      exact(value, ["kind", "sha256", "files", "bytes"]) &&
      (value.kind === "file" || value.kind === "tree") &&
      typeof value.sha256 === "string" &&
      SHA256.test(value.sha256),
    `${location} is invalid`,
  );
  const files = integer(value.files, `${location}.files`);
  integer(value.bytes, `${location}.bytes`);
  requireValue(files > 0 && (value.kind === "tree" || files === 1), `${location}.files is invalid`);
  return value as unknown as CaseIntegrity;
}

function strings(value: unknown, location: string): readonly string[] {
  requireValue(
    Array.isArray(value) && value.every((item) => typeof item === "string"),
    `${location} is invalid`,
  );
  return value;
}

function dataset(value: unknown, name: CaseDatasetName): CaseDataset {
  requireValue(
    isRecord(value) &&
      exact(value, [
        "status",
        "path",
        "mode",
        "reasonCode",
        "assumptions",
        "statistics",
        "integrity",
      ]) &&
      (value.status === "ready" || value.status === "degraded") &&
      typeof value.mode === "string" &&
      value.mode.length > 0 &&
      isRecord(value.statistics) &&
      exact(value.statistics, ["rowCount", "symbols", "tradingDates"]),
    `dataset ${name} is invalid`,
  );
  strings(value.assumptions, `dataset ${name} assumptions`);
  integer(value.statistics.rowCount, `dataset ${name} rowCount`);
  integer(value.statistics.symbols, `dataset ${name} symbols`);
  integer(value.statistics.tradingDates, `dataset ${name} tradingDates`);
  if (value.status === "ready") {
    requireValue(
      value.path === PATHS[name] && value.reasonCode === null && value.integrity !== null,
      `ready dataset ${name} is incomplete`,
    );
    integrity(value.integrity, `dataset ${name} integrity`);
  } else {
    requireValue(
      value.path === null &&
        typeof value.reasonCode === "string" &&
        value.reasonCode.length > 0 &&
        value.integrity === null,
      `degraded dataset ${name} must have a reason and no promoted path`,
    );
  }
  return value as unknown as CaseDataset;
}

function provenance(value: unknown, path: string, kind: "file" | "tree"): CaseProvenance {
  requireValue(
    isRecord(value) && exact(value, ["path", "integrity"]) && value.path === path,
    `provenance ${path} is invalid`,
  );
  const parsed = integrity(value.integrity, `provenance ${path} integrity`);
  requireValue(parsed.kind === kind, `provenance ${path} has wrong integrity kind`);
  return value as unknown as CaseProvenance;
}

export function parseCaseDataManifest(raw: Uint8Array): CaseDataPackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new Error("case data manifest is unreadable");
  }
  requireValue(
    isRecord(value) &&
      value.schemaVersion === CASE_DATA_PACKAGE_SCHEMA_VERSION &&
      typeof value.packageId === "string" &&
      PACKAGE_ID.test(value.packageId) &&
      typeof value.generatedAt === "string" &&
      Number.isFinite(Date.parse(value.generatedAt)) &&
      typeof value.strategyKey === "string" &&
      SHA256.test(value.strategyKey) &&
      (value.state === "ready" || value.state === "degraded") &&
      Array.isArray(value.assumptions) &&
      isRecord(value.universe) &&
      typeof value.universe.indexSymbol === "string" &&
      value.universe.membershipMode === "point_in_time" &&
      isRecord(value.window) &&
      /^\d{8}$/u.test(String(value.window.start)) &&
      /^\d{8}$/u.test(String(value.window.end)) &&
      isRecord(value.coverage) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(String(value.coverage.start)) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(String(value.coverage.end)) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(String(value.coverage.asOf)) &&
      isRecord(value.datasets) &&
      isRecord(value.provenance),
    "case data manifest is invalid",
  );
  strings(value.assumptions, "manifest assumptions");
  requireValue(
    exact(value.datasets, DATASET_NAMES) &&
      exact(value.provenance, [
        "sourceSummary",
        "fallbackRecords",
        "preparationReport",
        "incompleteAttempts",
      ]),
    "case data manifest keys are invalid",
  );
  const datasetValues = value.datasets as Record<string, unknown>;
  const parsedDatasets = Object.fromEntries(
    DATASET_NAMES.map((name) => [name, dataset(datasetValues[name], name)]),
  ) as unknown as Record<CaseDatasetName, CaseDataset>;
  provenance(value.provenance.sourceSummary, "provenance/source-summary.json", "file");
  provenance(value.provenance.fallbackRecords, "provenance/fallback-records", "tree");
  provenance(value.provenance.preparationReport, "provenance/preparation-report.json", "file");
  if (value.provenance.incompleteAttempts !== null) {
    provenance(value.provenance.incompleteAttempts, "provenance/incomplete-attempts", "tree");
  }
  const expectedState = DATASET_NAMES.some((name) => parsedDatasets[name].status === "degraded")
    ? "degraded"
    : "ready";
  requireValue(value.state === expectedState, "manifest state does not match datasets");
  return value as unknown as CaseDataPackageManifest;
}

async function verify(root: string, path: string, expected: CaseIntegrity): Promise<number> {
  const target = contained(root, path, "manifest path");
  if (expected.kind === "file") {
    await requirePath(target, "file", path);
    const bytes = await readFile(target);
    requireValue(
      sha256Bytes(bytes) === expected.sha256 && bytes.byteLength === expected.bytes,
      `${path} checksum failed`,
    );
    return 1;
  }
  const files = await collectTreeFiles(target);
  const actual = treeIntegrity(files);
  requireValue(
    actual.sha256 === expected.sha256 &&
      actual.files === expected.files &&
      actual.bytes === expected.bytes,
    `${path} tree checksum failed`,
  );
  return files.length;
}

export async function validateCaseDataPackage(
  packageRoot: string,
  expectedPackageId?: string,
): Promise<LoadedCaseDataPackage> {
  const root = resolve(packageRoot);
  await requirePath(root, "directory", "case package");
  const manifestPath = join(root, "manifest.json");
  await requirePath(manifestPath, "file", "case package manifest");
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseCaseDataManifest(manifestBytes);
  requireValue(
    manifest.packageId === (expectedPackageId ?? relative(dirname(root), root)),
    "package directory/id mismatch",
  );
  let declaredFiles = 1;
  for (const name of DATASET_NAMES) {
    const item = manifest.datasets[name];
    if (item.status === "ready") {
      declaredFiles += await verify(root, item.path as string, item.integrity as CaseIntegrity);
    }
  }
  for (const item of [
    manifest.provenance.sourceSummary,
    manifest.provenance.fallbackRecords,
    manifest.provenance.preparationReport,
    manifest.provenance.incompleteAttempts,
  ]) {
    if (item !== null) declaredFiles += await verify(root, item.path, item.integrity);
  }
  requireValue(
    (await collectTreeFiles(root)).length === declaredFiles,
    "case package contains undeclared files",
  );
  return { packageRoot: root, manifestPath, manifest, manifestBytes };
}

function validCalendarDate(value: string, pattern: RegExp): boolean {
  if (!pattern.test(value)) return false;
  const iso =
    value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
  const timestamp = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === iso;
}

function compactToIso(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function parseDataPlan(value: unknown, location: string): DataPlan {
  requireValue(
    isRecord(value) &&
      exact(value, [
        "schemaVersion",
        "strategyKey",
        "indexSymbol",
        "window",
        "requiredCoverage",
        "requirements",
      ]) &&
      value.schemaVersion === STRATEGY_DATA_PLAN_SCHEMA_VERSION &&
      typeof value.strategyKey === "string" &&
      SHA256.test(value.strategyKey) &&
      typeof value.indexSymbol === "string" &&
      value.indexSymbol.length > 0 &&
      isRecord(value.window) &&
      exact(value.window, ["start", "end"]) &&
      typeof value.window.start === "string" &&
      typeof value.window.end === "string" &&
      validCalendarDate(value.window.start, COMPACT_DATE) &&
      validCalendarDate(value.window.end, COMPACT_DATE) &&
      value.window.start <= value.window.end &&
      isRecord(value.requiredCoverage) &&
      exact(value.requiredCoverage, ["start", "end"]) &&
      typeof value.requiredCoverage.start === "string" &&
      typeof value.requiredCoverage.end === "string" &&
      validCalendarDate(value.requiredCoverage.start, ISO_DATE) &&
      validCalendarDate(value.requiredCoverage.end, ISO_DATE) &&
      value.requiredCoverage.start <= compactToIso(value.window.start) &&
      value.requiredCoverage.end >= compactToIso(value.window.end) &&
      Array.isArray(value.requirements) &&
      value.requirements.length > 0,
    `${location} is invalid`,
  );
  const requirements = value.requirements as unknown[];
  requireValue(
    requirements.every(
      (requirement): requirement is LocalDataRequirement =>
        typeof requirement === "string" &&
        LOCAL_DATA_REQUIREMENTS.some((candidate) => candidate === requirement),
    ),
    `${location}.requirements is invalid`,
  );
  const normalizedRequirements = LOCAL_DATA_REQUIREMENTS.filter((requirement) =>
    requirements.includes(requirement),
  );
  requireValue(
    requirements.length === normalizedRequirements.length &&
      requirements.every((requirement, index) => requirement === normalizedRequirements[index]) &&
      REQUIRED_CASE_DATA_REQUIREMENTS.every((requirement) => requirements.includes(requirement)),
    `${location}.requirements must be complete, unique, and canonically ordered`,
  );
  return value as unknown as DataPlan;
}

function parseBinding(value: unknown, location: string): CaseDataPackageBinding {
  requireValue(
    isRecord(value) &&
      exact(value, ["packageId", "sourceDataPackageId", "dataPlan"]) &&
      typeof value.packageId === "string" &&
      PACKAGE_ID.test(value.packageId) &&
      typeof value.sourceDataPackageId === "string" &&
      PACKAGE_ID.test(value.sourceDataPackageId),
    `${location} is invalid`,
  );
  parseDataPlan(value.dataPlan, `${location}.dataPlan`);
  return value as unknown as CaseDataPackageBinding;
}

export function parseCaseDataRegistry(raw: Uint8Array): CaseDataPackageRegistry {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new Error("case data registry is unreadable");
  }
  requireValue(
    isRecord(value) &&
      exact(value, ["schemaVersion", "bindings"]) &&
      value.schemaVersion === CASE_DATA_REGISTRY_SCHEMA_VERSION &&
      Array.isArray(value.bindings) &&
      value.bindings.length > 0,
    "case data registry is invalid",
  );
  value.bindings.forEach((binding, index) => parseBinding(binding, `registry binding ${index}`));
  return value as unknown as CaseDataPackageRegistry;
}

function validateBindingAgainstSource(
  binding: CaseDataPackageBinding,
  source: LoadedCaseDataPackage,
): void {
  const { dataPlan } = binding;
  const { manifest } = source;
  requireValue(
    binding.sourceDataPackageId === manifest.packageId &&
      dataPlan.indexSymbol === manifest.universe.indexSymbol &&
      dataPlan.window.start === manifest.window.start &&
      dataPlan.window.end === manifest.window.end &&
      manifest.coverage.start <= dataPlan.requiredCoverage.start &&
      manifest.coverage.end >= dataPlan.requiredCoverage.end &&
      manifest.coverage.asOf >= dataPlan.requiredCoverage.end,
    `${binding.packageId} data plan is not covered by ${binding.sourceDataPackageId}`,
  );
  requireValue(
    manifest.datasets.equityDaily.status === "ready" &&
      manifest.datasets.indexMembership.status === "ready" &&
      !dataPlan.requirements.includes("strategy_signal_factors"),
    `${binding.packageId} requires unavailable source data`,
  );
}

export async function validateCaseDataRegistry(
  root: string,
): Promise<readonly LoadedCaseDataBinding[]> {
  const registry = resolve(root);
  await requirePath(registry, "directory", "case package registry");
  const registryPath = join(registry, CASE_DATA_REGISTRY_FILENAME);
  await requirePath(registryPath, "file", "case data registry manifest");
  const parsed = parseCaseDataRegistry(await readFile(registryPath));
  const packageIds = new Set<string>();
  const strategyKeys = new Set<string>();
  const sourceIds = new Set(parsed.bindings.map(({ sourceDataPackageId }) => sourceDataPackageId));
  for (const entry of await readdir(registry, { withFileTypes: true })) {
    requireValue(!entry.isSymbolicLink(), "case package registry cannot contain symlinks");
    if (entry.isDirectory()) {
      requireValue(
        sourceIds.has(entry.name),
        "case package registry contains an unreferenced source",
      );
    } else {
      requireValue(
        entry.isFile() &&
          (entry.name === CASE_DATA_REGISTRY_FILENAME || entry.name === "README.md"),
        "case package registry contains an unsupported entry",
      );
    }
  }
  const sourceById = new Map<string, Promise<LoadedCaseDataPackage>>();
  const bindings = [...parsed.bindings].sort((left, right) =>
    Buffer.compare(Buffer.from(left.packageId, "utf8"), Buffer.from(right.packageId, "utf8")),
  );
  const loaded: LoadedCaseDataBinding[] = [];
  for (const binding of bindings) {
    requireValue(!packageIds.has(binding.packageId), "case data registry has duplicate packageId");
    requireValue(
      !strategyKeys.has(binding.dataPlan.strategyKey),
      "case data registry has duplicate strategyKey",
    );
    packageIds.add(binding.packageId);
    strategyKeys.add(binding.dataPlan.strategyKey);
    let sourcePromise = sourceById.get(binding.sourceDataPackageId);
    if (sourcePromise === undefined) {
      sourcePromise = validateCaseDataPackage(
        join(registry, binding.sourceDataPackageId),
        binding.sourceDataPackageId,
      );
      sourceById.set(binding.sourceDataPackageId, sourcePromise);
    }
    const source = await sourcePromise;
    validateBindingAgainstSource(binding, source);
    loaded.push({ binding, source });
  }
  return loaded;
}

function csi300MomentumPlan(window: number, topN: number): DataPlan {
  return new DeterministicStrategyDataPlanner().plan(
    strategyForData(
      toCanonicalStrategySpec({
        specVersion: "1",
        universe: { index: "000300.SH" },
        signal: { kind: "template", template: "momentum", params: { window } },
        selection: { topN, weighting: "equal" },
        rebalance: { frequency: "monthly", at: "close" },
        window: { start: "20230723", end: "20260723" },
        costs: { model: "standard" },
      }),
    ),
  );
}

export const CSI300_MOMENTUM_CASE_BINDINGS = [
  {
    packageId: CSI300_MOMENTUM_14D_TOP30_PACKAGE_ID,
    sourceDataPackageId: CSI300_MOMENTUM_SOURCE_DATA_PACKAGE_ID,
    dataPlan: csi300MomentumPlan(14, 30),
  },
  {
    packageId: CSI300_MOMENTUM_20D_TOP50_PACKAGE_ID,
    sourceDataPackageId: CSI300_MOMENTUM_SOURCE_DATA_PACKAGE_ID,
    dataPlan: csi300MomentumPlan(20, 50),
  },
  {
    packageId: CSI300_MOMENTUM_26D_TOP70_PACKAGE_ID,
    sourceDataPackageId: CSI300_MOMENTUM_SOURCE_DATA_PACKAGE_ID,
    dataPlan: csi300MomentumPlan(26, 70),
  },
] as const satisfies readonly CaseDataPackageBinding[];

export function csi300MomentumDataPlan(): DataPlan {
  return csi300MomentumDataPlanForPackage(CSI300_MOMENTUM_CASE_PACKAGE_ID);
}

export function csi300MomentumDataPlanForPackage(packageId: string): DataPlan {
  const binding = CSI300_MOMENTUM_CASE_BINDINGS.find(
    (candidate) => candidate.packageId === packageId,
  );
  requireValue(binding !== undefined, "unknown CSI300 momentum package");
  return binding.dataPlan;
}

export function csi300MomentumCaseDataRegistry(): CaseDataPackageRegistry {
  return {
    schemaVersion: CASE_DATA_REGISTRY_SCHEMA_VERSION,
    bindings: CSI300_MOMENTUM_CASE_BINDINGS,
  };
}

export async function writeCsi300MomentumCaseDataRegistry(
  root: string,
): Promise<readonly LoadedCaseDataBinding[]> {
  const registry = resolve(root);
  await mkdir(registry, { recursive: true });
  await writeFile(
    join(registry, CASE_DATA_REGISTRY_FILENAME),
    serializeJson(csi300MomentumCaseDataRegistry()),
  );
  return await validateCaseDataRegistry(registry);
}

function reportDataset(report: Record<string, unknown>, name: string): Record<string, unknown> {
  requireValue(
    isRecord(report.datasets) && isRecord(report.datasets[name]),
    `report omitted ${name}`,
  );
  return report.datasets[name];
}

function stats(source: Record<string, unknown>): Stats {
  return {
    rowCount: integer(source.rowCount, "source rowCount"),
    symbols: integer(source.symbols, "source symbols"),
    tradingDates: integer(source.tradingDates, "source tradingDates"),
  };
}

function csvStats(contents: Buffer, header?: string): Stats {
  const text = contents.toString("utf8");
  const rows = (text.endsWith("\n") ? text.slice(0, -1) : text).split(/\r?\n/u);
  requireValue(rows.length > 1 && (header === undefined || rows[0] === header), "CSV is invalid");
  const dates = new Set<string>();
  const symbols = new Set<string>();
  for (const row of rows.slice(1)) {
    const [date, symbol] = row.split(",", 3);
    requireValue(date !== undefined && symbol !== undefined, "CSV row is invalid");
    dates.add(date);
    symbols.add(symbol);
  }
  return { rowCount: rows.length - 1, symbols: symbols.size, tradingDates: dates.size };
}

function status(source: Record<string, unknown>): CaseStatus {
  requireValue(
    source.status === "ready" || source.status === "degraded",
    "source status is invalid",
  );
  return source.status;
}

function transformReport(report: Record<string, unknown>): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  const base = reportDataset(value, "basePanel");
  const pit = reportDataset(value, "pitTimeline");
  requireValue(isRecord(base.fallbackProvenance), "report omitted fallback provenance");
  base.path = PATHS.equityDaily;
  base.fallbackProvenance.path = "provenance/fallback-records/provenance.json";
  pit.path = PATHS.indexMembership;
  for (const [name, sourceName] of Object.entries(SOURCE_NAMES) as [
    keyof typeof SOURCE_NAMES,
    string,
  ][]) {
    const item = reportDataset(value, sourceName);
    item.path = item.status === "ready" ? PATHS[name] : null;
  }
  return value;
}

function descriptor(
  source: Record<string, unknown>,
  name: CaseDatasetName,
  mode: string,
  check: CaseIntegrity | null,
  actualStats?: Stats,
): CaseDataset {
  const sourceStatus = status(source);
  const assumptions = Array.isArray(source.assumptions)
    ? strings(source.assumptions, "assumptions")
    : [];
  if (sourceStatus === "ready") {
    requireValue(check !== null, `ready dataset ${name} has no bytes`);
    return {
      status: "ready",
      path: PATHS[name],
      mode,
      reasonCode: null,
      assumptions,
      statistics: actualStats ?? stats(source),
      integrity: check,
    };
  }
  requireValue(check === null, `degraded dataset ${name} cannot contain promoted bytes`);
  return {
    status: "degraded",
    path: null,
    mode,
    reasonCode:
      typeof source.reasonCode === "string" ? source.reasonCode : "SOURCE_DATASET_UNAVAILABLE",
    assumptions,
    statistics: stats(source),
    integrity: null,
  };
}

async function copyFiles(files: readonly TreeFile[], destination: string): Promise<void> {
  for (const file of files) {
    const target = join(destination, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    if (file.absolutePath === null) await writeFile(target, file.contents);
    else await copyFile(file.absolutePath, target);
  }
}

async function incompleteAttempts(
  pitRoot: string,
  v9Root: string,
  symbolsWithoutPromotedDailyHistory: number,
): Promise<readonly TreeFile[]> {
  const extraPanelRoot = join(pitRoot, "extra-panel");
  const candidates: string[] = [];
  for (const entry of await readdir(extraPanelRoot, { withFileTypes: true })) {
    requireValue(!entry.isSymbolicLink(), "historical attempt root cannot contain symlinks");
    if (!entry.isDirectory()) continue;
    const fragments = join(extraPanelRoot, entry.name, "fragments");
    try {
      await requirePath(fragments, "directory", "historical attempt fragments");
      candidates.push(fragments);
    } catch {
      // An unrelated, incomplete work directory is not a promoted attempt source.
    }
  }
  requireValue(candidates.length === 1, "historical attempt source is ambiguous");
  const [history, comparator] = await Promise.all([
    collectTreeFiles(candidates[0] as string),
    collectTreeFiles(join(v9Root, "fragments", "comparator-factors")),
  ]);
  const close = history.filter((file) => file.path.startsWith("factor-close/"));
  const trade = history.filter((file) => file.path.startsWith("trade-status/"));
  const payloads = comparator.filter((file) => !file.path.endsWith(".split.json"));
  const attemptedSymbols = new Set<string>();
  let factorCloseRows = 0;
  const factorCloseDates = new Set<string>();
  let tradeStatusRows = 0;
  const tradeStatusDates = new Set<string>();
  for (const [files, dates, countRows] of [
    [close, factorCloseDates, (rows: number) => (factorCloseRows += rows)],
    [trade, tradeStatusDates, (rows: number) => (tradeStatusRows += rows)],
  ] as const) {
    for (const file of files) {
      const value = JSON.parse(file.contents.toString("utf8")) as unknown;
      requireValue(
        isRecord(value) &&
          Array.isArray(value.symbols) &&
          Array.isArray(value.rows) &&
          typeof value.start === "string",
        "historical attempt is invalid",
      );
      countRows(value.rows.length);
      for (const row of value.rows) {
        requireValue(isRecord(row) && typeof row.date === "string", "historical row is invalid");
        dates.add(row.date);
      }
      for (const symbol of value.symbols)
        if (typeof symbol === "string") attemptedSymbols.add(symbol);
    }
  }
  let comparatorRows = 0;
  const dates = new Set<string>();
  for (const file of payloads) {
    const value = JSON.parse(file.contents.toString("utf8")) as unknown;
    requireValue(isRecord(value) && Array.isArray(value.rows), "comparator attempt is invalid");
    comparatorRows += value.rows.length;
    for (const row of value.rows)
      if (isRecord(row) && typeof row.date === "string") dates.add(row.date);
  }
  requireValue(
    close.length > 0 &&
      trade.length > 0 &&
      payloads.length > 0 &&
      attemptedSymbols.size > 0 &&
      attemptedSymbols.size <= symbolsWithoutPromotedDailyHistory,
    "incomplete attempt payloads are invalid",
  );
  const summary = serializeJson({
    schemaVersion: "assay-incomplete-attempt-summary-v1",
    promotionStatus: "not_promoted",
    runtimeEligible: false,
    historicalMemberDaily: {
      symbolsWithoutPromotedDailyHistory,
      attemptedSymbols: attemptedSymbols.size,
      unattemptedSymbols: symbolsWithoutPromotedDailyHistory - attemptedSymbols.size,
      factorClosePayloadFiles: close.length,
      factorCloseRows,
      factorCloseTradingDates: factorCloseDates.size,
      tradeStatusPayloadFiles: trade.length,
      tradeStatusRows,
      tradeStatusTradingDates: tradeStatusDates.size,
      reason: "Incomplete coverage; these payloads cannot be promoted as a dataset.",
    },
    comparatorFactors: {
      payloadFiles: 4,
      rows: 33,
      tradingDates: 1,
      reason: "Only one trading date was obtained.",
    },
    indexDaily: { payloadFiles: 0, reason: "No index-daily payload was obtained." },
    excludedProcessRecords: { comparatorSplitRequestRecords: 11 },
  });
  return [
    { path: "manifest.json", absolutePath: null, contents: summary },
    ...close.map((file) => ({ ...file, path: `historical-member-daily/${file.path}` })),
    ...trade.map((file) => ({ ...file, path: `historical-member-daily/${file.path}` })),
    ...payloads.map((file) => ({ ...file, path: `comparator-factors/${file.path}` })),
  ].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

async function atomicPackage(
  destination: string,
  build: (root: string) => Promise<void>,
): Promise<void> {
  const parent = dirname(destination);
  const name = relative(parent, destination);
  const temporary = join(parent, `.${name}.${String(process.pid)}.${randomUUID()}.tmp`);
  const backup = join(parent, `.${name}.${String(process.pid)}.${randomUUID()}.bak`);
  await mkdir(parent, { recursive: true });
  await mkdir(temporary);
  let backedUp = false;
  try {
    await build(temporary);
    try {
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (backedUp) await rename(backup, destination);
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function exportCsi300MomentumCasePackage(
  options: ExportCsi300CasePackageOptions,
): Promise<LoadedCaseDataPackage & { readonly plan: DataPlan }> {
  const sourceRoot = resolve(options.sourceRoot);
  const destinationRoot = resolve(options.destinationRoot);
  const marketPath = resolve(options.marketDataCache);
  const v9Root = resolve(options.v9CacheRoot);
  const pitRoot = resolve(options.pitCacheRoot);
  for (const path of [marketPath, v9Root, pitRoot]) {
    requireValue(inside(sourceRoot, path), "export source escapes sourceRoot");
  }
  await Promise.all([
    requirePath(marketPath, "file", "equity daily source"),
    requirePath(v9Root, "directory", "preparation source"),
    requirePath(pitRoot, "directory", "PIT source"),
  ]);
  const [reportRaw, market, pitFiles] = await Promise.all([
    readFile(join(v9Root, "manifest.json")),
    readFile(marketPath),
    collectTreeFiles(join(pitRoot, "index-weights", "000300_SH")),
  ]);
  let reportValue: unknown;
  try {
    reportValue = JSON.parse(reportRaw.toString("utf8"));
  } catch {
    throw new Error("preparation report is unreadable");
  }
  requireValue(isRecord(reportValue), "preparation report is invalid");
  const report = transformReport(reportValue);
  requireValue(
    typeof report.generatedAt === "string" &&
      Array.isArray(report.assumptions) &&
      isRecord(report.window),
    "preparation report identity is invalid",
  );
  const base = reportDataset(report, "basePanel");
  const pit = reportDataset(report, "pitTimeline");
  requireValue(isRecord(base.fallbackProvenance), "source omitted fallback provenance");
  const originalBase = reportDataset(reportValue, "basePanel");
  requireValue(
    isRecord(originalBase.fallbackProvenance) &&
      typeof originalBase.fallbackProvenance.path === "string",
    "source fallback path is invalid",
  );
  const fallbackRoot = dirname(
    contained(sourceRoot, originalBase.fallbackProvenance.path, "fallback path"),
  );
  const fallbackFiles = await collectTreeFiles(fallbackRoot);
  const marketStats = csvStats(market, "date,symbol,adjClose,tradeStatus");
  const pitSymbols = new Set<string>();
  let pitRows = 0;
  for (const file of pitFiles) {
    const value = JSON.parse(file.contents.toString("utf8")) as unknown;
    requireValue(
      isRecord(value) && value.indexSymbol === "000300.SH" && Array.isArray(value.symbols),
      "PIT snapshot is invalid",
    );
    pitRows += value.symbols.length;
    for (const symbol of value.symbols) if (typeof symbol === "string") pitSymbols.add(symbol);
  }
  const pitStats = { rowCount: pitRows, symbols: pitSymbols.size, tradingDates: pitFiles.length };
  const attemptFiles = await incompleteAttempts(
    pitRoot,
    v9Root,
    pitStats.symbols - marketStats.symbols,
  );
  requireValue(
    JSON.stringify(marketStats) === JSON.stringify(stats(base)),
    "market stats mismatch",
  );
  requireValue(JSON.stringify(pitStats) === JSON.stringify(stats(pit)), "PIT stats mismatch");

  const optional: Partial<Record<keyof typeof SOURCE_NAMES, { path: string; bytes: Buffer }>> = {};
  for (const [name, sourceName] of Object.entries(SOURCE_NAMES) as [
    keyof typeof SOURCE_NAMES,
    string,
  ][]) {
    const original = reportDataset(reportValue, sourceName);
    if (status(original) === "ready") {
      requireValue(typeof original.path === "string", `${sourceName} omitted path`);
      const path = contained(sourceRoot, original.path, `${sourceName} path`);
      await requirePath(path, "file", sourceName);
      optional[name] = { path, bytes: await readFile(path) };
    } else requireValue(original.path === null, `${sourceName} degraded path is not null`);
  }
  const datasets = {
    equityDaily: descriptor(
      base,
      "equityDaily",
      String(base.priceSourceMode),
      fileIntegrity(market),
      marketStats,
    ),
    indexMembership: descriptor(
      pit,
      "indexMembership",
      "point_in_time",
      treeIntegrity(pitFiles),
      pitStats,
    ),
    historicalMemberDaily: descriptor(
      reportDataset(report, "historicalMembers"),
      "historicalMemberDaily",
      String(reportDataset(report, "historicalMembers").mode),
      optional.historicalMemberDaily ? fileIntegrity(optional.historicalMemberDaily.bytes) : null,
      optional.historicalMemberDaily ? csvStats(optional.historicalMemberDaily.bytes) : undefined,
    ),
    indexDaily: descriptor(
      reportDataset(report, "indexDaily"),
      "indexDaily",
      String(reportDataset(report, "indexDaily").mode),
      optional.indexDaily ? fileIntegrity(optional.indexDaily.bytes) : null,
      optional.indexDaily ? csvStats(optional.indexDaily.bytes) : undefined,
    ),
    comparatorFactors: descriptor(
      reportDataset(report, "comparatorFactors"),
      "comparatorFactors",
      String(reportDataset(report, "comparatorFactors").mode),
      optional.comparatorFactors ? fileIntegrity(optional.comparatorFactors.bytes) : null,
      optional.comparatorFactors ? csvStats(optional.comparatorFactors.bytes) : undefined,
    ),
  } satisfies Record<CaseDatasetName, CaseDataset>;
  const reportBytes = serializeJson(report);
  const plan = csi300MomentumDataPlan();
  requireValue(
    typeof base.factorWindowAnchor === "string" &&
      typeof report.window.end === "string" &&
      typeof base.primarySourceRef === "string" &&
      typeof base.fallbackSourceRef === "string" &&
      typeof base.priceSourceMode === "string",
    "coverage is invalid",
  );
  const packageState = DATASET_NAMES.some((name) => datasets[name].status === "degraded")
    ? "degraded"
    : "ready";
  const sourceSummaryBytes = serializeJson({
    schemaVersion: "assay-case-source-summary-v1",
    packageId: CSI300_MOMENTUM_CASE_PACKAGE_ID,
    generatedAt: report.generatedAt,
    state: packageState,
    sources: {
      equityDaily: {
        status: "ready",
        primarySourceRef: base.primarySourceRef,
        fallbackSourceRef: base.fallbackSourceRef,
        mode: base.priceSourceMode,
        fallbackFillCount: integer(base.fallbackFillCount, "fallback fill count"),
        fallbackRecords: "provenance/fallback-records",
      },
      indexMembership: {
        status: "ready",
        sourceRef: "pandadata:get_index_weights",
        snapshots: pitStats.tradingDates,
        memberSymbols: pitStats.symbols,
        equityPanelSymbols: marketStats.symbols,
        symbolsWithoutPromotedDailyHistory: pitStats.symbols - marketStats.symbols,
      },
    },
    degradedDatasets: DATASET_NAMES.filter((name) => datasets[name].status === "degraded").map(
      (name) => ({
        name,
        path: null,
        mode: datasets[name].mode,
        reasonCode: datasets[name].reasonCode,
        assumptions: datasets[name].assumptions,
      }),
    ),
    incompleteAttempts: {
      path: "provenance/incomplete-attempts",
      runtimeEligible: false,
    },
  });
  const manifest: CaseDataPackageManifest = {
    schemaVersion: CASE_DATA_PACKAGE_SCHEMA_VERSION,
    packageId: CSI300_MOMENTUM_CASE_PACKAGE_ID,
    generatedAt: report.generatedAt,
    strategyKey: plan.strategyKey,
    universe: { indexSymbol: "000300.SH", membershipMode: "point_in_time" },
    window: plan.window,
    coverage: { start: base.factorWindowAnchor, end: report.window.end, asOf: report.window.end },
    state: packageState,
    assumptions: strings(report.assumptions, "report assumptions"),
    datasets,
    provenance: {
      sourceSummary: {
        path: "provenance/source-summary.json",
        integrity: fileIntegrity(sourceSummaryBytes),
      },
      fallbackRecords: {
        path: "provenance/fallback-records",
        integrity: treeIntegrity(fallbackFiles),
      },
      preparationReport: {
        path: "provenance/preparation-report.json",
        integrity: fileIntegrity(reportBytes),
      },
      incompleteAttempts: {
        path: "provenance/incomplete-attempts",
        integrity: treeIntegrity(attemptFiles),
      },
    },
  };
  const packageRoot = join(destinationRoot, CSI300_MOMENTUM_CASE_PACKAGE_ID);
  await atomicPackage(packageRoot, async (root) => {
    await mkdir(join(root, "datasets"), { recursive: true });
    await copyFile(marketPath, join(root, PATHS.equityDaily));
    await copyFiles(pitFiles, join(root, PATHS.indexMembership));
    await copyFiles(fallbackFiles, join(root, "provenance/fallback-records"));
    await copyFiles(attemptFiles, join(root, "provenance/incomplete-attempts"));
    for (const [name, item] of Object.entries(optional) as [
      keyof typeof SOURCE_NAMES,
      { path: string },
    ][]) {
      await mkdir(dirname(join(root, PATHS[name])), { recursive: true });
      await copyFile(item.path, join(root, PATHS[name]));
    }
    await mkdir(join(root, "provenance"), { recursive: true });
    await writeFile(join(root, "provenance/source-summary.json"), sourceSummaryBytes);
    await writeFile(join(root, "provenance/preparation-report.json"), reportBytes);
    await writeFile(join(root, "manifest.json"), serializeJson(manifest));
    await validateCaseDataPackage(root, CSI300_MOMENTUM_CASE_PACKAGE_ID);
  });
  return { ...(await validateCaseDataPackage(packageRoot)), plan };
}

/** Canonical two-layer name; the legacy export remains available to existing callers. */
export const exportCsi300MomentumSourceDataPackage = exportCsi300MomentumCasePackage;
