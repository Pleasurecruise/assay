# Audit Check Wiring

> Status: claim reproduction, all five checks, recovery mapping, and bounded
> Moiré wiring are implemented.

## Claim Reproduction

Claim reproduction is a host stage, not a sixth check. It runs after the
strategy and local package are frozen and before fan-out.

Convention:

- point-in-time evaluation universe;
- no transaction costs;
- the submitted execution convention;
- the same task-bound `dataRef` used by every check.

Output:

```ts
interface ClaimComparison {
  claimed: {
    annualReturn?: number;
    sharpe?: number;
    maxDrawdown?: number;
  };
  reproduced: {
    annualReturn: number;
    sharpe: number;
    maxDrawdown: number;
  };
  gaps: {
    annualReturn?: number;
    sharpe?: number;
    maxDrawdown?: number;
  };
  knownConventionDiffs: readonly string[];
}
```

An unexplained large claim gap caps the final verdict at `WATCH`. The host does
not alter any check conclusion.

## Data Availability

Tool: `run_availability_audit`.

The deterministic tool:

1. loads point-in-time index membership for each rebalance;
2. compares it with the submitted as-of universe;
3. measures affected selections and example symbols;
4. checks execution-date tradability;
5. reruns the corrected baseline;
6. returns annual return, Sharpe, and the correction delta.

Predeclared interpretation:

- no future constituents: pass;
- nonzero contamination with absolute annual-return change below two
  percentage points: pass with reservations;
- correction at least two percentage points or contaminated-selection rate at
  least 10%: fail.

## Parameter Robustness

Tool: `run_experiment` with the fixed parameter-grid budget.

The grid varies approved signal windows, top-N values, and bounded time
contexts. The check evaluates Sharpe retention and the share of variants that
remain acceptable. Daily returns are persisted for possible M1
post-processing.

## Cost Stress

Tool: `run_experiment` with the fixed cost ladder.

The ladder compares baseline, standard, and pessimistic costs. It reports
turnover erosion and whether the conclusion changes under the approved
transaction-cost assumptions.

## Regime Dependency

Tool: `run_experiment` with the fixed regime split.

The deterministic engine creates no-lookahead environment labels and returns
per-environment metrics plus dominant profit contribution. The model receives
only bounded scalar evidence.

## Homogeneity and Decay

Tool: `run_homogeneity`.

The tool computes:

- correlation with approved comparator factors;
- annual IC or RankIC;
- effective observation span;
- decay and sign stability.

The check fails when evidence crosses the frozen homogeneity or decay
thresholds defined by the contract.

## Recovery Conditions

The host maps failed checks to static recovery scopes:

| Check                 | Example recovery                                             |
| --------------------- | ------------------------------------------------------------ |
| Parameter robustness  | Narrow or regularize the unstable parameter region           |
| Data availability     | Rebuild with point-in-time membership and tradability        |
| Cost stress           | Reduce turnover or demonstrate a lower executable cost model |
| Regime dependency     | Add evidence across non-dominant environments                |
| Homogeneity and decay | Demonstrate incremental information and stable IC            |

Static recovery mapping determines whether a failed strategy is recoverable
(`QUARANTINE`) or lacks a credible recovery path (`RETIRE`).

## Hard Boundaries

- Every numerical value comes from a deterministic tool.
- The model cannot author `dataRef`, strategy bytes, evidence IDs, or check ID.
- Each check has one fixed tool-call budget.
- Branches cannot read sibling results.
- Missing local infrastructure fails the Task before fan-out.
- Moiré may schedule only M1 and M2.
