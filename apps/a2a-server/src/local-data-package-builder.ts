import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { strategyForData, toCanonicalStrategySpec } from "@assay/contracts";
import { DeterministicStrategyDataPlanner, type DataPlan } from "@assay/finance-tools";
import {
  LOCAL_DATA_PACKAGE_SCHEMA_VERSION,
  LocalDataPackageResolver,
  type LocalDataCapabilityStatus,
  type LocalDataPackageDescriptor,
} from "./local-data-package";

export const G01_LOCAL_PACKAGE_ID = "g01-csi300-momentum" as const;

export interface PrepareLocalMomentumPackageOptions {
  readonly root: string;
  readonly marketDataCache: string;
  readonly v9CacheRoot: string;
  readonly pitCacheRoot: string;
}

export interface PreparedLocalMomentumPackage {
  readonly root: string;
  readonly descriptorPath: string;
  readonly descriptorDigest: `sha256-${string}`;
  readonly descriptor: LocalDataPackageDescriptor;
  readonly plan: DataPlan;
}

interface TreeFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(content: Uint8Array): `sha256-${string}` {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

function compactDate(value: string): string {
  requireValue(/^\d{4}-\d{2}-\d{2}$/u.test(value), "golden package date is invalid");
  return value.replaceAll("-", "");
}

function capabilityStatus(value: unknown, location: string): LocalDataCapabilityStatus {
  requireValue(
    isRecord(value) && (value.status === "ready" || value.status === "degraded"),
    `${location} status is invalid`,
  );
  return value.status;
}

function relativePackagePath(root: string, path: string, location: string): string {
  const candidate = resolve(path);
  const fromRoot = relative(root, candidate);
  requireValue(
    fromRoot.length > 0 &&
      !isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`),
    `${location} must stay inside the local package root`,
  );
  return fromRoot.split(sep).join("/");
}

async function collectTreeFiles(root: string, directory = root, prefix = ""): Promise<TreeFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: TreeFile[] = [];
  for (const entry of entries) {
    requireValue(!entry.isSymbolicLink(), "golden PIT snapshot cannot contain symbolic links");
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTreeFiles(root, absolutePath, relativePath)));
    } else {
      requireValue(entry.isFile(), "golden PIT snapshot contains an unsupported entry");
      files.push({ relativePath, absolutePath });
    }
  }
  return files;
}

async function treeDigest(root: string): Promise<`sha256-${string}`> {
  const files = await collectTreeFiles(root);
  requireValue(files.length > 0, "golden PIT snapshot tree is empty");
  files.sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
  );
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.relativePath, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(await readFile(file.absolutePath));
  }
  return `sha256-${digest.digest("hex")}`;
}

async function writeDescriptor(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    if (Buffer.compare(await readFile(path), contents) === 0) {
      return;
    }
  } catch {
    // A missing descriptor is the normal first-run case.
  }
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function prepareLocalMomentumPackage(
  options: PrepareLocalMomentumPackageOptions,
): Promise<PreparedLocalMomentumPackage> {
  const root = resolve(options.root);
  const marketDataCache = resolve(options.marketDataCache);
  const v9CacheRoot = resolve(options.v9CacheRoot);
  const pitCacheRoot = resolve(options.pitCacheRoot);
  const v9ManifestBytes = await readFile(join(v9CacheRoot, "manifest.json"));
  const v9Manifest: unknown = JSON.parse(v9ManifestBytes.toString("utf8"));
  requireValue(isRecord(v9Manifest), "golden V9 manifest must be an object");
  requireValue(isRecord(v9Manifest.universe), "golden V9 manifest omitted its universe");
  requireValue(isRecord(v9Manifest.window), "golden V9 manifest omitted its window");
  requireValue(isRecord(v9Manifest.datasets), "golden V9 manifest omitted its datasets");
  const indexSymbol = v9Manifest.universe.indexSymbol;
  const dataAsOf = v9Manifest.window.end;
  const basePanel = v9Manifest.datasets.basePanel;
  const pitTimeline = v9Manifest.datasets.pitTimeline;
  const indexDaily = v9Manifest.datasets.indexDaily;
  const comparatorFactors = v9Manifest.datasets.comparatorFactors;
  requireValue(
    indexSymbol === "000300.SH" &&
      typeof dataAsOf === "string" &&
      isRecord(basePanel) &&
      typeof basePanel.factorWindowAnchor === "string",
    "golden V9 manifest identity is invalid",
  );
  const coverageStart = basePanel.factorWindowAnchor;
  const strategy = strategyForData(
    toCanonicalStrategySpec({
      specVersion: "1",
      universe: { index: indexSymbol },
      signal: {
        kind: "template",
        template: "momentum",
        params: { window: 20 },
      },
      selection: { topN: 50, weighting: "equal" },
      rebalance: { frequency: "monthly", at: "close" },
      window: {
        start: compactDate(coverageStart),
        end: compactDate(dataAsOf),
      },
      costs: { model: "standard" },
      claims: { annualReturn: 0.18, sharpe: 1.9 },
    }),
  );
  const plan = new DeterministicStrategyDataPlanner().plan(strategy);
  const pitSnapshotRoot = join(pitCacheRoot, "index-weights", indexSymbol.replace(".", "_"));
  const [marketDataBytes, pitTreeChecksum] = await Promise.all([
    readFile(marketDataCache),
    treeDigest(pitSnapshotRoot),
  ]);
  const descriptor: LocalDataPackageDescriptor = {
    schemaVersion: LOCAL_DATA_PACKAGE_SCHEMA_VERSION,
    packageId: G01_LOCAL_PACKAGE_ID,
    strategyKey: plan.strategyKey,
    universe: {
      indexSymbol,
      membershipMode: "point_in_time",
    },
    window: plan.window,
    coverage: {
      start: coverageStart,
      end: dataAsOf,
      asOf: dataAsOf,
    },
    capabilities: {
      trade_calendar: capabilityStatus(basePanel, "golden base panel"),
      pit_membership: capabilityStatus(pitTimeline, "golden PIT timeline"),
      adjusted_close: capabilityStatus(basePanel, "golden adjusted close"),
      trade_status: capabilityStatus(basePanel, "golden trade status"),
      index_daily: capabilityStatus(indexDaily, "golden index daily"),
      comparator_factors: capabilityStatus(comparatorFactors, "golden comparator factors"),
    },
    paths: {
      marketDataCache: relativePackagePath(root, marketDataCache, "golden market data"),
      v9CacheRoot: relativePackagePath(root, v9CacheRoot, "golden V9 cache"),
      pitCacheRoot: relativePackagePath(root, pitCacheRoot, "golden PIT cache"),
    },
    checksums: {
      marketData: sha256(marketDataBytes),
      v9Manifest: sha256(v9ManifestBytes),
      pitTree: pitTreeChecksum,
    },
  };
  const descriptorContents = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  const descriptorPath = join(root, "local-packages", `${G01_LOCAL_PACKAGE_ID}.json`);
  await writeDescriptor(descriptorPath, descriptorContents);
  await new LocalDataPackageResolver({ root }).resolve(plan, "golden_descriptor_validation");
  return {
    root,
    descriptorPath,
    descriptorDigest: sha256(descriptorContents),
    descriptor,
    plan,
  };
}
