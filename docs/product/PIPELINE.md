# Audit Pipeline

> Status: implemented for `audit_strategy`.
>
> See [CURRENT_STATE.md](../CURRENT_STATE.md) and
> [ARCHITECTURE.md](ARCHITECTURE.md).

## End-to-End Sequence

```text
Natural-language A2A request
  -> Ark parsing
  -> StrategySpec validation and freeze
  -> claims-free LocalDataPlan
  -> immutable local package resolution
  -> claim reproduction
  -> five checks in parallel
  -> bounded Moiré M1/M2
  -> deterministic verdict
  -> JSON and Markdown Artifact
```

The audit hard limit remains below the competition's 20-minute response limit.
Check deadlines are capped and run concurrently; follow-up work is bounded
rather than extended until the clock expires.

## Data Flow

The local resolver runs after intake and before any numerical audit:

```text
Frozen StrategySpec
  -> strategyForData
  -> DeterministicStrategyDataPlanner
  -> LocalDataPackageResolver
  -> one verified dataRef
```

Claims and cost assumptions do not affect market-package identity. Claim
reproduction, all checks, and Moiré receive the same host-bound `dataRef`.

No valid package means no numerical audit. The Task fails before fan-out and
the runtime does not fetch PandaData online.

## Independent Checks

Applicable checks start together:

```text
param-robustness  ─┐
data-availability ─┤
cost-stress ───────┼─> canonical five-result set
regime-dependency ─┤
homogeneity-decay ─┘
```

Branches cannot see sibling messages or conclusions. Each check has a fixed
tool and call budget. A branch-level failure becomes
`insufficient_evidence`; successful siblings remain available.

## Moiré

After independent checks complete, the deterministic planner may schedule:

- M1 for parameter robustness versus regime concentration;
- M2 for point-in-time availability correction versus cost sensitivity.

No M3 or unbounded Agent debate is implemented. Unresolved verdict-changing
disputes reduce the strength of the final conclusion.

## A2A Mapping

One external Task owns the entire pipeline. Status updates expose safe stage
progress. The final structured and Markdown Parts are published as one
Artifact only after validation and persistence.

Terminal states:

- `COMPLETED` for a validated audit or supported business early exit;
- `FAILED` for missing local infrastructure, Ark failure, invalid internal
  state, or Artifact failure;
- `CANCELED` for caller cancellation.

## Failure Semantics

| Condition                          | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| Input missing or unsupported       | `UNVERIFIABLE` Artifact, Task `COMPLETED`  |
| Registry absent or invalid         | No Artifact, Task `FAILED`                 |
| Package checksum or path invalid   | No Artifact, Task `FAILED`                 |
| One branch fails                   | That check becomes `insufficient_evidence` |
| Caller cancels                     | All live work aborts, Task `CANCELED`      |
| Artifact cannot persist or publish | Task `FAILED`                              |

Infrastructure failure and business unverifiability are deliberately
different outcomes.
