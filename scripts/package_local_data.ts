import { relative, resolve } from "node:path";
import {
  CASE_DATA_PACKAGE_ROOT,
  exportCsi300MomentumSourceDataPackage,
  writeCsi300MomentumCaseDataRegistry,
} from "./case_data_package";

const cacheRoot = resolve(process.env.ASSAY_PREPARATION_CACHE_ROOT?.trim() || ".cache/assay");
const destinationRoot = resolve(
  process.env.ASSAY_CASE_DATA_PACKAGE_ROOT?.trim() || CASE_DATA_PACKAGE_ROOT,
);
const exported = await exportCsi300MomentumSourceDataPackage({
  sourceRoot: cacheRoot,
  destinationRoot,
  marketDataCache: resolve(cacheRoot, "csi300-3y.csv"),
  v9CacheRoot: resolve(cacheRoot, "v9-p1-v1"),
  pitCacheRoot: resolve(cacheRoot, "pit-availability-v1"),
});
const bindings = await writeCsi300MomentumCaseDataRegistry(destinationRoot);

process.stdout.write(
  `case data package ready: ${relative(process.cwd(), exported.packageRoot)} ` +
    `(${exported.manifest.state}; ${String(bindings.length)} runtime bindings)\n`,
);
