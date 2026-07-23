# Audit Check Specification

> This document defines the five independent checks and Moiré
> cross-validation. See [VERDICT_SPEC.md](VERDICT_SPEC.md) for result fields,
> [DATA_NOTES.md](DATA_NOTES.md) for verified data capabilities, and
> [ARCHITECTURE.md](ARCHITECTURE.md) for code placement.

## 1. Skill Profiles

| Skill                | Required checks                                                                          | Conditional checks                                           |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `audit_strategy`     | All five checks                                                                          | None                                                         |
| `audit_factor`       | Parameter robustness, data availability, regime dependency, homogeneity and decay        | Cost stress only when the input defines a tradable portfolio |
| `compare_robustness` | Run the matching profile for every same-kind subject, then compare verdicts and evidence | Mixed strategy and factor inputs return `UNVERIFIABLE`       |

Every result still lists all five canonical check IDs. Checks outside the
active profile use `not_applicable`.

## 2. Check Definitions

| Check                  | Question                                                                    | Evidence source                                                                        | Feasibility                                        |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Parameter robustness   | Does performance survive nearby parameters and shifted sample windows?      | Vectorized Backtester, `get_market_data`, `get_adj_factor`                             | Feasible                                           |
| Data availability      | Was every input actually available at each historical decision time?        | Historical index weights, trade lists, status changes, and financial disclosure timing | Feasible with a quarterly-report timing limitation |
| Cost stress            | What remains after realistic fees and impact, and where is break-even cost? | Backtester cost tiers and measured turnover                                            | Feasible                                           |
| Regime dependency      | Is performance broad or concentrated in one market environment?             | Point-in-time trend, volatility, and style regimes                                     | Feasible                                           |
| Homogeneity and decay  | Is the signal incremental, or crowded and decaying?                         | Platform factor library, correlation, annual IC/RankIC                                 | Feasible                                           |
| Moiré cross-validation | What finer structure explains material disagreement between checks?         | Orchestration and at most two follow-up experiments                                    | Feasible                                           |

### Parameter Robustness

- Build a predeclared neighborhood around every material parameter.
- Shift the sample start and end dates without selecting the best window.
- Report original performance, neighborhood distribution, retention ratios,
  and completed variant count.
- Fail only on reproducible sensitivity, not on model intuition.

### Data Availability

- Reconstruct the point-in-time universe for every rebalance.
- Check tradability and status changes on the decision date.
- Use actual `info_date` for forecasts and performance bulletins.
- Until a verified quarterly-report announcement field exists, use the
  statutory-deadline heuristic and declare the limitation.

### Transaction-Cost Stress

- Measure annual turnover from generated holdings.
- Re-run no-cost, baseline, impact-adjusted, and pessimistic tiers.
- Estimate the cost multiplier or rate at which expected return reaches zero.
- A factor without portfolio construction is `not_applicable`, not `pass`.

### Market-Regime Dependency

- Define regimes only with information available at the time.
- Slice by trend, volatility, and relevant style dimensions.
- Report observations and performance in every regime.
- Identify concentration without converting correlation into causation.

### Homogeneity and Decay

- Compare the signal with the platform factor library.
- Compute annual IC and RankIC on consistent universes and horizons.
- Report trend and uncertainty, not only first-versus-last values.
- Separate high similarity from measured decay; they are related hypotheses,
  not the same conclusion.

## 3. Execution Contract

```text
Input strategy or factor
  ↓
Intake fixes subject, data requirements, variant counts, and budgets
  ↓
Applicable checks run concurrently and cannot communicate
  ↓
Each returns { id, conclusion, confidence, evidence, missingEvidence }
  ↓
Moiré detects material disputes and may request at most two follow-ups
  ↓
Deterministic rules produce verdict, recovery conditions, and Artifacts
```

The check-agent response is untrusted JSON. The host validates:

- the expected Agent ID;
- conclusion and confidence domains;
- reproducible evidence for `pass`, `pass_with_reservations`, and `fail`;
- an explicit missing-evidence explanation for `insufficient_evidence`;
- null confidence and empty evidence for `not_applicable`.

## 4. Worked Example

Input:

> Within the CSI 300, buy the 50 stocks with the highest trailing 20-day
> return at each month-end, equal weight them for one month, and assess a
> claimed 2021-2025 annual return of 18% with Sharpe 1.9.

Expected check behavior:

1. **Parameter robustness:** test momentum windows 14/17/20/23/26, holdings
   30-70, and sample shifts. If nearby Sharpe averages only 35% of the
   original, return a reproducible failure.
2. **Data availability:** reconstruct historical CSI 300 membership. If 37
   future constituents were used and correction changes annual return from
   18% to 13.8%, fail with the affected dates and symbols.
3. **Cost stress:** if annual turnover is 12 times and performance falls from
   13.8% to 9.8% with impact, return a reserved pass with the full cost curve.
4. **Regime dependency:** if gains occur only in roughly 40% of trending
   months while flat and down regimes lose money, return a reserved pass.
5. **Homogeneity and decay:** if correlation with standard momentum is 0.93
   and IC declines from 0.05 to 0.018, fail with factor and yearly references.

Suppose parameter robustness fails overall while the regime check finds
stable trending-market performance. Moiré requests one discriminating
experiment: rerun the parameter neighborhood inside each predeclared regime.
If the result is robust in trends and unstable in flat markets, it refines the
finding to "parameter fragility is concentrated in flat regimes." This is an
experiment-backed synthesis, not a vote.

A plausible final verdict is `QUARANTINE`, with recovery conditions to use
point-in-time constituents, reduce turnover, add a flat-regime control, and
demonstrate incremental signal beyond standard momentum.
