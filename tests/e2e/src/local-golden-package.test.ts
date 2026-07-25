import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { G01_LOCAL_PACKAGE_ID, prepareLocalGoldenPackage } from "./local-golden-package";

const roots: string[] = [];
const realGoldenRoot = resolve(".cache/assay");
const realGoldenTest = existsSync(join(realGoldenRoot, "v9-p1-v1", "manifest.json"))
  ? test
  : test.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(content: Uint8Array): string {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

describe("prepareLocalGoldenPackage", () => {
  test("writes only a deterministic descriptor around the existing golden files", async () => {
    const root = await mkdtemp(join(tmpdir(), "assay-golden-package-"));
    roots.push(root);
    const marketPath = join(root, "csi300-3y.csv");
    const v9Root = join(root, "v9-p1-v1");
    const pitRoot = join(root, "pit-availability-v1");
    const pitTimelineRoot = join(pitRoot, "index-weights", "000300_SH");
    await mkdir(v9Root);
    await mkdir(pitTimelineRoot, { recursive: true });
    const marketData = Buffer.from("date,symbol,adjClose,tradeStatus\n2026-07-23,000001.SZ,10,1\n");
    const pitData = Buffer.from('{"requestedDate":"2026-07-23","symbols":["000001.SZ"]}\n');
    const manifestData = Buffer.from(
      JSON.stringify({
        universe: { indexSymbol: "000300.SH" },
        window: { start: "2023-07-24", end: "2026-07-23" },
        datasets: {
          basePanel: { status: "ready", factorWindowAnchor: "2023-07-23" },
          pitTimeline: { status: "ready" },
          indexDaily: { status: "degraded" },
          comparatorFactors: { status: "degraded" },
        },
      }),
    );
    await writeFile(marketPath, marketData);
    await writeFile(join(v9Root, "manifest.json"), manifestData);
    await writeFile(join(pitTimelineRoot, "20260723.json"), pitData);

    const prepared = await prepareLocalGoldenPackage({
      root,
      marketDataCache: marketPath,
      v9CacheRoot: v9Root,
      pitCacheRoot: pitRoot,
    });
    const marketAfterPreparation = await readFile(marketPath);
    const descriptorBytes = await readFile(prepared.descriptorPath);
    const preparedAgain = await prepareLocalGoldenPackage({
      root,
      marketDataCache: marketPath,
      v9CacheRoot: v9Root,
      pitCacheRoot: pitRoot,
    });

    expect(marketAfterPreparation).toEqual(marketData);
    expect(prepared.descriptor.packageId).toBe(G01_LOCAL_PACKAGE_ID);
    expect(prepared.descriptor.window).toEqual({
      start: "20230723",
      end: "20260723",
    });
    expect(prepared.descriptor.checksums.marketData).toBe(sha256(marketData));
    expect(prepared.descriptor.checksums.v9Manifest).toBe(sha256(manifestData));
    expect(prepared.descriptor.checksums.pitTree).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(prepared.descriptorDigest).toBe(sha256(descriptorBytes));
    expect(await readFile(preparedAgain.descriptorPath)).toEqual(descriptorBytes);
    expect(preparedAgain.descriptorDigest).toBe(prepared.descriptorDigest);
  });

  realGoldenTest(
    "generates and validates the real G01 descriptor without copying data",
    async () => {
      const prepared = await prepareLocalGoldenPackage({
        root: realGoldenRoot,
        marketDataCache: join(realGoldenRoot, "csi300-3y.csv"),
        v9CacheRoot: join(realGoldenRoot, "v9-p1-v1"),
        pitCacheRoot: join(realGoldenRoot, "pit-availability-v1"),
      });

      expect(prepared.descriptor.packageId).toBe(G01_LOCAL_PACKAGE_ID);
      expect(prepared.plan.strategyKey).toBe(prepared.descriptor.strategyKey);
      expect(prepared.descriptorPath).toBe(
        join(realGoldenRoot, "local-packages", `${G01_LOCAL_PACKAGE_ID}.json`),
      );
    },
  );
});
