import type { CanonicalStrategySpec } from "./strategy-spec";

/**
 * Frozen deterministic-tool boundary for CHECKS_WIRING §1-§3.
 *
 * The model-visible schemas omit `spec`; AgentRuntime binds the exact
 * host-frozen CanonicalStrategySpec after tool-schema validation. These wire
 * contracts describe the resulting request sent to the Python adapter and the
 * exact response accepted back by TypeScript.
 */
export const AUDIT_TOOL_CONTRACT_VERSION = "1.0.0" as const;

/** Frozen BACKTESTER D5/D10 experiment-summary identities. */
export const PARAMETER_GRID_SOURCE_REF = "artifact:backtest/parameter-grid" as const;
export const COST_STRESS_SOURCE_REF = "artifact:backtest/cost-stress" as const;
export const AVAILABILITY_AUDIT_SOURCE_REF = "artifact:data-availability/pit-audit" as const;
export const REGIME_SPLIT_SOURCE_REF = "artifact:regime-dependency/regime-split" as const;
export const HOMOGENEITY_AUDIT_SOURCE_REF = "artifact:homogeneity-decay/spearman-ic" as const;

export interface SingleVariantBudget {
  readonly maxVariants: 1;
}

export interface RunAvailabilityAuditRequest {
  readonly kind: "availability_audit";
  readonly spec: CanonicalStrategySpec;
  readonly budget: SingleVariantBudget;
}

export interface AvailabilityAuditResult {
  readonly contractVersion: typeof AUDIT_TOOL_CONTRACT_VERSION;
  readonly engineVersion: string;
  readonly mode: "full_pit" | "degraded_remove_only";
  readonly futureConstituentCount: number;
  readonly affectedRebalances: readonly string[];
  readonly sampleSymbols: readonly string[];
  readonly untradableTargets: number;
  readonly contaminatedSelectionRate: number;
  readonly corrected: {
    readonly annualReturn: number;
    readonly sharpe: number;
    /** Corrected annual return minus the fixed as-of annual return. */
    readonly delta: number;
  };
  readonly sourceRef: typeof AVAILABILITY_AUDIT_SOURCE_REF;
  readonly assumptions: readonly string[];
}

export type RegimeTrend = "up" | "down";
export type RegimeVolatility = "high" | "normal";

export interface RunRegimeSplitRequest {
  readonly kind: "regime_split";
  readonly spec: CanonicalStrategySpec;
  readonly budget: SingleVariantBudget;
}

export interface RegimeEnvironmentResult {
  readonly id: string;
  readonly trend: RegimeTrend;
  readonly volatility: RegimeVolatility;
  readonly days: number;
  readonly annualReturn: number;
  readonly sharpe: number | null;
  /**
   * Signed environment P&L contribution divided by the full-period P&L.
   * It may be negative or exceed one when environments offset each other.
   */
  readonly pnlShare: number;
}

export interface RegimeSplitResult {
  readonly contractVersion: typeof AUDIT_TOOL_CONTRACT_VERSION;
  readonly engineVersion: string;
  readonly kind: "regime_split";
  readonly mode: "index_daily" | "constituent_proxy";
  readonly environments: readonly RegimeEnvironmentResult[];
  readonly dominantEnvironment: {
    readonly id: string;
    readonly pnlShare: number;
  };
  readonly sourceRef: typeof REGIME_SPLIT_SOURCE_REF;
  readonly assumptions: readonly string[];
}

export const HOMOGENEITY_COMPARATORS = [
  "momentum_20",
  "reversal_5",
  "volatility_20",
  "ratio_pe_ttm",
  "market_cap",
] as const;

export type HomogeneityComparator = (typeof HOMOGENEITY_COMPARATORS)[number];

export interface RunHomogeneityRequest {
  readonly kind: "homogeneity";
  readonly spec: CanonicalStrategySpec;
  readonly budget: SingleVariantBudget;
}

export interface HomogeneityComparison {
  readonly comparator: HomogeneityComparator;
  readonly meanSpearman: number | null;
  readonly rebalanceObservations: number;
}

export interface AnnualInformationCoefficient {
  readonly year: string;
  readonly observations: number;
  readonly pearsonIc: number | null;
  readonly rankIc: number | null;
}

