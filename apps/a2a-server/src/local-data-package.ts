import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  LOCAL_DATA_REQUIREMENTS,
  type DataPlan,
  type LocalDataRequirement,
} from "@assay/finance-tools";

export const LOCAL_DATA_PACKAGE_SCHEMA_VERSION = "assay-local-data-package-v1" as const;
export const LOCAL_DATA_REF_VERSION = "assay-local-data-v1" as const;
export const LOCAL_DATA_RUNTIME_ROOT = ".cache/assay/local-packages" as const;

const MAX_MANIFEST_BYTES = 256 * 1024;
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const AUDIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const CURRENT_SUPPORTED_INDEX_SYMBOL = "000300.SH";
const COMPACT_DATE_PATTERN = /^\d{8}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256_PATTERN = /^sha256-[a-f0-9]{64}$/u;
const BASE_REQUIREMENTS = LOCAL_DATA_REQUIREMENTS.filter(
  (requirement) => requirement !== "strategy_signal_factors",
) as readonly Exclude<LocalDataRequirement, "strategy_signal_factors">[];
const REQUIRED_READY_CAPABILITIES = [
  "trade_calendar",
  "pit_membership",
  "adjusted_close",
  "trade_status",
] as const;

export type LocalDataCapabilityStatus = "ready" | "degraded";
export type LocalDataPackageErrorCode =
  | "ambiguous_match"
  | "manifest_invalid"
  | "package_integrity_failed"
  | "registry_unavailable"
  | "unsupported_strategy";

export class LocalDataPackageError extends Error {
  readonly code: LocalDataPackageErrorCode;

  constructor(code: LocalDataPackageErrorCode) {
    const messageByCode: Readonly<Record<LocalDataPackageErrorCode, string>> = {
      ambiguous_match: "Local data package resolution returned more than one match",
      manifest_invalid: "Local data package manifest is invalid",
      package_integrity_failed: "Local data package integrity verification failed",
      registry_unavailable: "Local data package registry is unavailable",
      unsupported_strategy: "No local data package supports the frozen strategy",
    };
    super(messageByCode[code]);
    this.name = "LocalDataPackageError";
    this.code = code;
  }
}

export type LocalDataPackageCapabilities = Readonly<
  Record<Exclude<LocalDataRequirement, "strategy_signal_factors">, LocalDataCapabilityStatus>
>;

export interface LocalDataPackageManifest {
  readonly schemaVersion: typeof LOCAL_DATA_PACKAGE_SCHEMA_VERSION;
  readonly packageId: string;
  readonly strategyKey: `sha256-${string}`;
  readonly universe: {
    readonly indexSymbol: string;
    readonly membershipMode: "point_in_time";
  };
  readonly window: {
    readonly start: string;
    readonly end: string;
  };
  readonly coverage: {
    readonly start: string;
    readonly end: string;
    readonly asOf: string;
  };
  readonly capabilities: LocalDataPackageCapabilities;
  readonly paths: {
    readonly marketData: string;
    readonly auditSupport: string;
    readonly pitMembership: string;
  };
  readonly checksums: {
    readonly marketData: `sha256-${string}`;
    readonly auditSupport: `sha256-${string}`;
    readonly pitMembership: `sha256-${string}`;
  };
}

export interface PreparedLocalAuditData {
  readonly dataRef: string;
  readonly sources: readonly string[];
  readonly packageId: string;
}

export interface LocalDataPackageResolverOptions {
  readonly root: string;
}

