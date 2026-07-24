import { createHash } from "node:crypto";

export function hashStrategySpec(canonicalJson: string): string {
  return `sha256:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`;
}
