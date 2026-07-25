import { createHash } from "node:crypto";
import type { CanonicalStrategyDefinition } from "@assay/contracts";

export const STRATEGY_DATA_PLAN_SCHEMA_VERSION = "assay-local-data-plan-v1" as const;

export const LOCAL_DATA_REQUIREMENTS = [
  "trade_calendar",
  "pit_membership",
  "adjusted_close",
  "trade_status",
  "index_daily",
  "comparator_factors",
  "strategy_signal_factors",
] as const;

export type LocalDataRequirement = (typeof LOCAL_DATA_REQUIREMENTS)[number];

export interface DataPlan {
  readonly schemaVersion: typeof STRATEGY_DATA_PLAN_SCHEMA_VERSION;
  /**
   * SHA-256 over the canonical data identity. Performance claims and the
   * execution-only cost model cannot change package selection because neither
   * changes the immutable market inputs required by the strategy.
   */
  readonly strategyKey: `sha256-${string}`;
  readonly indexSymbol: string;
  readonly window: {
    readonly start: string;
    readonly end: string;
  };
  /**
   * Calendar coverage required from a local package. The package manifest may
   * satisfy unavailable auxiliary datasets through an explicitly validated V9
   * degradation, but it may never shorten this date range.
   */
  readonly requiredCoverage: {
    readonly start: string;
    readonly end: string;
  };
  readonly requirements: readonly LocalDataRequirement[];
}

export interface StrategyDataPlanner {
  plan(strategy: CanonicalStrategyDefinition): DataPlan;
}

function isoDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * Rebuild the canonical data identity in a fixed field order before hashing.
 * Costs are deliberately excluded: Claim Reproduction evaluates the same
 * frozen strategy with costs disabled, which must reuse the same market data.
 */
function canonicalStrategyJson(strategy: CanonicalStrategyDefinition): string {
  const signal =
    strategy.signal.kind === "library"
      ? {
          kind: "library" as const,
          name: strategy.signal.name,
        }
      : {
          kind: "template" as const,
          template: strategy.signal.template,
          params:
            strategy.signal.template === "volatility" ||
            strategy.signal.template === "turnover_rate"
              ? {
                  window: strategy.signal.params.window,
                  direction: strategy.signal.params.direction,
                }
              : {
                  window: strategy.signal.params.window,
                },
        };

  return JSON.stringify({
    specVersion: strategy.specVersion,
    universe: {
      index: strategy.universe.index,
    },
    signal,
    selection: {
      topN: strategy.selection.topN,
      weighting: strategy.selection.weighting,
    },
    rebalance: {
      frequency: strategy.rebalance.frequency,
      at: strategy.rebalance.at,
    },
    window: {
      start: strategy.window.start,
      end: strategy.window.end,
    },
  });
}

export function strategyDataKey(strategy: CanonicalStrategyDefinition): `sha256-${string}` {
  return `sha256-${createHash("sha256").update(canonicalStrategyJson(strategy), "utf8").digest("hex")}`;
}

function requirementsFor(strategy: CanonicalStrategyDefinition): readonly LocalDataRequirement[] {
  const requirements: LocalDataRequirement[] = [
    "trade_calendar",
    "pit_membership",
    "adjusted_close",
    "trade_status",
    "index_daily",
    "comparator_factors",
  ];
  if (
    strategy.signal.kind === "library" ||
    (strategy.signal.kind === "template" && strategy.signal.template === "turnover_rate")
  ) {
    requirements.push("strategy_signal_factors");
  }
  return requirements;
}

export class DeterministicStrategyDataPlanner implements StrategyDataPlanner {
  plan(strategy: CanonicalStrategyDefinition): DataPlan {
    return {
      schemaVersion: STRATEGY_DATA_PLAN_SCHEMA_VERSION,
      strategyKey: strategyDataKey(strategy),
      indexSymbol: strategy.universe.index,
      window: {
        start: strategy.window.start,
        end: strategy.window.end,
      },
      requiredCoverage: {
        start: isoDate(strategy.window.start),
        end: isoDate(strategy.window.end),
      },
      requirements: requirementsFor(strategy),
    };
  }
}
