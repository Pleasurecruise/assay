# Moiré Protocol Specification

> Status: M1 and M2 planning, execution, validation, and synthesis are
> implemented. M3 is not implemented and is not part of the runtime budget.

## Purpose

The five audit checks are independent. Moiré runs only after that phase and
tests a bounded set of predeclared contradictions. It does not allow open-ended
Agent debate or model-invented experiments.

## Implemented Contradictions

### M1: Parameter Robustness and Regime Concentration

Trigger:

- parameter robustness failed;
- retention outside the dominant environment is below 40%;
- the dominant environment contributes at least 70% of profit;
- regime dependency did not already fail.

Experiment:

- reuse persisted parameter-grid daily returns;
- split each variant by the frozen regime labels;
- recompute retention by environment;
- do not rerun the backtest.

Synthesis:

- dominant-environment retention at least 70% and every other environment
  below 40% identifies environment-localized parameter fragility;
- otherwise the original parameter conclusion remains unchanged;
- host synthesis records the refinement without rewriting Agent-authored
  evidence.

### M2: Point-in-Time Correction and Cost Stress

Trigger:

- data availability failed;
- the absolute annual-return correction is at least two percentage points;
- cost stress used the uncorrected baseline;
- the original cost conclusion is conclusive.

Experiment:

- rerun the fixed cost ladder once on the point-in-time-corrected panel.

Synthesis:

- if the corrected cost tier changes, the Artifact records the corrected tier
  as the host refinement;
- if the tier is unchanged, the Artifact records robustness to the membership
  correction;
- the original independent check output remains preserved.

## Fixed Experiment Templates

| ID  | Template                | Execution                     |
| --- | ----------------------- | ----------------------------- |
| M1  | `regime_slice_of_grid`  | Deterministic post-processing |
| M2  | `corrected_cost_ladder` | One Python experiment call    |

No third template may be scheduled by the current planner.

## Budget

- maximum experiments: two;
- order: M1, then M2;
- each experiment uses the same frozen strategy hash and task-bound `dataRef`;
- duplicate canonical evidence fails closed;
- an experiment failure is recorded as unresolved and cannot fabricate a
  refinement.

## Deterministic Boundary

The host owns:

- trigger evaluation;
- template selection;
- experiment identity;
- input binding;
- result validation;
- refinement synthesis;
- final verdict policy.

The model may explain an already-validated result. It may not create a new
experiment, alter a threshold, choose another data package, or overwrite a
sibling conclusion.

## Data Requirements

M1 requires persisted grid daily-return artifacts and frozen regime labels.
M2 requires the point-in-time-corrected package context. Both use
`ASSAY_AUDIT_OUTPUT_ROOT` for task-scoped derived output and never modify the
immutable source package.
