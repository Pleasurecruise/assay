import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  LOCAL_DATA_REF_VERSION,
  LocalDataPackageResolver,
  type LocalDataPackageManifest,
} from "@assay/a2a-server";
import {
  CSI300_MOMENTUM_CASE_PACKAGE_ID,
  csi300MomentumDataPlan,
} from "../../../scripts/case_data_package";

export interface LoadedCsi300MomentumRuntimePackage {
  readonly root: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly manifestDigest: `sha256-${string}`;
  readonly manifest: LocalDataPackageManifest;
  readonly plan: ReturnType<typeof csi300MomentumDataPlan>;
}

export async function loadCsi300MomentumRuntimePackage(
  registryRoot: string,
): Promise<LoadedCsi300MomentumRuntimePackage> {
  const root = resolve(registryRoot);
  const packageRoot = join(root, CSI300_MOMENTUM_CASE_PACKAGE_ID);
  const manifestPath = join(packageRoot, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifestDigest =
    `sha256-${createHash("sha256").update(manifestBytes).digest("hex")}` as const;
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as LocalDataPackageManifest;
  const plan = csi300MomentumDataPlan();
  const auditId = "csi300_runtime_validation";
  const resolved = await new LocalDataPackageResolver({ root }).resolve(plan, auditId);
  if (
    manifest.packageId !== CSI300_MOMENTUM_CASE_PACKAGE_ID ||
    manifest.strategyKey !== plan.strategyKey ||
    resolved.packageId !== manifest.packageId ||
    resolved.dataRef !==
      `${LOCAL_DATA_REF_VERSION}:${auditId}:${manifest.packageId}:${manifestDigest}`
  ) {
    throw new Error("CSI300 momentum runtime package is not bound to its case data");
  }
  return { root, packageRoot, manifestPath, manifestDigest, manifest, plan };
}
