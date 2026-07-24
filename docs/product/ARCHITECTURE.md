# System Architecture

> Status: evolving with the implementation. This document defines the system
> components, their responsibilities, and dependency boundaries. See
> [PIPELINE.md](PIPELINE.md) for request flow and time budgets.

## 1. System Overview

```text
┌─────────────────────────────────────────────────────────┐
│                       A2A Server                        │
│        Agent Card · task lifecycle · Artifact output   │
└──────────────────────────┬──────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │      Intake     │
                  │ parse · plan · budget
                  └────────┬────────┘
                           │
       ┌──────────┬────────┼────────┬──────────┐
┌──────▼─────┐ ┌──▼─────┐ ┌▼────────┐ ┌▼────────┐ ┌▼────────────┐
│ Parameter  │ │ Data   │ │ Cost    │ │ Regime  │ │ Homogeneity │
│ robustness │ │ access │ │ stress  │ │ depend. │ │ and decay   │
└──────┬─────┘ └──┬─────┘ └┬────────┘ └┬────────┘ └┬────────────┘
       └──────────┴─────────┴──────┬────┴───────────┘
                                   │ five independent results
                          ┌────────▼────────┐
                          │ Moiré validation│
                          │ disputes · experiments
                          └────────┬────────┘
                          ┌────────▼────────┐
                          │      Report     │
                          │ verdict · evidence · Artifact
                          └─────────────────┘

       ┌────────────────┐          ┌────────────────┐
       │   Backtester   │          │   Data Layer   │
       │ vectorized     │          │ PandaData API  │
       └────────────────┘          │ cache · retry  │
                                   └────────────────┘
```

The A2A server exposes Assay as one remote agent. The five checks are internal
oh-my-pi agents and are not separately discoverable A2A services.

## 2. Component Responsibilities

### A2A Server

- Publishes an Agent Card whose baseline lists only `audit_strategy`;
  `audit_factor` and `compare_robustness` join the Card by configuration once
  their full paths pass tests (A2A_SERVER.md §22).
- The implemented Skeleton accepts natural-language text and maps one audit to
  one A2A Task. Structured `StrategySpec` input and multi-turn
  `INPUT_REQUIRED` clarification before the spec freezes are Baseline work
  (A2A_SERVER.md §10.4 and §24.1).
- Publishes progress as task status updates and returns final output as
  Artifacts with structured data Parts. Messages are not used as the reliable
  result channel.
- Treats A2A task persistence as a gateway concern. The Skeleton uses
  in-memory Artifact storage; durable Task and clarification state arrive in
  Baseline. An audit run never depends on other Tasks' history, and execution
  receives only the frozen spec.
- Cancellation propagation into the runtime `AbortSignal` is Baseline work.

The Skeleton gateway is implemented with the official A2A JavaScript SDK
`AgentExecutor` and execution event bus rather than a custom task protocol.

### Intake

- The implemented Skeleton parses natural-language strategy input, validates a
  typed `StrategySpec`, applies declared defaults, and freezes canonical bytes
  plus provenance before execution.
- Factor expressions, structured input, clarification, capability probes, and
  the fixed budget-plan builder remain later-phase work.

### Five Checks

Each check is an isolated oh-my-pi Agent with one responsibility:

| Agent ID            | Responsibility                                                  | Infrastructure          |
| ------------------- | --------------------------------------------------------------- | ----------------------- |
| `param-robustness`  | Parameter-neighborhood perturbation and time-window shifts      | Backtester              |
| `data-availability` | Point-in-time universe, tradability, and financial-data checks  | Data Layer              |
| `cost-stress`       | Tiered transaction costs, turnover erosion, and break-even cost | Backtester              |
| `regime-dependency` | Point-in-time regime classification and per-regime statistics   | Backtester + Data Layer |
| `homogeneity-decay` | Factor-library correlation and annual IC/RankIC decay           | Data Layer              |

Every applicable check returns:

```ts
interface AuditCheckResult {
  id: AuditCheckId;
  conclusion:
    "pass" | "pass_with_reservations" | "fail" | "insufficient_evidence" | "not_applicable";
  confidence: number | null;
  evidence: readonly CheckEvidence[];
  missingEvidence: readonly MissingEvidence[];
}
```

The contract and runtime validator are implemented in
`packages/contracts/src/audit-checks.ts`.

### Main-Agent Boundary and Parallel Fan-Out

The Main Agent or host orchestrator calls one stable interface:

```ts
const checks = await new ParallelAuditCheckRunner(runtime).run({
  schemaVersion: "1.0.0",
  auditId,
  skill: "audit_strategy",
  subject: {
    id: subjectId,
    kind: "strategy",
    input: normalizedStrategy,
  },
  budgets,
});
```

