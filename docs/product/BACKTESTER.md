# Deterministic Backtester

> Status: implemented Python engine used by claim reproduction, audit checks,
> and Moiré experiments.
>
> See [STRATEGY_SPEC.md](STRATEGY_SPEC.md),
> [CHECKS.md](CHECKS.md), and
> [DATA_ACCESS.md](../architecture/DATA_ACCESS.md).

## Purpose

The backtester is internal infrastructure. A2A clients see only validated
evidence and Artifacts.

It exists to:

- provide a stable structured contract independent of an external backtest
  skill;
- keep numerical evidence deterministic and outside model generation;
- run bounded counterfactual grids within the competition time limit;
- reproduce both Assay's preferred convention and disclosed caller
  conventions.

## Fixed Decisions

### Execution Timing

Default execution is `next_close`:

1. compute the signal using data through rebalance-day close;
2. execute at the next trading-day close;
3. begin portfolio returns after that execution.

`same_close` exists only to reproduce a submitted convention and must be
disclosed as a zero-delay assumption.

### Price and Membership Data

The engine uses the package's adjusted-close panel and point-in-time universe.
Every variant in one audit shares the same immutable panel. Signal windows are
computed from that panel rather than fetched per variant.

### Tradability

Execution respects the package's frozen trade-status policy. An unavailable
target cannot be silently treated as filled. The engine records the approved
handling and exposes affected selections to the availability check.

### Tool Granularity

Agents receive coarse experiment tools, not row-level market APIs:

- baseline reproduction;
- parameter grid;
- cost ladder;
- regime split;
- availability correction;
- homogeneity calculation.

Each tool has one fixed schema and bounded call budget.

### Service Boundary

The engine runs inside `services/panda-adapter` because package loading,
DataFrame construction, and vectorized calculations belong in the same Python
boundary. TypeScript sends one JSON request and receives one bounded JSON
response over stdio.

Production launches modules through:

```text
uv run --project services/panda-adapter python -m <module>
```

### Artifact Storage

Large daily-return arrays are not returned to the model. The engine writes
content-addressed derived artifacts under `ASSAY_AUDIT_OUTPUT_ROOT` and returns
stable source references plus bounded scalar summaries.

Derived output is scoped by audit `dataRef` and never mutates the immutable
source package.

## Experiment Contract

The host-only request includes:

```ts
interface RunExperimentRequest {
  kind: "baseline" | "grid" | "cost_ladder" | "regime_split";
  dataRef: string;
  spec: CanonicalStrategySpec;
  universeMode?: "asOf";
  grid?: {
    signalParams: {
      window: readonly number[];
    };
    topN: readonly number[];
  };
  budget: {
    maxVariants: number;
  };
}
```

The model supplies only the allowed experiment kind and fixed budget shape.
Runtime guards replace `spec` and `dataRef` with host-frozen values.

Each result contains:

- baseline parameters and metrics;
- bounded variant summaries;
- annual return;
- Sharpe;
- maximum drawdown;
- annual turnover;
- engine version;
- source references for persisted details.

Non-finite values, missing metrics, extra fields, invalid source references,
and over-budget grids are rejected.

## Calculation Semantics

### Returns

Daily portfolio return is the weighted sum of constituent adjusted-price
returns after execution timing and tradability rules are applied.

### Annual Return

Annualized return uses compounded daily returns and the fixed trading-day
annualization convention.

### Sharpe

Sharpe uses annualized mean excess return divided by annualized daily-return
volatility. The current engine uses the frozen zero risk-free-rate convention
unless a future schema explicitly adds another assumption.

### Maximum Drawdown

Maximum drawdown is computed from the compounded equity curve relative to its
running maximum.

### Turnover and Costs

One-way turnover is derived from target-weight changes. Transaction cost is
applied from turnover using the selected fixed cost tier. Cost-ladder variants
reuse the same holdings path.

### Rebalancing

Weekly and monthly schedules use the package trading calendar. Signal lookback
must be complete before a security is eligible.

### Missing Data

The engine does not forward-fill evidence across an undeclared gap. Package
manifests declare any authorized degradation. An unexpected missing input
fails the experiment.

## Predeclared Check Criteria

### Parameter Robustness

The grid is fixed before evidence is observed. The check uses retention across
approved signal-window, top-N, and time-context variants. Thresholds are
defined by contracts and tests, not tuned after a real run.

### Cost Stress

The fixed ladder compares approved cost tiers. The check evaluates whether
returns and conclusion tier survive pessimistic executable costs.

### Regime Dependency

No-lookahead labels divide returns into frozen environments. The engine reports
per-environment metrics and dominant profit contribution.

### Availability

Point-in-time membership correction reruns the baseline and reports the
annual-return delta and contaminated-selection rate.

### Homogeneity

The engine calculates comparator correlation and annual IC or RankIC over the
package's approved factor data.

## Known-Answer Tests

Engine tests include:

- constant-price zero-return panels;
- monotonic-price panels with hand-computable returns;
- rebalance timing and next-close execution;
- transaction-cost deductions;
- missing and untradable targets;
- point-in-time membership changes;
- parameter-grid cardinality;
- regime split aggregation;
- content-addressed artifact identity;
- malformed request and response rejection.

Synthetic fixtures validate mechanics only. They are never presented as real
market evidence.

## Reproducing Submitted Errors

Audit credibility sometimes requires reproducing a disclosed weaker
convention, such as as-of membership or same-close execution. These modes are
explicit inputs and remain separate from Assay's corrected convention.

The Artifact records:

- submitted convention;
- corrected convention;
- metric difference;
- known limitations.

The host never changes an Agent conclusion merely to match the reproduced
claim.

## Performance Boundary

The engine loads one package panel and reuses it across variants. Parameter
grids and cost ladders are bounded by contract. Large intermediate arrays stay
in Python or content-addressed storage; only bounded summaries cross into
Agent context.
