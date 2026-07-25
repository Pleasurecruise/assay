import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  LOCAL_DATA_REF_VERSION,
  LocalDataPackageError,
  LocalDataPackageResolver,
  type LocalDataPackageManifest,
} from "@assay/a2a-server";
import { strategyForData, toCanonicalStrategySpec } from "@assay/contracts";
import { DeterministicStrategyDataPlanner, type DataPlan } from "@assay/finance-tools";
import {
  GOLDEN_SHARED_RUNTIME_CHECKSUMS,
  GOLDEN_STRATEGY_CASES,
  canonicalSpecForGoldenCase,
  dataPlanForGoldenCase,
  type GoldenStrategyCase,
} from "./golden-cases";

export interface LoadedGoldenRuntimePackage {
  readonly goldenCase: GoldenStrategyCase;
  readonly root: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly manifestDigest: `sha256-${string}`;
  readonly manifest: LocalDataPackageManifest;
  readonly plan: DataPlan;
  readonly packageProvenanceSource: string;
}

export interface LoadedGoldenRuntimeRegistry {
  readonly root: string;
  readonly packages: readonly LoadedGoldenRuntimePackage[];
  readonly registryCapabilityDigest: `sha256-${string}`;
  readonly sharedChecksums: LocalDataPackageManifest["checksums"];
}

/** Compatibility type retained for the legacy single-G01 helpers. */
export type LoadedCsi300MomentumRuntimePackage = LoadedGoldenRuntimePackage;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function stableDigest(
  packages: readonly LoadedGoldenRuntimePackage[],
): `sha256-${string}` {
  const identities = packages
    .map(({ manifest, manifestDigest }) => ({
      packageId: manifest.packageId,
      strategyKey: manifest.strategyKey,
      manifestDigest,
    }))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.packageId, "utf8"), Buffer.from(right.packageId, "utf8")),
    );
  return `sha256-${createHash("sha256").update(JSON.stringify(identities), "utf8").digest("hex")}`;
}

function assertOnlyClaimsChangedPlan(
  goldenCase: GoldenStrategyCase,
  expected: DataPlan,
): DataPlan {
  const alternateClaimsSpec = toCanonicalStrategySpec({
    ...goldenCase.strategy,
    claims: {
      annualReturn: (goldenCase.claims.annualReturn ?? 0) + 0.01,
      sharpe: (goldenCase.claims.sharpe ?? 0) + 0.01,
    },
  });
  const alternate = new DeterministicStrategyDataPlanner().plan(
    strategyForData(alternateClaimsSpec),
  );
  requireValue(
    JSON.stringify(alternate) === JSON.stringify(expected),
    `${goldenCase.label} claims changed its claims-free DataPlan`,
  );
  return alternate;
}

async function assertUnsupportedStrategy(
  resolver: LocalDataPackageResolver,
): Promise<void> {
  const registered = GOLDEN_STRATEGY_CASES[1];
  requireValue(registered !== undefined, "G02 frozen strategy fixture is missing");
  const unregisteredSpec = toCanonicalStrategySpec({
    ...registered.strategy,
    selection: {
      ...registered.strategy.selection,
      topN: 31,
    },
  });
  const plan = new DeterministicStrategyDataPlanner().plan(strategyForData(unregisteredSpec));
  requireValue(
    !GOLDEN_STRATEGY_CASES.some((candidate) => candidate.strategyKey === plan.strategyKey),
    "unregistered strategy unexpectedly shares a frozen strategyKey",
  );
  try {
    await resolver.resolve(plan, "golden_unregistered_strategy");
  } catch (error) {
    requireValue(
      error instanceof LocalDataPackageError && error.code === "unsupported_strategy",
      "unregistered strategy failed for a reason other than unsupported_strategy",
    );
    return;
  }
  throw new Error("unregistered strategy incorrectly resolved a local data package");
}

