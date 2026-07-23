# Audit Pipeline

> Status: evolving with the implementation. This document defines request
> flow, budgets, and degradation. See [ARCHITECTURE.md](ARCHITECTURE.md) for
> component boundaries.

## 1. End-to-End Sequence

The competition limit is 20 minutes. The runtime hard limit is 19 minutes,
with an 18-minute operating budget:

| Stage       | Budget   | Work                                              | Parallelism                    |
| ----------- | -------- | ------------------------------------------------- | ------------------------------ |
| Intake      | 1 min    | Parse subject, fix plan, allocate variants        | Sequential                     |
| Five checks | 9-10 min | Fetch data, run variants, emit structured results | Up to five branches            |
| Moiré       | 2-3 min  | Detect disputes and run at most two follow-ups    | Follow-ups may run in parallel |
| Report      | 2 min    | Verdict, evidence pack, and JSON Artifact         | Sequential                     |
| Reserve     | 2 min    | Network jitter and bounded retries                | —                              |

Variant counts are fixed during Intake. The runtime does not keep adding work
until the clock runs out.

## 2. Data Flow

```text
Natural-language request
  │
  ▼
Intake → CheckPlan { subject, variant budgets, data requirements }
  │
  ├─→ param-robustness ──┐
  ├─→ data-availability ─┤
  ├─→ cost-stress ───────┼─→ AuditCheckResult × 5
  ├─→ regime-dependency ─┤
  └─→ homogeneity-decay ─┘
  │
  ▼
Moiré → disputes → discriminating experiments → refined results
  │
  ▼
Deterministic verdict + report
  ├─→ Markdown Artifact Part
  └─→ structured JSON Artifact Part
```

The implemented fan-out boundary accepts `ParallelAuditChecksRequest` and
returns `ParallelAuditChecksResult`. It starts all applicable checks together
and preserves canonical result ordering.

## 3. Control Points

- During the independent phase, branches cannot see sibling results.
- Every branch gets a fresh oh-my-pi Agent instance.
- A shared `traceId` correlates the batch; each branch has its own task ID.
- Runtime and tool events may stream internally, but the final check result is
  accepted only after JSON contract validation.
- One branch failure becomes `insufficient_evidence`; it does not reject the
  complete batch.
- Caller cancellation aborts all live branches.
- Immutable data queries may share a cache. Agent messages and conclusions may
  not.
- Data rate limits are handled with bounded concurrency, caching, and finite
  exponential backoff.

## 4. A2A Mapping

One external A2A Task represents one complete audit, not one internal check.

1. The gateway creates or acknowledges a Task.
2. Intake and fan-out progress are published as status updates.
3. Cancellation is propagated to the fan-out `AbortSignal`.
4. Final machine-readable and human-readable results are published as
   Artifacts.
5. The Task enters a terminal state only after Artifact publication succeeds
   or the audit fails or is canceled.

The A2A specification distinguishes interaction Messages from task outputs.
Assay therefore does not rely on Message history as the result store.

## 5. Degradation

When quota or time becomes tight, reduce scale in this order:

1. Variant count, for example 30 to 15.
2. Historical window, for example five years to three.
3. Chart count while retaining numeric tables.

Never remove:

- a required check from the active skill profile;
- Moiré dispute detection;
- the `UNVERIFIABLE` refusal path;
- assumptions, limitations, and risk disclosure.

Moiré follow-ups may fall from two to one. At the 16-minute cutover, follow-ups
that have not started may be skipped, but unresolved disputes must remain
visible and confidence must be reduced.

## 6. Failure Semantics

| Condition                                            | Result                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Subject cannot be parsed                             | `UNVERIFIABLE` with required input fields                                                                 |
| One data API remains unavailable                     | Affected check is `insufficient_evidence`; siblings continue                                              |
| One check times out after partial variants           | Return partial evidence with reduced confidence when valid                                                |
| One check returns invalid JSON or the wrong Agent ID | Affected check is `insufficient_evidence`                                                                 |
| Caller cancels the audit                             | Abort all branches; do not disguise cancellation as missing evidence                                      |
| Clock reaches the report cutover                     | Skip unstarted follow-ups and report unresolved disputes                                                  |
| Identical request is submitted again                 | Reuse only when normalized input, profile, data date/version, code revision, and schema version all match |
