import {
  AUDIT_ARTIFACT_SCHEMA_VERSION,
  AUDIT_CHECK_IDS,
  type AuditCheckId,
  type CanonicalStrategySpec,
  type CheckBudget,
  AUDIT_REQUEST_SCHEMA_VERSION,
  STRATEGY_SPEC_VERSION,
  canonicalizeStrategySpec,
  hashStrategySpec,
  toCanonicalStrategySpec,
  type StrategySpec,
} from "@assay/contracts";

export interface CheckPlan {
  budgets: Readonly<Record<AuditCheckId, CheckBudget>>;
}

export interface FrozenAuditInput {
  requestSchemaVersion: string;
  strategySpecVersion: string;
  artifactSchemaVersion: string;
  skill: "audit_strategy";
  spec: CanonicalStrategySpec;
  canonicalJson: string;
  specHash: string;
  defaultsApplied: readonly string[];
  dataAsOf: string;
  capabilitySnapshotId: string;
  checkPlan: CheckPlan;
  codeRevision: string;
}

export interface FreezeStrategyOptions {
  dataAsOf: string;
  capabilitySnapshotId: string;
  codeRevision: string;
  checkPlan?: CheckPlan;
}

const DEFAULT_CHECK_BUDGET: Readonly<CheckBudget> = Object.freeze({
  timeoutMs: 120_000,
  maxVariants: 8,
});

export const SKELETON_CHECK_PLAN: CheckPlan = Object.freeze({
  budgets: Object.freeze(
    Object.fromEntries(AUDIT_CHECK_IDS.map((checkId) => [checkId, DEFAULT_CHECK_BUDGET])) as Record<
      AuditCheckId,
      CheckBudget
    >,
  ),
});

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function collectAppliedDefaults(
  strategySpec: StrategySpec,
  canonicalSpec: CanonicalStrategySpec,
): readonly string[] {
  const defaults: string[] = [];
  if (strategySpec.signal.kind === "template") {
    if (canonicalSpec.signal.kind !== "template") {
      throw new Error("Canonical signal kind changed during default expansion");
    }
    if (strategySpec.signal.params?.window === undefined) {
      defaults.push(`signal.params.window=${canonicalSpec.signal.params.window}`);
    }
    if (
      (strategySpec.signal.template === "volatility" ||
        strategySpec.signal.template === "turnover_rate") &&
      strategySpec.signal.params?.direction === undefined &&
      (canonicalSpec.signal.template === "volatility" ||
        canonicalSpec.signal.template === "turnover_rate")
    ) {
      defaults.push(`signal.params.direction=${canonicalSpec.signal.params.direction}`);
    }
  }
  if (strategySpec.selection.weighting === undefined) {
    defaults.push("selection.weighting=equal");
  }
  if (strategySpec.rebalance.at === undefined) {
    defaults.push("rebalance.at=close");
  }
  if (strategySpec.costs === undefined) {
    defaults.push("costs.model=standard");
  }
  return defaults;
}

export function freezeStrategySpec(
  strategySpec: StrategySpec,
  options: FreezeStrategyOptions,
): FrozenAuditInput {
  const spec = deepFreeze(toCanonicalStrategySpec(strategySpec));
  const canonicalJson = canonicalizeStrategySpec(spec);
  const specHash = hashStrategySpec(canonicalJson);
  const defaultsApplied = collectAppliedDefaults(strategySpec, spec);

  return deepFreeze({
    requestSchemaVersion: AUDIT_REQUEST_SCHEMA_VERSION,
    strategySpecVersion: STRATEGY_SPEC_VERSION,
    artifactSchemaVersion: AUDIT_ARTIFACT_SCHEMA_VERSION,
    skill: "audit_strategy" as const,
    spec,
    canonicalJson,
    specHash,
    defaultsApplied,
    dataAsOf: options.dataAsOf,
    capabilitySnapshotId: options.capabilitySnapshotId,
    checkPlan: options.checkPlan ?? SKELETON_CHECK_PLAN,
    codeRevision: options.codeRevision,
  });
}
