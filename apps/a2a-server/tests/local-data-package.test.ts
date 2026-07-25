import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strategyForData, toCanonicalStrategySpec } from "@assay/contracts";
import { DeterministicStrategyDataPlanner } from "@assay/finance-tools";
import { afterEach, describe, expect, test } from "vitest";
import {
  LOCAL_DATA_PACKAGE_SCHEMA_VERSION,
  LocalDataPackageError,
  LocalDataPackageResolver,
} from "../src/local-data-package";

const PACKAGE_ID = "csi300-momentum-20d-monthly-top50-equal";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(content: Uint8Array): `sha256-${string}` {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

function goldenPlan() {
  const spec = toCanonicalStrategySpec({
    specVersion: "1",
    universe: { index: "000300.SH" },
    signal: {
      kind: "template",
      template: "momentum",
      params: { window: 20 },
    },
    selection: { topN: 50, weighting: "equal" },
    rebalance: { frequency: "monthly", at: "close" },
    window: { start: "20230723", end: "20260723" },
    costs: { model: "standard" },
    claims: { annualReturn: 0.18, sharpe: 1.9 },
  });
  return new DeterministicStrategyDataPlanner().plan(strategyForData(spec));
}

async function fixtureRoot(): Promise<{
  root: string;
  manifest: Record<string, unknown>;
  manifestPath: string;
  marketPath: string;
  auditManifestPath: string;
  pitMetadataFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "assay-local-package-"));
  roots.push(root);
  const packageRoot = join(root, PACKAGE_ID);
  const auditSupportRoot = join(packageRoot, "audit-support");
  const pitMembershipRoot = join(packageRoot, "pit-membership");
  await mkdir(auditSupportRoot, { recursive: true });
  await mkdir(join(pitMembershipRoot, "index-weights", "000300_SH"), { recursive: true });
  const marketPath = join(packageRoot, "market-data.csv");
  const auditManifestPath = join(auditSupportRoot, "manifest.json");
  const pitFile = join(pitMembershipRoot, "index-weights", "000300_SH", "20260723.json");
  const pitMetadataFile = join(pitMembershipRoot, "source.json");
  const marketData = Buffer.from("date,symbol,adjClose,tradeStatus\n2026-07-23,000001.SZ,10,1\n");
  const auditManifest = Buffer.from('{"cacheVersion":"assay-v9-p1-v1","promoted":true}\n');
  const pitData = Buffer.from('{"requestedDate":"2026-07-23","symbols":["000001.SZ"]}\n');
  const pitMetadata = Buffer.from('{"source":"pandadata"}\n');
  await writeFile(marketPath, marketData);
  await writeFile(auditManifestPath, auditManifest);
  await writeFile(pitFile, pitData);
  await writeFile(pitMetadataFile, pitMetadata);
  const pitHash = createHash("sha256");
  for (const [relativePath, content] of [
    ["index-weights/000300_SH/20260723.json", pitData],
    ["source.json", pitMetadata],
  ] as const) {
    pitHash.update(relativePath, "utf8");
    pitHash.update(Buffer.from([0]));
    pitHash.update(content);
  }
  const auditSupportHash = createHash("sha256");
  auditSupportHash.update("manifest.json", "utf8");
  auditSupportHash.update(Buffer.from([0]));
  auditSupportHash.update(auditManifest);

  const manifest = {
    schemaVersion: LOCAL_DATA_PACKAGE_SCHEMA_VERSION,
    packageId: PACKAGE_ID,
    strategyKey: goldenPlan().strategyKey,
    universe: {
      indexSymbol: "000300.SH",
      membershipMode: "point_in_time",
    },
    window: {
      start: "20230723",
      end: "20260723",
    },
    coverage: {
      start: "2023-07-23",
      end: "2026-07-23",
      asOf: "2026-07-23",
    },
    capabilities: {
      trade_calendar: "ready",
      pit_membership: "ready",
      adjusted_close: "ready",
      trade_status: "ready",
      index_daily: "degraded",
      comparator_factors: "degraded",
    },
    paths: {
      marketData: "market-data.csv",
      auditSupport: "audit-support",
      pitMembership: "pit-membership",
    },
    checksums: {
      marketData: sha256(marketData),
      auditSupport: `sha256-${auditSupportHash.digest("hex")}`,
      pitMembership: `sha256-${pitHash.digest("hex")}`,
    },
  };
  const manifestPath = join(packageRoot, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, manifest, manifestPath, marketPath, auditManifestPath, pitMetadataFile };
}

