import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  LOCAL_DATA_PACKAGE_SCHEMA_VERSION,
  LOCAL_DATA_RUNTIME_ROOT,
  LocalDataPackageResolver,
  type LocalDataCapabilityStatus,
  type LocalDataPackageManifest,
} from "@assay/a2a-server";
import {
  CASE_DATA_PACKAGE_ROOT,
  collectTreeFiles,
  isRecord,
  serializeJson,
  sha256Bytes,
  treeDigest,
  validateCaseDataRegistry,
  type CaseDataPackageManifest,
  type CaseDatasetName,
  type LoadedCaseDataPackage,
} from "./case_data_package";

export interface InstallLocalDataOptions {
  readonly sourceRoot?: string;
  readonly runtimeRoot?: string;
}

export interface InstalledLocalData {
  readonly sourceRoot: string;
  readonly runtimeRoot: string;
  readonly packageIds: readonly string[];
}

const RUNTIME_DATASET_PATHS: Readonly<
  Record<Exclude<CaseDatasetName, "equityDaily" | "indexMembership">, string>
> = {
  historicalMemberDaily: "audit-support/datasets/historical-members.csv",
  indexDaily: "audit-support/datasets/index-daily.csv",
  comparatorFactors: "audit-support/datasets/comparator-factors.csv",
};

const SOURCE_REPORT_DATASETS: Readonly<
  Record<Exclude<CaseDatasetName, "equityDaily" | "indexMembership">, string>
> = {
  historicalMemberDaily: "historicalMembers",
  indexDaily: "indexDaily",
  comparatorFactors: "comparatorFactors",
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent.length > 0 &&
    !isAbsolute(fromParent) &&
    fromParent !== ".." &&
    !fromParent.startsWith(`..${sep}`)
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function reportDataset(
  report: Record<string, unknown>,
  name: string,
  location: string,
): Record<string, unknown> {
  requireValue(isRecord(report.datasets), `${location} omitted datasets`);
  const dataset = report.datasets[name];
  requireValue(isRecord(dataset), `${location} omitted ${name}`);
  return dataset;
}

function transformCanonicalReport(
  value: unknown,
  manifest: CaseDataPackageManifest,
  location: string,
): Buffer {
  requireValue(isRecord(value), `${location} is not an object`);
  const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const basePanel = reportDataset(cloned, "basePanel", location);
  const pitTimeline = reportDataset(cloned, "pitTimeline", location);
  requireValue(
    basePanel.status === manifest.datasets.equityDaily.status &&
      basePanel.path === manifest.datasets.equityDaily.path &&
      isRecord(basePanel.fallbackProvenance) &&
      pitTimeline.status === manifest.datasets.indexMembership.status &&
      pitTimeline.path === manifest.datasets.indexMembership.path,
    `${location} does not match its canonical manifest`,
  );
  basePanel.path = "market-data.csv";
  basePanel.fallbackProvenance.path = "audit-support/fallback-provenance/provenance.json";
  pitTimeline.path = `pit-membership/index-weights/${manifest.universe.indexSymbol.replace(
    ".",
    "_",
  )}`;
  for (const [canonicalName, reportName] of Object.entries(SOURCE_REPORT_DATASETS) as [
    Exclude<CaseDatasetName, "equityDaily" | "indexMembership">,
    string,
  ][]) {
    const dataset = reportDataset(cloned, reportName, location);
    const canonical = manifest.datasets[canonicalName];
    requireValue(
      dataset.status === canonical.status && dataset.path === canonical.path,
      `${location}.${reportName} does not match its canonical manifest`,
    );
    dataset.path = canonical.status === "ready" ? RUNTIME_DATASET_PATHS[canonicalName] : null;
  }
  return serializeJson(cloned);
}

async function copyTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  const files = await collectTreeFiles(sourceRoot);
  for (const file of files) {
    const destination = join(destinationRoot, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    requireValue(file.absolutePath !== null, "validated package tree has no physical source");
    await copyFile(file.absolutePath, destination);
  }
}

function runtimeCapability(status: "ready" | "degraded"): LocalDataCapabilityStatus {
  return status;
}

async function materializeRuntimePackage(
  source: LoadedCaseDataPackage,
  destinationRoot: string,
): Promise<void> {
  const manifest = source.manifest;
  requireValue(
    manifest.datasets.equityDaily.status === "ready" &&
      manifest.datasets.indexMembership.status === "ready",
    `${manifest.packageId} cannot run without equity daily and PIT membership datasets`,
  );
  const preparationReportPath = join(
    source.packageRoot,
    manifest.provenance.preparationReport.path,
  );
  const preparationReport = await readFile(preparationReportPath);
  let preparationReportValue: unknown;
  try {
    preparationReportValue = JSON.parse(preparationReport.toString("utf8"));
  } catch {
    throw new Error(`${manifest.packageId} preparation report is unreadable`);
  }
  const runtimeAuditManifest = transformCanonicalReport(
    preparationReportValue,
    manifest,
    `${manifest.packageId} preparation report`,
  );

  const packageRoot = join(destinationRoot, manifest.packageId);
  await mkdir(join(packageRoot, "audit-support", "fallback-provenance"), { recursive: true });
  await mkdir(
    join(
      packageRoot,
      "pit-membership",
      "index-weights",
      manifest.universe.indexSymbol.replace(".", "_"),
    ),
    { recursive: true },
  );
  await copyFile(
    join(source.packageRoot, manifest.datasets.equityDaily.path as string),
    join(packageRoot, "market-data.csv"),
  );
  await copyTree(
    join(source.packageRoot, manifest.datasets.indexMembership.path as string),
    join(
      packageRoot,
      "pit-membership",
      "index-weights",
      manifest.universe.indexSymbol.replace(".", "_"),
    ),
  );
  await copyTree(
    join(source.packageRoot, manifest.provenance.fallbackRecords.path),
    join(packageRoot, "audit-support", "fallback-provenance"),
  );
  for (const datasetName of Object.keys(
    RUNTIME_DATASET_PATHS,
  ) as (keyof typeof RUNTIME_DATASET_PATHS)[]) {
    const dataset = manifest.datasets[datasetName];
    if (dataset.status === "ready") {
      const destination = join(packageRoot, RUNTIME_DATASET_PATHS[datasetName]);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(source.packageRoot, dataset.path as string), destination);
    }
  }
  await writeFile(join(packageRoot, "audit-support", "manifest.json"), runtimeAuditManifest);
  const [marketData, auditSupportFiles, pitMembershipFiles] = await Promise.all([
    readFile(join(packageRoot, "market-data.csv")),
    collectTreeFiles(join(packageRoot, "audit-support")),
    collectTreeFiles(join(packageRoot, "pit-membership")),
  ]);
  const runtimeManifest: LocalDataPackageManifest = {
    schemaVersion: LOCAL_DATA_PACKAGE_SCHEMA_VERSION,
    packageId: manifest.packageId,
    strategyKey: manifest.strategyKey,
    universe: manifest.universe,
    window: manifest.window,
    coverage: manifest.coverage,
    capabilities: {
      trade_calendar: "ready",
      pit_membership: "ready",
      adjusted_close: "ready",
      trade_status: "ready",
      index_daily: runtimeCapability(manifest.datasets.indexDaily.status),
      comparator_factors: runtimeCapability(manifest.datasets.comparatorFactors.status),
    },
    paths: {
      marketData: "market-data.csv",
      auditSupport: "audit-support",
      pitMembership: "pit-membership",
    },
    checksums: {
      marketData: sha256Bytes(marketData),
      auditSupport: treeDigest(auditSupportFiles),
      pitMembership: treeDigest(pitMembershipFiles),
    },
  };
  await writeFile(join(packageRoot, "manifest.json"), serializeJson(runtimeManifest));
}