export interface HomogeneityAuditResult {
  readonly contractVersion: typeof AUDIT_TOOL_CONTRACT_VERSION;
  readonly engineVersion: string;
  readonly kind: "homogeneity";
  readonly mode: "full_factor_library" | "classic_only";
  readonly comparisons: readonly HomogeneityComparison[];
  readonly annualIc: readonly AnnualInformationCoefficient[];
  readonly summary: {
    readonly nearestComparator: HomogeneityComparator | null;
    readonly maxAbsMeanSpearman: number | null;
    /** Complete calendar anniversaries in the effective adjusted-close span. */
    readonly yearsCovered: number;
    readonly rankIcSlope: number | null;
  };
  readonly sourceRef: typeof HOMOGENEITY_AUDIT_SOURCE_REF;
  readonly assumptions: readonly string[];
}

const SINGLE_VARIANT_BUDGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["maxVariants"],
  properties: {
    maxVariants: { type: "integer", const: 1 },
  },
} as const;

const CANONICAL_SPEC_SCHEMA = {
  type: "object",
  description: "Host-bound canonical StrategySpec; never copied from model arguments.",
} as const;

const NON_EMPTY_STRING_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "string", minLength: 1 },
} as const;

const FINITE_NUMBER_OR_NULL_SCHEMA = {
  anyOf: [{ type: "number" }, { type: "null" }],
} as const;

export const RUN_AVAILABILITY_AUDIT_REQUEST_SCHEMA = {
  $id: "assay://schemas/run-availability-audit-request-v1",
  type: "object",
  additionalProperties: false,
  required: ["kind", "spec", "budget"],
  properties: {
    kind: { type: "string", const: "availability_audit" },
    spec: CANONICAL_SPEC_SCHEMA,
    budget: SINGLE_VARIANT_BUDGET_SCHEMA,
  },
} as const;

export const RUN_AVAILABILITY_AUDIT_RESPONSE_SCHEMA = {
  $id: "assay://schemas/run-availability-audit-response-v1",
  type: "object",
  additionalProperties: false,
  required: [
    "contractVersion",
    "engineVersion",
    "mode",
    "futureConstituentCount",
    "affectedRebalances",
    "sampleSymbols",
    "untradableTargets",
    "contaminatedSelectionRate",
    "corrected",
    "sourceRef",
    "assumptions",
  ],
  properties: {
    contractVersion: {
      type: "string",
      const: AUDIT_TOOL_CONTRACT_VERSION,
    },
    engineVersion: { type: "string", minLength: 1 },
    mode: {
      type: "string",
      enum: ["full_pit", "degraded_remove_only"],
    },
    futureConstituentCount: { type: "integer", minimum: 0 },
    affectedRebalances: NON_EMPTY_STRING_ARRAY_SCHEMA,
    sampleSymbols: NON_EMPTY_STRING_ARRAY_SCHEMA,
    untradableTargets: { type: "integer", minimum: 0 },
    contaminatedSelectionRate: { type: "number", minimum: 0, maximum: 1 },
    corrected: {
      type: "object",
      additionalProperties: false,
      required: ["annualReturn", "sharpe", "delta"],
      properties: {
        annualReturn: { type: "number" },
        sharpe: { type: "number" },
        delta: { type: "number" },
      },
    },
    sourceRef: { type: "string", const: AVAILABILITY_AUDIT_SOURCE_REF },
    assumptions: NON_EMPTY_STRING_ARRAY_SCHEMA,
  },
} as const;

export const RUN_REGIME_SPLIT_REQUEST_SCHEMA = {
  $id: "assay://schemas/run-regime-split-request-v1",
  type: "object",
  additionalProperties: false,
  required: ["kind", "spec", "budget"],
  properties: {
    kind: { type: "string", const: "regime_split" },
    spec: CANONICAL_SPEC_SCHEMA,
    budget: SINGLE_VARIANT_BUDGET_SCHEMA,
  },
} as const;

