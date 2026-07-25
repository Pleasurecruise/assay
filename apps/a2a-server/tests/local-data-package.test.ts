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
  descriptor: Record<string, unknown>;
  descriptorPath: string;
  marketPath: string;
  pitFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "assay-local-package-"));
  roots.push(root);
  const descriptorRoot = join(root, "local-packages");
  const v9Root = join(root, "v9-p1-v1");
  const pitRoot = join(root, "pit-availability-v1");
  await mkdir(descriptorRoot);
  await mkdir(v9Root);
  await mkdir(join(pitRoot, "index-weights", "000300_SH"), { recursive: true });
  const marketPath = join(root, "csi300-3y.csv");
  const v9ManifestPath = join(v9Root, "manifest.json");
  const pitFile = join(pitRoot, "index-weights", "000300_SH", "20260723.json");
  const marketData = Buffer.from("date,symbol,adjClose,tradeStatus\n2026-07-23,000001.SZ,10,1\n");
  const v9Manifest = Buffer.from('{"cacheVersion":"assay-v9-p1-v1","promoted":true}\n');
  const pitData = Buffer.from('{"requestedDate":"2026-07-23","symbols":["000001.SZ"]}\n');
  await writeFile(marketPath, marketData);
  await writeFile(v9ManifestPath, v9Manifest);
  await writeFile(pitFile, pitData);
  const pitRelativePath = "20260723.json";
  const pitHash = createHash("sha256");
  pitHash.update(pitRelativePath, "utf8");
  pitHash.update(Buffer.from([0]));
  pitHash.update(pitData);

  const descriptor = {
    schemaVersion: LOCAL_DATA_PACKAGE_SCHEMA_VERSION,
    packageId: "g01-csi300-momentum",
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
      marketDataCache: "csi300-3y.csv",
      v9CacheRoot: "v9-p1-v1",
      pitCacheRoot: "pit-availability-v1",
    },
    checksums: {
      marketData: sha256(marketData),
      v9Manifest: sha256(v9Manifest),
      pitTree: `sha256-${pitHash.digest("hex")}`,
    },
  };
  const descriptorPath = join(descriptorRoot, "g01-csi300-momentum.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  return { root, descriptor, descriptorPath, marketPath, pitFile };
}

describe("LocalDataPackageResolver", () => {
  test("validates every immutable package before production readiness", async () => {
    const fixture = await fixtureRoot();
    const resolver = new LocalDataPackageResolver({ root: fixture.root });

    await expect(resolver.validateRegistry()).resolves.toEqual(["g01-csi300-momentum"]);
    await writeFile(fixture.marketPath, "tampered\n");
    await expect(resolver.validateRegistry()).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "package_integrity_failed",
    });
  });

  test("uniquely resolves and authenticates the golden local package", async () => {
    const fixture = await fixtureRoot();
    const rawDescriptor = await readFile(fixture.descriptorPath);
    const expectedDescriptorDigest = sha256(rawDescriptor);

    const result = await new LocalDataPackageResolver({ root: fixture.root }).resolve(
      goldenPlan(),
      "audit_g01",
    );

    const checksums = fixture.descriptor.checksums as Record<string, string>;
    expect(result).toEqual({
      dataRef: `assay-local-data-v1:audit_g01:g01-csi300-momentum:${expectedDescriptorDigest}`,
      packageId: "g01-csi300-momentum",
      sources: [
        `pandadata:market-data-cache:${checksums.marketData}`,
        `pandadata:v9-cache-manifest:${checksums.v9Manifest}`,
        `pandadata:pit-timeline:${checksums.pitTree}`,
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

  test("rejects multiple matching descriptors", async () => {
    const fixture = await fixtureRoot();
    const duplicate = {
      ...fixture.descriptor,
      packageId: "g01-duplicate",
    };
    await writeFile(
      join(fixture.root, "local-packages", "g01-duplicate.json"),
      JSON.stringify(duplicate),
    );

    await expect(
      new LocalDataPackageResolver({ root: fixture.root }).resolve(goldenPlan(), "audit_ambiguous"),
    ).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "ambiguous_match",
    });
  });

  test("requires descriptor filename to equal packageId", async () => {
    const fixture = await fixtureRoot();
    await writeFile(
      fixture.descriptorPath,
      JSON.stringify({
        ...fixture.descriptor,
        packageId: "renamed-package",
      }),
    );

    await expect(
      new LocalDataPackageResolver({ root: fixture.root }).resolve(goldenPlan(), "audit_filename"),
    ).rejects.toMatchObject({
      name: "LocalDataPackageError",
      code: "descriptor_invalid",
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

  test("rejects unsafe paths without exposing them in the public error", async () => {
    const fixture = await fixtureRoot();
    const unsafe = {
      ...fixture.descriptor,
      paths: {
        ...(fixture.descriptor.paths as Record<string, string>),
        marketDataCache: "../outside.csv",
      },
    };
    await writeFile(fixture.descriptorPath, JSON.stringify(unsafe));

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

  test("binds the recursive PIT tree rather than only one snapshot", async () => {
    const fixture = await fixtureRoot();
    await writeFile(fixture.pitFile, '{"requestedDate":"2026-07-23","symbols":[]}\n');

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