async function moveExistingRuntime(runtimeRoot: string, backupRoot: string): Promise<boolean> {
  try {
    await rename(runtimeRoot, backupRoot);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function installLocalData(
  options: InstallLocalDataOptions = {},
): Promise<InstalledLocalData> {
  const sourceRoot = resolve(
    options.sourceRoot ??
      (process.env.ASSAY_CASE_DATA_PACKAGE_ROOT?.trim() || CASE_DATA_PACKAGE_ROOT),
  );
  const runtimeRoot = resolve(
    options.runtimeRoot ??
      (process.env.ASSAY_LOCAL_DATA_PACKAGE_ROOT?.trim() || LOCAL_DATA_RUNTIME_ROOT),
  );
  requireValue(
    sourceRoot !== runtimeRoot &&
      !pathIsWithin(sourceRoot, runtimeRoot) &&
      !pathIsWithin(runtimeRoot, sourceRoot),
    "case data source and runtime roots must be independent",
  );

  // Validate every canonical package and all declared bytes before touching runtime state.
  const packages = await validateCaseDataRegistry(sourceRoot);
  const packageIds = packages.map(({ manifest }) => manifest.packageId);
  const runtimeParent = dirname(runtimeRoot);
  const runtimeName = basename(runtimeRoot);
  const temporaryRoot = join(
    runtimeParent,
    `.${runtimeName}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  const backupRoot = join(
    runtimeParent,
    `.${runtimeName}.${String(process.pid)}.${randomUUID()}.bak`,
  );
  await mkdir(runtimeParent, { recursive: true });
  await mkdir(temporaryRoot);

  let movedExisting = false;
  let installed = false;
  try {
    for (const source of packages) {
      await materializeRuntimePackage(source, temporaryRoot);
    }
    const stagedPackageIds = await new LocalDataPackageResolver({
      root: temporaryRoot,
    }).validateRegistry();
    requireValue(
      JSON.stringify(stagedPackageIds) === JSON.stringify(packageIds),
      "runtime materialization changed the package registry",
    );

    movedExisting = await moveExistingRuntime(runtimeRoot, backupRoot);
    try {
      await rename(temporaryRoot, runtimeRoot);
      installed = true;
      await new LocalDataPackageResolver({ root: runtimeRoot }).validateRegistry();
    } catch (error) {
      if (installed) {
        await rm(runtimeRoot, { recursive: true, force: true });
        installed = false;
      }
      if (movedExisting) {
        await rename(backupRoot, runtimeRoot);
        movedExisting = false;
      }
      throw error;
    }
    if (movedExisting) {
      await rm(backupRoot, { recursive: true, force: true });
      movedExisting = false;
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (installed) {
      await rm(backupRoot, { recursive: true, force: true });
    }
  }
  return { sourceRoot, runtimeRoot, packageIds };
}

if (import.meta.main) {
  const installed = await installLocalData();
  process.stdout.write(
    `local data runtime ready: ${installed.runtimeRoot} (${installed.packageIds.join(", ")})\n`,
  );
}