export const RUN_REGIME_SPLIT_RESPONSE_SCHEMA = {
  $id: "assay://schemas/run-regime-split-response-v1",
  type: "object",
  additionalProperties: false,
  required: [
    "contractVersion",
    "engineVersion",
    "kind",
    "mode",
    "environments",
    "dominantEnvironment",
    "sourceRef",
    "assumptions",
  ],
  properties: {
    contractVersion: {
      type: "string",
      const: AUDIT_TOOL_CONTRACT_VERSION,
    },
    engineVersion: { type: "string", minLength: 1 },
    kind: { type: "string", const: "regime_split" },
    mode: {
      type: "string",
      enum: ["index_daily", "constituent_proxy"],
    },
    environments: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "trend", "volatility", "days", "annualReturn", "sharpe", "pnlShare"],
        properties: {
          id: { type: "string", minLength: 1 },
          trend: { type: "string", enum: ["up", "down"] },
          volatility: { type: "string", enum: ["high", "normal"] },
          days: { type: "integer", minimum: 1 },
          annualReturn: { type: "number" },
          sharpe: FINITE_NUMBER_OR_NULL_SCHEMA,
          pnlShare: { type: "number" },
        },
      },
    },
    dominantEnvironment: {
      type: "object",
      additionalProperties: false,
      required: ["id", "pnlShare"],
      properties: {
        id: { type: "string", minLength: 1 },
        pnlShare: { type: "number" },
      },
    },
    sourceRef: { type: "string", const: REGIME_SPLIT_SOURCE_REF },
    assumptions: NON_EMPTY_STRING_ARRAY_SCHEMA,
  },
} as const;

export const RUN_HOMOGENEITY_REQUEST_SCHEMA = {
  $id: "assay://schemas/run-homogeneity-request-v1",
  type: "object",
  additionalProperties: false,
  required: ["kind", "spec", "budget"],
  properties: {
    kind: { type: "string", const: "homogeneity" },
    spec: CANONICAL_SPEC_SCHEMA,
    budget: SINGLE_VARIANT_BUDGET_SCHEMA,
  },
} as const;

export const RUN_HOMOGENEITY_RESPONSE_SCHEMA = {
  $id: "assay://schemas/run-homogeneity-response-v1",
  type: "object",
  additionalProperties: false,
  required: [
    "contractVersion",
    "engineVersion",
    "kind",
    "mode",
    "comparisons",
    "annualIc",
    "summary",
    "sourceRef",
    "assumptions",
  ],
  properties: {
    contractVersion: {
      type: "string",
      const: AUDIT_TOOL_CONTRACT_VERSION,
    },
    engineVersion: { type: "string", minLength: 1 },
    kind: { type: "string", const: "homogeneity" },
    mode: {
      type: "string",
      enum: ["full_factor_library", "classic_only"],
    },
    comparisons: {
      type: "array",
      minItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["comparator", "meanSpearman", "rebalanceObservations"],
        properties: {
          comparator: {
            type: "string",
            enum: HOMOGENEITY_COMPARATORS,
          },
          meanSpearman: FINITE_NUMBER_OR_NULL_SCHEMA,
          rebalanceObservations: { type: "integer", minimum: 0 },
        },
      },
    },
    annualIc: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["year", "observations", "pearsonIc", "rankIc"],
        properties: {
          year: { type: "string", pattern: "^[0-9]{4}$" },
          observations: { type: "integer", minimum: 0 },
          pearsonIc: FINITE_NUMBER_OR_NULL_SCHEMA,
          rankIc: FINITE_NUMBER_OR_NULL_SCHEMA,
        },
      },
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["nearestComparator", "maxAbsMeanSpearman", "yearsCovered", "rankIcSlope"],
      properties: {
        nearestComparator: {
          anyOf: [{ type: "string", enum: HOMOGENEITY_COMPARATORS }, { type: "null" }],
        },
        maxAbsMeanSpearman: FINITE_NUMBER_OR_NULL_SCHEMA,
        yearsCovered: {
          type: "integer",
          minimum: 0,
          description:
            "Complete calendar anniversaries between the first and last adjusted-close observations; independent of annualIc calendar buckets.",
        },
        rankIcSlope: FINITE_NUMBER_OR_NULL_SCHEMA,
      },
    },
    sourceRef: { type: "string", const: HOMOGENEITY_AUDIT_SOURCE_REF },
    assumptions: NON_EMPTY_STRING_ARRAY_SCHEMA,
  },
} as const;
