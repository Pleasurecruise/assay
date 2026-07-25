import {
  CLAIM_ANNUAL_RETURN_GAP_THRESHOLD,
  CLAIM_SHARPE_OVERSTATEMENT_MULTIPLIER,
  toCanonicalStrategySpec,
  type CanonicalStrategySpec,
  type ClaimComparison,
  type ClaimMetrics,
} from "@assay/contracts";
import {
  defaultExperimentProcessConfig,
  runExperimentSubprocess,
  type ExperimentProcessConfig,
} from "@assay/agents";

export interface ClaimReproducer {
  reproduce(spec: CanonicalStrategySpec, dataRef: string): Promise<ClaimComparison | null>;
}

function gap(claimed: ClaimMetrics, reproduced: ClaimComparison["reproduced"]): ClaimMetrics {
  return {
    ...(claimed.annualReturn === undefined
      ? {}
      : { annualReturn: claimed.annualReturn - reproduced.annualReturn }),
    ...(claimed.sharpe === undefined ? {} : { sharpe: claimed.sharpe - reproduced.sharpe }),
    ...(claimed.maxDrawdown === undefined
      ? {}
      : { maxDrawdown: claimed.maxDrawdown - reproduced.maxDrawdown }),
  };
}

export class SubprocessClaimReproducer implements ClaimReproducer {
  readonly #process: ExperimentProcessConfig;

  constructor(process: ExperimentProcessConfig = defaultExperimentProcessConfig()) {
    this.#process = process;
  }

  async reproduce(spec: CanonicalStrategySpec, dataRef: string): Promise<ClaimComparison | null> {
    if (spec.claims === undefined) {
      return null;
    }
    const reproductionSpec = toCanonicalStrategySpec({
      ...spec,
      costs: { model: "none" },
    });
    const result = await runExperimentSubprocess(this.#process, {
      kind: "baseline",
      spec: reproductionSpec,
      dataRef,
      universeMode: "asOf",
      budget: { maxVariants: 1 },
    });
    const reproduced = {
      annualReturn: result.baseline.annualReturn,
      sharpe: result.baseline.sharpe,
      maxDrawdown: result.baseline.maxDrawdown,
    };
    return {
      claimed: spec.claims,
      reproduced,
      gaps: gap(spec.claims, reproduced),
      // No ClaimProfile was supplied by the current natural-language input,
      // so there is no disclosed convention difference that can explain a gap.
      knownConventionDiffs: [],
    };
  }
}

export function claimComparisonTriggersWatchCap(comparison: ClaimComparison | null): boolean {
  if (comparison === null || comparison.knownConventionDiffs.length > 0) {
    return false;
  }
  const sharpeOverstated =
    comparison.claimed.sharpe !== undefined &&
    comparison.claimed.sharpe >
      comparison.reproduced.sharpe * CLAIM_SHARPE_OVERSTATEMENT_MULTIPLIER;
  const annualReturnOverstated =
    comparison.gaps.annualReturn !== undefined &&
    comparison.gaps.annualReturn >= CLAIM_ANNUAL_RETURN_GAP_THRESHOLD;
  return sharpeOverstated || annualReturnOverstated;
}