export async function loadGoldenRuntimePackages(
  registryRoot: string,
): Promise<LoadedGoldenRuntimeRegistry> {
  const root = resolve(registryRoot);
  const resolver = new LocalDataPackageResolver({ root });
  const registeredPackageIds = await resolver.validateRegistry();
  const expectedPackageIds = GOLDEN_STRATEGY_CASES.map(({ packageId }) => packageId).sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
  );
  requireValue(
    JSON.stringify([...registeredPackageIds].sort()) === JSON.stringify(expectedPackageIds),
    "runtime registry does not contain exactly the three frozen strategy packages",
  );

  const packages: LoadedGoldenRuntimePackage[] = [];
  for (const [index, goldenCase] of GOLDEN_STRATEGY_CASES.entries()) {
    const packageRoot = join(root, goldenCase.packageId);
    const manifestPath = join(packageRoot, "manifest.json");
    const manifestBytes = await readFile(manifestPath);
    const manifestDigest =
      `sha256-${createHash("sha256").update(manifestBytes).digest("hex")}` as const;
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as LocalDataPackageManifest;
    const plan = dataPlanForGoldenCase(goldenCase);
    const auditId = `golden_runtime_validation_${String(index + 1)}`;
    const resolved = await resolver.resolve(plan, auditId);
    const packageProvenanceSource =
      `assay:local-data-package:${goldenCase.packageId}:${manifestDigest}`;

    requireValue(
      manifest.packageId === goldenCase.packageId &&
        manifest.strategyKey === goldenCase.strategyKey &&
        manifest.strategyKey === plan.strategyKey &&
        resolved.packageId === goldenCase.packageId &&
        resolved.dataRef ===
          `${LOCAL_DATA_REF_VERSION}:${auditId}:${goldenCase.packageId}:${manifestDigest}` &&
        resolved.sources.includes(packageProvenanceSource),
      `${goldenCase.label} runtime package is not bound to its claims-free DataPlan`,
    );

    const claimsOnlyPlan = assertOnlyClaimsChangedPlan(goldenCase, plan);
    const claimsOnlyResolution = await resolver.resolve(
      claimsOnlyPlan,
      `golden_claims_validation_${String(index + 1)}`,
    );
    requireValue(
      claimsOnlyResolution.packageId === goldenCase.packageId,
      `${goldenCase.label} claims-only change selected a different runtime package`,
    );

    packages.push({
      goldenCase,
      root,
      packageRoot,
      manifestPath,
      manifestDigest,
      manifest,
      plan,
      packageProvenanceSource,
    });
  }

  requireValue(
    new Set(packages.map(({ manifest }) => manifest.packageId)).size ===
      GOLDEN_STRATEGY_CASES.length,
    "golden runtime packageIds are not unique",
  );
  requireValue(
    new Set(packages.map(({ manifest }) => manifest.strategyKey)).size ===
      GOLDEN_STRATEGY_CASES.length,
    "golden runtime strategyKeys are not unique",
  );
  for (const checksumName of ["marketData", "auditSupport", "pitMembership"] as const) {
    const checksums = new Set(packages.map(({ manifest }) => manifest.checksums[checksumName]));
    requireValue(
      checksums.size === 1 &&
        checksums.has(GOLDEN_SHARED_RUNTIME_CHECKSUMS[checksumName]),
      `golden runtime packages do not share the frozen ${checksumName} checksum`,
    );
  }

  await assertUnsupportedStrategy(resolver);
  const firstPackage = packages[0];
  requireValue(firstPackage !== undefined, "golden runtime registry has no packages");

  return {
    root,
    packages,
    registryCapabilityDigest: stableDigest(packages),
    sharedChecksums: firstPackage.manifest.checksums,
  };
}

/**
 * Compatibility entry point retained for offline legacy tests. The registry is
 * still validated as a three-package unit, then the semantic 20d/Top50 package
 * is returned.
 */
export async function loadCsi300MomentumRuntimePackage(
  registryRoot: string,
): Promise<LoadedCsi300MomentumRuntimePackage> {
  const registry = await loadGoldenRuntimePackages(registryRoot);
  const package_ = registry.packages.find(
    ({ goldenCase }) =>
      goldenCase.packageId === "csi300-momentum-20d-monthly-top50-equal",
  );
  requireValue(package_ !== undefined, "G01 runtime package is missing");
  requireValue(
    canonicalSpecForGoldenCase(package_.goldenCase).claims?.annualReturn === 0.18,
    "G01 compatibility fixture drifted",
  );
  return package_;
}
