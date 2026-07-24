import { resolve } from "node:path";
import { pinAndVerifyV9RealGolden, V9_REAL_GOLDEN_PATH } from "./v9-real-golden";
import { V9_REAL_ARTIFACT_PATH } from "./v9-real-data";

const arguments_ = process.argv.slice(2);
if (arguments_.length > 2 || arguments_.includes("--help")) {
  process.stdout.write("Usage: pin-v9-real-golden [accepted-bundle.json] [golden.json]\n");
  process.exit(arguments_.includes("--help") ? 0 : 2);
}

const bundlePath = resolve(arguments_[0] ?? V9_REAL_ARTIFACT_PATH);
const goldenPath = resolve(arguments_[1] ?? V9_REAL_GOLDEN_PATH);
await pinAndVerifyV9RealGolden(bundlePath, goldenPath);
process.stdout.write("v9 real-data golden pinned and immediately verified\n");