describe("LocalDataPackageResolver", () => {
  test("validates every immutable package before production readiness", async () => {
    const fixture = await fixtureRoot();
    const resolver = new LocalDataPackageResolver({ root: fixture.root });

    await expect(resolver.validateRegistry()).resolves.toEqual([PACKAGE_ID]);
    await writeFile(fixture.marketPath, "tampered\n");
    await expect(resolver.validateRegistry()).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "package_integrity_failed",
    });
  });

  test("uniquely resolves and authenticates the golden local package", async () => {
    const fixture = await fixtureRoot();
    const rawManifest = await readFile(fixture.manifestPath);
    const expectedManifestDigest = sha256(rawManifest);

    const result = await new LocalDataPackageResolver({ root: fixture.root }).resolve(
      goldenPlan(),
      "audit_g01",
    );

    const checksums = fixture.manifest.checksums as Record<string, string>;
    expect(result).toEqual({
      dataRef: `assay-local-data-v1:audit_g01:${PACKAGE_ID}:${expectedManifestDigest}`,
      packageId: PACKAGE_ID,
      sources: [
        `pandadata:market-data:${checksums.marketData}`,
        `pandadata:audit-support:${checksums.auditSupport}`,
        `pandadata:pit-membership:${checksums.pitMembership}`,
      ],
    });
  });

  test("rejects an unsupported strategy without choosing a default package", async () => {
    const fixture = await fixtureRoot();
    const plan = {
      ...goldenPlan(),
      strategyKey:
        "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    };

    await expect(
      new LocalDataPackageResolver({ root: fixture.root }).resolve(plan, "audit_other"),
    ).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "unsupported_strategy",
    });
  });

  test("rejects multiple matching manifests", async () => {
    const fixture = await fixtureRoot();
    const duplicate = {
      ...fixture.manifest,
      packageId: "duplicate-package",
    };
    const duplicateRoot = join(fixture.root, "duplicate-package");
    await mkdir(duplicateRoot);
    await writeFile(join(duplicateRoot, "manifest.json"), JSON.stringify(duplicate));

    await expect(
      new LocalDataPackageResolver({ root: fixture.root }).resolve(goldenPlan(), "audit_ambiguous"),
    ).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "ambiguous_match",
    });
  });

  test("requires the package directory name to equal packageId", async () => {
    const fixture = await fixtureRoot();
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({
        ...fixture.manifest,
        packageId: "renamed-package",
      }),
    );

    await expect(
      new LocalDataPackageResolver({ root: fixture.root }).resolve(goldenPlan(), "audit_filename"),
    ).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "manifest_invalid",
    });
  });

  test("fails closed when a bound package file is modified", async () => {
    const fixture = await fixtureRoot();
    await writeFile(fixture.marketPath, "tampered\n");

    await expect(
      new LocalDataPackageResolver({ root: fixture.root }).resolve(goldenPlan(), "audit_tampered"),
    ).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "package_integrity_failed",
    });
  });

  test("binds the complete audit-support tree", async () => {
    const fixture = await fixtureRoot();
    await writeFile(fixture.auditManifestPath, '{"cacheVersion":"tampered"}\n');

    await expect(
      new LocalDataPackageResolver({ root: fixture.root }).resolve(
        goldenPlan(),
        "audit_support_tampered",
      ),
    ).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "package_integrity_failed",
    });
  });

  test("rejects degraded hard data capabilities", async () => {
    const fixture = await fixtureRoot();
    const capabilities = fixture.manifest.capabilities as Record<string, string>;
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({
        ...fixture.manifest,
        capabilities: {
          ...capabilities,
          trade_calendar: "degraded",
        },
      }),
    );

    await expect(
      new LocalDataPackageResolver({ root: fixture.root }).resolve(
        goldenPlan(),
        "audit_degraded_calendar",
      ),
    ).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "manifest_invalid",
    });
  });

  test("rejects unsafe paths without exposing them in the public error", async () => {
    const fixture = await fixtureRoot();
    const unsafe = {
      ...fixture.manifest,
      paths: {
        ...(fixture.manifest.paths as Record<string, string>),
        marketData: "../outside.csv",
      },
    };
    await writeFile(fixture.manifestPath, JSON.stringify(unsafe));

    let observed: unknown;
    try {
      await new LocalDataPackageResolver({ root: fixture.root }).resolve(
        goldenPlan(),
        "audit_unsafe",
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(LocalDataPackageError);
    expect(observed).toMatchObject({ code: "package_integrity_failed" });
    expect((observed as Error).message).not.toContain("outside.csv");
  });

  test("binds the entire recursive PIT membership tree", async () => {
    const fixture = await fixtureRoot();
    await writeFile(fixture.pitMetadataFile, '{"source":"tampered"}\n');

    await expect(
      new LocalDataPackageResolver({ root: fixture.root }).resolve(
        goldenPlan(),
        "audit_pit_tampered",
      ),
    ).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "package_integrity_failed",
    });
  });
});