`ParallelAuditCheckRunner` starts all applicable branches with `Promise.all`.
Each branch receives an `AuditCheckAgentRequest` containing only the shared
subject and its own `checkId` and budget. It never receives sibling results.
The returned `ParallelAuditChecksResult` always lists the five canonical IDs
in a stable order.

Branch isolation rules:

- `AgentRuntime.run` creates a fresh oh-my-pi `Agent` for every branch.
- No message history or mutable Agent state is shared across requests.
- A branch cannot impersonate another branch: returned JSON is validated
  against the expected Agent ID.
- Invalid JSON, runtime errors, and branch timeouts become
  `insufficient_evidence` for that branch without discarding successful
  siblings.
- Caller cancellation is different from branch failure: it aborts the whole
  fan-out and is propagated instead of being converted into evidence.
- Factor audits without a tradable portfolio construction do not dispatch
  `cost-stress`; the stable five-result response marks it `not_applicable`.

### Moiré Cross-Validation

- Reads the five structured results only after the independent phase ends.
- Detects material disagreements and designs at most two discriminating
  follow-up experiments.
- Dispatches follow-ups to the relevant check agents, then refines affected
  results.
- Marks unresolved, verdict-changing disputes as insufficient evidence.

Moiré orchestration is not implemented yet.

### Backtester

- Uses adjusted daily data and vectorized pandas operations.
- Supports parameterized rebalance rules, cost tiers, regime slices, and
  point-in-time universes.
- Exists because the platform backtest skill has no verified structured-output
  contract.

### Data Layer

- Wraps PandaData authentication and query APIs.
- Shares immutable query results through cache keys while keeping Agent state
  isolated.
- Applies bounded concurrency, retry limits, exponential backoff, and explicit
  missing-evidence errors.

### Report

- Produces a human-readable Markdown report.
- Produces the equivalent versioned JSON audit object for an A2A Artifact.
- Computes the verdict deterministically; the language model does not grade
  the strategy.

## 3. Runtime Mapping to oh-my-pi

Assay composes the pinned `@oh-my-pi/pi-agent-core` package instead of
reimplementing an agent loop:

| oh-my-pi capability             | Assay use                                    |
| ------------------------------- | -------------------------------------------- |
| Fresh `Agent({ initialState })` | Per-check request isolation                  |
| `agent.prompt()`                | One self-contained check invocation          |
| `agent.subscribe()`             | Runtime and tool lifecycle events            |
| `beforeToolCall`                | `read` / `write` / `exec` policy enforcement |
| `agent.abort(reason)`           | Branch deadline and A2A cancellation         |
| Structured tool definitions     | Future Backtester and Data Layer tools       |

The parallel runner lives above `AgentRuntime`. It does not share a single
stateful Agent across checks and does not use steering or follow-up queues for
cross-agent communication.

## 4. Dependency Principles

- Check agents have zero dependencies on one another.
- Check agents depend only on the Backtester and Data Layer tool surfaces.
- Shared data caching may deduplicate immutable reads, but cached values do not
  expose sibling conclusions or conversations.
- LLMs parse tasks, design Moiré experiments, and write reports. Numerical
  evidence comes from tools and deterministic calculations.
- Public A2A contracts, internal check contracts, and provider-specific model
  configuration remain separate layers.

## 5. Repository Mapping

| Product component              | Repository location                            | Status      |
| ------------------------------ | ---------------------------------------------- | ----------- |
| A2A Server                     | future gateway package using `@a2a-js/sdk`     | Planned     |
| Intake                         | `packages/agents`                              | Planned     |
| Five check definitions         | `packages/agents/src/definitions.ts`           | Implemented |
| Parallel Main-Agent interface  | `packages/agents/src/parallel-check-runner.ts` | Implemented |
| Check protocol and validator   | `packages/contracts/src/audit-checks.ts`       | Implemented |
| Moiré orchestrator             | `packages/agents`                              | Planned     |
| Report and full audit Artifact | `packages/agents` + `packages/contracts`       | Planned     |
| Backtester                     | future Python service                          | Planned     |
| Data Layer                     | `services/panda-adapter` + future TS tools     | Partial     |

See [RUNTIME.md](../architecture/RUNTIME.md) for runtime mechanics,
[PIPELINE.md](PIPELINE.md) for budgets and degradation, and
[VERDICT_SPEC.md](VERDICT_SPEC.md) for the final Artifact.

## 6. Stable Agent IDs

| Role                     | Agent ID             |
| ------------------------ | -------------------- |
| Intake                   | `intake`             |
| Parameter robustness     | `param-robustness`   |
| Data availability        | `data-availability`  |
| Transaction-cost stress  | `cost-stress`        |
| Market-regime dependency | `regime-dependency`  |
| Homogeneity and decay    | `homogeneity-decay`  |
| Cross-validation         | `moire-orchestrator` |

Agent IDs use kebab-case. Public A2A skill IDs remain snake_case.