interface ParsedManifest {
  readonly manifest: LocalDataPackageManifest;
  readonly digest: `sha256-${string}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validCalendarDate(value: string, pattern: RegExp): boolean {
  if (!pattern.test(value)) {
    return false;
  }
  const iso =
    value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
  const timestamp = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === iso;
}

function sha256Bytes(content: Uint8Array): `sha256-${string}` {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

function parseCapabilityStatus(value: unknown): LocalDataCapabilityStatus | undefined {
  return value === "ready" || value === "degraded" ? value : undefined;
}

function parseManifest(raw: Uint8Array): ParsedManifest {
  if (raw.byteLength === 0 || raw.byteLength > MAX_MANIFEST_BYTES) {
    throw new LocalDataPackageError("manifest_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new LocalDataPackageError("manifest_invalid");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "packageId",
      "strategyKey",
      "universe",
      "window",
      "coverage",
      "capabilities",
      "paths",
      "checksums",
    ]) ||
    value.schemaVersion !== LOCAL_DATA_PACKAGE_SCHEMA_VERSION ||
    typeof value.packageId !== "string" ||
    !PACKAGE_ID_PATTERN.test(value.packageId) ||
    typeof value.strategyKey !== "string" ||
    !SHA256_PATTERN.test(value.strategyKey)
  ) {
    throw new LocalDataPackageError("manifest_invalid");
  }

  const universe = value.universe;
  const window = value.window;
  const coverage = value.coverage;
  const capabilities = value.capabilities;
  const paths = value.paths;
  const checksums = value.checksums;
  if (
    !isRecord(universe) ||
    !hasExactKeys(universe, ["indexSymbol", "membershipMode"]) ||
    universe.indexSymbol !== CURRENT_SUPPORTED_INDEX_SYMBOL ||
    universe.membershipMode !== "point_in_time" ||
    !isRecord(window) ||
    !hasExactKeys(window, ["start", "end"]) ||
    typeof window.start !== "string" ||
    typeof window.end !== "string" ||
    !validCalendarDate(window.start, COMPACT_DATE_PATTERN) ||
    !validCalendarDate(window.end, COMPACT_DATE_PATTERN) ||
    window.start > window.end ||
    !isRecord(coverage) ||
    !hasExactKeys(coverage, ["start", "end", "asOf"]) ||
    typeof coverage.start !== "string" ||
    typeof coverage.end !== "string" ||
    typeof coverage.asOf !== "string" ||
    !validCalendarDate(coverage.start, ISO_DATE_PATTERN) ||
    !validCalendarDate(coverage.end, ISO_DATE_PATTERN) ||
    !validCalendarDate(coverage.asOf, ISO_DATE_PATTERN) ||
    coverage.start > coverage.end ||
    coverage.asOf < coverage.end ||
    !isRecord(capabilities) ||
    !BASE_REQUIREMENTS.every(
      (requirement) => parseCapabilityStatus(capabilities[requirement]) !== undefined,
    ) ||
    !REQUIRED_READY_CAPABILITIES.every((requirement) => capabilities[requirement] === "ready") ||
    !hasExactKeys(capabilities, BASE_REQUIREMENTS) ||
    !isRecord(paths) ||
    !hasExactKeys(paths, ["marketData", "auditSupport", "pitMembership"]) ||
    !Object.values(paths).every((path) => typeof path === "string" && path.length > 0) ||
    !isRecord(checksums) ||
    !hasExactKeys(checksums, ["marketData", "auditSupport", "pitMembership"]) ||
    !Object.values(checksums).every(
      (checksum) => typeof checksum === "string" && SHA256_PATTERN.test(checksum),
    )
  ) {
    throw new LocalDataPackageError("manifest_invalid");
  }
  return {
    manifest: value as unknown as LocalDataPackageManifest,
    digest: sha256Bytes(raw),
  };
}

function pathEscapesRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
}

async function checkedRegistryRoot(root: string): Promise<string> {
  if (!root.trim()) {
    throw new LocalDataPackageError("registry_unavailable");
  }
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new LocalDataPackageError("registry_unavailable");
    }
    return await realpath(root);
  } catch (error) {
    if (error instanceof LocalDataPackageError) {
      throw error;
    }
    throw new LocalDataPackageError("registry_unavailable");
  }
}

async function checkedPackagePath(
  registryRoot: string,
  relativePath: string,
  kind: "file" | "directory",
): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new LocalDataPackageError("package_integrity_failed");
  }
  const candidate = resolve(registryRoot, relativePath);
  if (pathEscapesRoot(registryRoot, candidate)) {
    throw new LocalDataPackageError("package_integrity_failed");
  }
  try {
    const candidateStat = await lstat(candidate);
    if (
      candidateStat.isSymbolicLink() ||
      (kind === "file" && !candidateStat.isFile()) ||
      (kind === "directory" && !candidateStat.isDirectory())
    ) {
      throw new LocalDataPackageError("package_integrity_failed");
    }
    const physicalPath = await realpath(candidate);
    if (pathEscapesRoot(registryRoot, physicalPath)) {
      throw new LocalDataPackageError("package_integrity_failed");
    }
    return physicalPath;
  } catch (error) {
    if (error instanceof LocalDataPackageError) {
      throw error;
    }
    throw new LocalDataPackageError("package_integrity_failed");
  }
}

interface TreeFile {
  readonly relativePath: string;
  readonly physicalPath: string;
}

async function collectTreeFiles(root: string, directory: string, prefix = ""): Promise<TreeFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new LocalDataPackageError("package_integrity_failed");
  }
  const files: TreeFile[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new LocalDataPackageError("package_integrity_failed");
    }
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const physicalPath = resolve(directory, entry.name);
    if (pathEscapesRoot(root, physicalPath)) {
      throw new LocalDataPackageError("package_integrity_failed");
    }
    if (entry.isDirectory()) {
      files.push(...(await collectTreeFiles(root, physicalPath, relativePath)));
    } else if (entry.isFile()) {
      files.push({ relativePath, physicalPath });
    } else {
      throw new LocalDataPackageError("package_integrity_failed");
    }
  }
  return files;
}

async function treeDigest(root: string, signal?: AbortSignal): Promise<`sha256-${string}`> {
  const files = await collectTreeFiles(root, root);
  if (files.length === 0) {
    throw new LocalDataPackageError("package_integrity_failed");
  }
  files.sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
  );
  const digest = createHash("sha256");
  for (const file of files) {
    signal?.throwIfAborted();
    digest.update(file.relativePath, "utf8");
    digest.update(Buffer.from([0]));
    try {
      digest.update(await readFile(file.physicalPath));
    } catch {
      throw new LocalDataPackageError("package_integrity_failed");
    }
  }
  return `sha256-${digest.digest("hex")}`;
}

function supportsPlan(manifest: LocalDataPackageManifest, plan: DataPlan): boolean {
  return (
    manifest.strategyKey === plan.strategyKey &&
    manifest.universe.indexSymbol === plan.indexSymbol &&
    manifest.window.start === plan.window.start &&
    manifest.window.end === plan.window.end &&
    manifest.coverage.start <= plan.requiredCoverage.start &&
    manifest.coverage.end >= plan.requiredCoverage.end &&
    manifest.coverage.asOf >= plan.requiredCoverage.end &&
    plan.requirements.every(
      (requirement) =>
        requirement !== "strategy_signal_factors" &&
        parseCapabilityStatus(manifest.capabilities[requirement]) !== undefined,
    )
  );
}

async function verifyPackage(
  packageRoot: string,
  manifest: LocalDataPackageManifest,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const marketDataPath = await checkedPackagePath(packageRoot, manifest.paths.marketData, "file");
  const auditSupportRoot = await checkedPackagePath(
    packageRoot,
    manifest.paths.auditSupport,
    "directory",
  );
  const pitMembershipRoot = await checkedPackagePath(
    packageRoot,
    manifest.paths.pitMembership,
    "directory",
  );
  await checkedPackagePath(
    pitMembershipRoot,
    `index-weights/${manifest.universe.indexSymbol.replace(".", "_")}`,
    "directory",
  );
  await checkedPackagePath(auditSupportRoot, "manifest.json", "file");
  try {
    const marketData = await readFile(marketDataPath);
    signal?.throwIfAborted();
    if (
      sha256Bytes(marketData) !== manifest.checksums.marketData ||
      (await treeDigest(auditSupportRoot, signal)) !== manifest.checksums.auditSupport ||
      (await treeDigest(pitMembershipRoot, signal)) !== manifest.checksums.pitMembership
    ) {
      throw new LocalDataPackageError("package_integrity_failed");
    }
  } catch (error) {
    if (error instanceof LocalDataPackageError) {
      throw error;
    }
    throw new LocalDataPackageError("package_integrity_failed");
  }
}

interface RegisteredManifest extends ParsedManifest {
  readonly packageRoot: string;
}

async function readRegistryManifests(
  registryRoot: string,
  signal?: AbortSignal,
): Promise<readonly RegisteredManifest[]> {
  let entries;
  try {
    entries = await readdir(registryRoot, { withFileTypes: true });
  } catch {
    throw new LocalDataPackageError("registry_unavailable");
  }
  const packageNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (packageNames.length === 0) {
    throw new LocalDataPackageError("registry_unavailable");
  }

  const manifests: RegisteredManifest[] = [];
  for (const packageName of packageNames) {
    signal?.throwIfAborted();
    const packageRoot = await checkedPackagePath(registryRoot, packageName, "directory");
    const manifestPath = await checkedPackagePath(packageRoot, "manifest.json", "file");
    let raw: Buffer;
    try {
      raw = await readFile(manifestPath);
    } catch {
      throw new LocalDataPackageError("manifest_invalid");
    }
    const parsed = parseManifest(raw);
    if (packageName !== parsed.manifest.packageId) {
      throw new LocalDataPackageError("manifest_invalid");
    }
    manifests.push({ ...parsed, packageRoot });
  }
  return manifests;
}

export class LocalDataPackageResolver {
  readonly #root: string;

  constructor(options: LocalDataPackageResolverOptions) {
    this.#root = options.root;
  }

  async validateRegistry(signal?: AbortSignal): Promise<readonly string[]> {
    signal?.throwIfAborted();
    const registryRoot = await checkedRegistryRoot(this.#root);
    const manifests = await readRegistryManifests(registryRoot, signal);
    for (const { manifest, packageRoot } of manifests) {
      await verifyPackage(packageRoot, manifest, signal);
    }
    return manifests.map(({ manifest }) => manifest.packageId);
  }

  async resolve(
    plan: DataPlan,
    auditId: string,
    signal?: AbortSignal,
  ): Promise<PreparedLocalAuditData> {
    signal?.throwIfAborted();
    if (!AUDIT_ID_PATTERN.test(auditId)) {
      throw new LocalDataPackageError("manifest_invalid");
    }
    const registryRoot = await checkedRegistryRoot(this.#root);
    const manifests = await readRegistryManifests(registryRoot, signal);
    const matches: RegisteredManifest[] = [];
    for (const parsed of manifests) {
      if (supportsPlan(parsed.manifest, plan)) {
        matches.push(parsed);
      }
    }
    if (matches.length === 0) {
      throw new LocalDataPackageError("unsupported_strategy");
    }
    if (matches.length !== 1) {
      throw new LocalDataPackageError("ambiguous_match");
    }

    const match = matches[0] as RegisteredManifest;
    await verifyPackage(match.packageRoot, match.manifest, signal);
    const { manifest, digest } = match;
    return {
      dataRef: `${LOCAL_DATA_REF_VERSION}:${auditId}:${manifest.packageId}:${digest}`,
      packageId: manifest.packageId,
      sources: [
        `assay:local-data-package:${manifest.packageId}:${digest}`,
        `pandadata:market-data:${manifest.checksums.marketData}`,
        `pandadata:audit-support:${manifest.checksums.auditSupport}`,
        `pandadata:pit-membership:${manifest.checksums.pitMembership}`,
      ],
    };
  }
}
