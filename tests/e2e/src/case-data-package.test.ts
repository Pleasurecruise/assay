import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LocalDataPackageResolver, type LocalDataPackageManifest } from "@assay/a2a-server";
import { afterEach, describe, expect, test } from "vitest";
import {
  CASE_DATA_PACKAGE_ROOT,
  CASE_DATA_REGISTRY_FILENAME,
  CSI300_MOMENTUM_14D_TOP30_PACKAGE_ID,
  CSI300_MOMENTUM_20D_TOP50_PACKAGE_ID,
  CSI300_MOMENTUM_26D_TOP70_PACKAGE_ID,
  CSI300_MOMENTUM_CASE_BINDINGS,
  CSI300_MOMENTUM_CASE_PACKAGE_ID,
  collectTreeFiles,
  exportCsi300MomentumCasePackage,
  sha256Bytes,
  validateCaseDataPackage,
  validateCaseDataRegistry,
  writeCsi300MomentumCaseDataRegistry,
} from "../../../scripts/case_data_package";
import { installLocalData } from "../../../scripts/install_local_data";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

describe("complete case data package", () => {
  test("exports an honest case package from provider preparation inputs", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "assay-case-export-"));
    temporaryRoots.push(workspaceRoot);
    const sourceRoot = join(workspaceRoot, "source");
    const destinationRoot = join(workspaceRoot, "packages");
    const marketPath = join(sourceRoot, "csi300-3y.csv");
    const v9Root = join(sourceRoot, "v9-p1-v1");
    const pitRoot = join(sourceRoot, "pit-availability-v1");
    const fallbackRoot = join(v9Root, "fallback");
    const pitTimelineRoot = join(pitRoot, "index-weights", "000300_SH");
    const historyFragments = join(pitRoot, "extra-panel", "fixture", "fragments");
    const comparatorFragments = join(v9Root, "fragments", "comparator-factors", "period");
    await Promise.all([
      mkdir(fallbackRoot, { recursive: true }),
      mkdir(pitTimelineRoot, { recursive: true }),
      mkdir(join(historyFragments, "factor-close", "period"), { recursive: true }),
      mkdir(join(historyFragments, "trade-status", "period"), { recursive: true }),
      mkdir(comparatorFragments, { recursive: true }),
    ]);

    const market = "date,symbol,adjClose,tradeStatus\n2026-07-23,000001.SZ,10,1\n";
    await writeFile(marketPath, market);
    await writeJson(join(fallbackRoot, "provenance.json"), {
      schemaVersion: "fixture-fallback-provenance",
    });
    await writeJson(join(pitTimelineRoot, "20260723.json"), {
      schemaVersion: "pit-index-snapshot-v1",
      indexSymbol: "000300.SH",
      requestedDate: "2026-07-23",
      effectiveDate: "2026-07-23",
      symbols: ["000001.SZ", "000002.SZ"],
    });
    await writeJson(join(historyFragments, "factor-close", "period", "payload.json"), {
      schemaVersion: "pit-extra-panel-fragment-v2",
      start: "2026-07-23",
      end: "2026-07-23",
      symbols: ["000002.SZ"],
      rows: [{ date: "2026-07-23", symbol: "000002.SZ", adjClose: 20 }],
    });
    await writeJson(join(historyFragments, "trade-status", "period", "payload.json"), {
      schemaVersion: "pit-extra-panel-fragment-v2",
      start: "2026-07-23",
      end: "2026-07-23",
      symbols: ["000002.SZ"],
      rows: [{ date: "2026-07-23", symbol: "000002.SZ", tradeStatus: 1 }],
    });
    await writeJson(join(comparatorFragments, "payload.json"), {
      rows: [
        {
          date: "2026-07-23",
          symbol: "000001.SZ",
          ratio_pe_ttm: 10,
          market_cap: 100,
        },
      ],
    });

    const degraded = (mode: string, reasonCode: string, assumption: string) => ({
      status: "degraded",
      path: null,
      mode,
      reasonCode,
      assumptions: [assumption],
      rowCount: 0,
      symbols: 0,
      tradingDates: 0,
    });
    const report = {
      schemaVersion: "assay-p1-cache-manifest-v1",
      cacheVersion: "assay-v9-p1-v1",
      generatedAt: "2026-07-24T17:32:38.316413+00:00",
      promoted: true,
      state: "degraded",
      universe: { indexSymbol: "000300.SH", baseSymbols: 1 },
      window: { start: "2023-07-24", end: "2026-07-23" },
      assumptions: ["fixture preparation retained explicit degradations"],
      datasets: {
        basePanel: {
          status: "ready",
          path: "csi300-3y.csv",
          factorWindowAnchor: "2023-07-23",
          priceSourceMode: "factor-close-with-validated-official-post-fallback",
          primarySourceRef: "pandadata:get_factor(close)",
          fallbackSourceRef: "pandadata:get_stock_daily_post(close)",
          fallbackFillCount: 0,
          fallbackProvenance: { path: "v9-p1-v1/fallback/provenance.json" },
          assumptions: [],
          rowCount: 1,
          symbols: 1,
          tradingDates: 1,
        },
        pitTimeline: {
          status: "ready",
          path: "pit-availability-v1/index-weights/000300_SH",
          assumptions: [],
          rowCount: 2,
          symbols: 2,
          tradingDates: 1,
        },
        historicalMembers: degraded(
          "remove_only",
          "HISTORICAL_MEMBER_DATA_UNAVAILABLE",
          "history is incomplete",
        ),
        indexDaily: degraded(
          "constituent_proxy",
          "INDEX_DAILY_UNAVAILABLE",
          "index daily is unavailable",
        ),
        comparatorFactors: degraded(
          "classic_only",
          "COMPARATOR_FACTORS_UNAVAILABLE",
          "comparator factors are incomplete",
        ),
      },
    };
    await writeJson(join(v9Root, "manifest.json"), report);

    const options = {
      sourceRoot,
      destinationRoot,
      marketDataCache: marketPath,
      v9CacheRoot: v9Root,
      pitCacheRoot: pitRoot,
    };
    const exported = await exportCsi300MomentumCasePackage(options);
    const bindings = await writeCsi300MomentumCaseDataRegistry(destinationRoot);
    const firstManifest = await readFile(exported.manifestPath);
    const firstRegistry = await readFile(join(destinationRoot, CASE_DATA_REGISTRY_FILENAME));
    const exportedAgain = await exportCsi300MomentumCasePackage(options);
    const bindingsAgain = await writeCsi300MomentumCaseDataRegistry(destinationRoot);

    expect(exported.manifest.datasets.equityDaily.statistics).toEqual({
      rowCount: 1,
      symbols: 1,
      tradingDates: 1,
    });
    expect(exported.manifest.datasets.indexMembership.statistics).toEqual({
      rowCount: 2,
      symbols: 2,
      tradingDates: 1,
    });
    expect(exported.manifest.datasets.historicalMemberDaily).toMatchObject({
      status: "degraded",
      path: null,
      reasonCode: "HISTORICAL_MEMBER_DATA_UNAVAILABLE",
    });
    expect(exported.manifest.provenance.incompleteAttempts?.integrity.files).toBe(4);
    expect(
      await readFile(join(exported.packageRoot, "provenance", "source-summary.json")),
    ).not.toEqual(
      await readFile(join(exported.packageRoot, "provenance", "preparation-report.json")),
    );
    expect(await readFile(exportedAgain.manifestPath)).toEqual(firstManifest);
    expect(await readFile(join(destinationRoot, CASE_DATA_REGISTRY_FILENAME))).toEqual(
      firstRegistry,
    );
    expect(bindings.map(({ binding }) => binding)).toEqual(
      bindingsAgain.map(({ binding }) => binding),
    );
    expect(bindings).toHaveLength(3);
    expect(new Set(bindings.map(({ source }) => source)).size).toBe(1);
    expect(firstRegistry.toString("utf8")).not.toMatch(/"claims"|"costs"|"G0[123]"/u);

    const registryValue = JSON.parse(firstRegistry.toString("utf8")) as {
      bindings: Array<Record<string, unknown>>;
    };
    await writeJson(join(destinationRoot, CASE_DATA_REGISTRY_FILENAME), {
      schemaVersion: "assay-case-data-registry-v1",
      bindings: [...registryValue.bindings, registryValue.bindings[0]],
    });
    await expect(validateCaseDataRegistry(destinationRoot)).rejects.toThrow("duplicate packageId");
    const duplicateKey = structuredClone(registryValue);
    const firstKey = (duplicateKey.bindings[0]?.dataPlan as { strategyKey?: unknown } | undefined)
      ?.strategyKey;
    const secondPlan = duplicateKey.bindings[1]?.dataPlan as { strategyKey?: unknown } | undefined;
    if (secondPlan !== undefined) {
      secondPlan.strategyKey = firstKey;
    }
    await writeJson(join(destinationRoot, CASE_DATA_REGISTRY_FILENAME), {
      schemaVersion: "assay-case-data-registry-v1",
      bindings: duplicateKey.bindings,
    });
    await expect(validateCaseDataRegistry(destinationRoot)).rejects.toThrow(
      "duplicate strategyKey",
    );
    const uncovered = structuredClone(registryValue);
    const firstPlan = uncovered.bindings[0]?.dataPlan as
      | { requiredCoverage?: { start?: string } }
      | undefined;
    if (firstPlan?.requiredCoverage !== undefined) {
      firstPlan.requiredCoverage.start = "2023-07-22";
    }
    await writeJson(join(destinationRoot, CASE_DATA_REGISTRY_FILENAME), {
      schemaVersion: "assay-case-data-registry-v1",
      bindings: uncovered.bindings,
    });
    await expect(validateCaseDataRegistry(destinationRoot)).rejects.toThrow(
      "data plan is not covered",
    );
    await writeFile(join(destinationRoot, CASE_DATA_REGISTRY_FILENAME), firstRegistry);

    const runtimeRoot = join(workspaceRoot, "runtime");
    await installLocalData({ sourceRoot: destinationRoot, runtimeRoot });
    const installedManifestPath = join(
      runtimeRoot,
      CSI300_MOMENTUM_20D_TOP50_PACKAGE_ID,
      "manifest.json",
    );
    const installedManifest = await readFile(installedManifestPath);
    await writeFile(join(exported.packageRoot, "datasets", "equity-daily.csv"), "tampered\n");
    await expect(installLocalData({ sourceRoot: destinationRoot, runtimeRoot })).rejects.toThrow(
      "checksum failed",
    );
    expect(await readFile(installedManifestPath)).toEqual(installedManifest);
  });

  test("contains the complete real case bytes and explicit degraded boundaries", async () => {
    const sourceRoot = resolve(CASE_DATA_PACKAGE_ROOT);
    const packageRoot = resolve(sourceRoot, CSI300_MOMENTUM_CASE_PACKAGE_ID);
    const loaded = await validateCaseDataPackage(packageRoot, CSI300_MOMENTUM_CASE_PACKAGE_ID);
    const bindings = await validateCaseDataRegistry(sourceRoot);
    const sourceFiles = await collectTreeFiles(sourceRoot);

    expect(loaded.manifest.datasets.equityDaily).toMatchObject({
      status: "ready",
      path: "datasets/equity-daily.csv",
      statistics: { rowCount: 216_688, symbols: 300, tradingDates: 727 },
      integrity: { files: 1, bytes: 7_548_240 },
    });
    expect(loaded.manifest.datasets.indexMembership).toMatchObject({
      status: "ready",
      path: "datasets/index-membership/000300.SH",
      statistics: { rowCount: 11_112, symbols: 379, tradingDates: 37 },
      integrity: { files: 37, bytes: 143_700 },
    });
    for (const name of ["historicalMemberDaily", "indexDaily", "comparatorFactors"] as const) {
      expect(loaded.manifest.datasets[name].status).toBe("degraded");
      expect(loaded.manifest.datasets[name].path).toBeNull();
      expect(loaded.manifest.datasets[name].integrity).toBeNull();
    }
    expect(loaded.manifest.provenance.fallbackRecords.integrity.files).toBe(112);
    expect(loaded.manifest.provenance.incompleteAttempts?.integrity.files).toBe(371);
    expect(existsSync(join(packageRoot, "datasets", "historical-member-daily.csv"))).toBe(false);
    expect(existsSync(join(packageRoot, "datasets", "index-daily.csv"))).toBe(false);
    expect(existsSync(join(packageRoot, "datasets", "comparator-factors.csv"))).toBe(false);
    expect(await readFile(join(packageRoot, "provenance", "source-summary.json"))).not.toEqual(
      await readFile(join(packageRoot, "provenance", "preparation-report.json")),
    );
    expect(
      sourceFiles.filter(({ path }) => path.endsWith("/datasets/equity-daily.csv")),
    ).toHaveLength(1);
    expect(bindings.map(({ binding }) => binding)).toEqual(CSI300_MOMENTUM_CASE_BINDINGS);
    expect(bindings.map(({ binding }) => binding.packageId)).toEqual([
      CSI300_MOMENTUM_14D_TOP30_PACKAGE_ID,
      CSI300_MOMENTUM_20D_TOP50_PACKAGE_ID,
      CSI300_MOMENTUM_26D_TOP70_PACKAGE_ID,
    ]);
    expect(new Set(bindings.map(({ binding }) => binding.dataPlan.strategyKey)).size).toBe(3);
    expect(new Set(bindings.map(({ binding }) => binding.sourceDataPackageId)).size).toBe(1);
    expect(
      new Set(bindings.map(({ source }) => source).map(({ packageRoot }) => packageRoot)).size,
    ).toBe(1);
    expect(bindings.map(({ binding }) => binding.dataPlan.strategyKey)).toEqual([
      "sha256-9242fb1add11336293dd23983415e1493e25bdf924c06d04159b645b7f1c8195",
      "sha256-a9d796047db6ccb208f3d82df70287afbb50ddca1fd544f67718155a4dc1bddb",
      "sha256-15a2f8c08d6a7f1e2f8013d1c663c325cf9666b30a06a5d8382aefcfc99f21f9",
    ]);
  });

  test("installs only promoted case datasets into the runtime registry", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "assay-case-runtime-"));
    temporaryRoots.push(workspaceRoot);
    const sourceRoot = resolve(CASE_DATA_PACKAGE_ROOT);
    const runtimeRoot = join(workspaceRoot, ".cache", "assay", "local-packages");
    const sourceMarketPath = join(
      sourceRoot,
      CSI300_MOMENTUM_CASE_PACKAGE_ID,
      "datasets",
      "equity-daily.csv",
    );
    const sourceMarket = await readFile(sourceMarketPath);

    const installed = await installLocalData({ sourceRoot, runtimeRoot });
    const resolver = new LocalDataPackageResolver({ root: runtimeRoot });
    const runtimeManifests = await Promise.all(
      installed.packageIds.map(async (packageId) => {
        const manifestPath = join(runtimeRoot, packageId, "manifest.json");
        const bytes = await readFile(manifestPath);
        return {
          manifestPath,
          digest: sha256Bytes(bytes),
          manifest: JSON.parse(bytes.toString("utf8")) as LocalDataPackageManifest,
        };
      }),
    );
    const runtimeByPackageId = new Map(
      runtimeManifests.map((loaded) => [loaded.manifest.packageId, loaded]),
    );
    const runtime = runtimeByPackageId.get(CSI300_MOMENTUM_20D_TOP50_PACKAGE_ID);
    expect(runtime).toBeDefined();
    const runtimePackageRoot = join(runtimeRoot, CSI300_MOMENTUM_20D_TOP50_PACKAGE_ID);
    const runtimeAuditManifestPath = join(runtimePackageRoot, "audit-support", "manifest.json");
    const runtimeAuditManifest = JSON.parse(
      await readFile(runtimeAuditManifestPath, "utf8"),
    ) as Record<string, unknown>;

    expect(installed.packageIds).toEqual([
      CSI300_MOMENTUM_14D_TOP30_PACKAGE_ID,
      CSI300_MOMENTUM_20D_TOP50_PACKAGE_ID,
      CSI300_MOMENTUM_26D_TOP70_PACKAGE_ID,
    ]);
    expect(await readFile(join(runtimePackageRoot, "market-data.csv"))).toEqual(sourceMarket);
    expect(runtime?.manifest.capabilities.index_daily).toBe("degraded");
    expect(runtime?.manifest.capabilities.comparator_factors).toBe("degraded");
    expect(new Set(runtimeManifests.map(({ digest }) => digest)).size).toBe(3);
    for (const checksum of ["marketData", "auditSupport", "pitMembership"] as const) {
      expect(
        new Set(runtimeManifests.map(({ manifest }) => manifest.checksums[checksum])).size,
      ).toBe(1);
    }
    for (const binding of CSI300_MOMENTUM_CASE_BINDINGS) {
      expect(runtimeByPackageId.get(binding.packageId)?.manifest.strategyKey).toBe(
        binding.dataPlan.strategyKey,
      );
      await expect(
        resolver.resolve(binding.dataPlan, `runtime_${binding.packageId}`),
      ).resolves.toMatchObject({ packageId: binding.packageId });
    }
    await expect(
      resolver.resolve(
        {
          ...CSI300_MOMENTUM_CASE_BINDINGS[0].dataPlan,
          strategyKey: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        "runtime_unregistered",
      ),
    ).rejects.toMatchObject({ code: "unsupported_strategy" });
    expect(runtimeAuditManifest).toHaveProperty("generatedAt");
    expect(existsSync(join(runtimePackageRoot, "audit-support", "preparation-report.json"))).toBe(
      false,
    );
    expect(existsSync(join(runtimePackageRoot, "provenance", "incomplete-attempts"))).toBe(false);

    const originalRuntimeAuditManifest = await readFile(runtimeAuditManifestPath);
    await writeFile(
      runtimeAuditManifestPath,
      Buffer.concat([originalRuntimeAuditManifest, Buffer.from(" ")]),
    );
    await expect(resolver.validateRegistry()).rejects.toMatchObject({
      code: "package_integrity_failed",
    });
    await installLocalData({ sourceRoot, runtimeRoot });
    expect(await readFile(runtimeAuditManifestPath)).toEqual(originalRuntimeAuditManifest);
    expect(await readFile(sourceMarketPath)).toEqual(sourceMarket);
  }, 15_000);
});
