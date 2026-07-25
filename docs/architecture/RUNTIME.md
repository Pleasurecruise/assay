# Agent Runtime Architecture

> Status: implemented for `audit_strategy`.
>
> See [CURRENT_STATE.md](../CURRENT_STATE.md) for deployment readiness and
> remaining work.

## Layering

```text
A2A gateway
  -> AssayAgentExecutor
     -> Ark natural-language intake
     -> deterministic StrategySpec freeze
     -> deterministic local data resolution
     -> claim reproduction
     -> ParallelAuditCheckRunner
        -> AgentRuntime.run(param-robustness)
        -> AgentRuntime.run(data-availability)
        -> AgentRuntime.run(cost-stress)
        -> AgentRuntime.run(regime-dependency)
        -> AgentRuntime.run(homogeneity-decay)
     -> bounded Moiré M1/M2 experiments
     -> deterministic verdict and Artifact
```

The A2A gateway owns remote Task lifecycle. `AssayAgentExecutor` owns stage
ordering and host-only data binding. `AgentRuntime` owns one isolated
oh-my-pi invocation. `ParallelAuditCheckRunner` owns internal fan-out and
result validation.

## Isolation

Every check creates a fresh `@oh-my-pi/pi-agent-core` Agent. Checks may share
only immutable host data:

- frozen strategy bytes and hash;
- audit, subject, and trace identifiers;
- one task-bound `dataRef`;
- model configuration and fixed tool definitions.

They never share conversation history, partial conclusions, pending tool
calls, or mutable Agent state. Sibling results become visible only after the
independent phase completes.

## Host-Controlled Tools

Runtime tools are coarse deterministic operations:

- `run_experiment`;
- `run_availability_audit`;
- `run_homogeneity`;
- structured result submission.

The host overwrites model-controlled strategy and `dataRef` arguments with the
trusted frozen values. Each check may call only its assigned experiment once.
Tool arguments and results are omitted from lifecycle telemetry.

Tools declare `read`, `write`, or `exec`. Undeclared tools are treated as
`exec`; `write` and `exec` require explicit host approval.

## Fan-Out, Failure, and Cancellation

Applicable checks start concurrently. A branch runtime error, invalid result,
or deadline becomes `insufficient_evidence` for that branch without discarding
successful siblings.

Caller cancellation is different: the same `AbortSignal` reaches every live
Agent and Python subprocess. The A2A Task becomes `CANCELED`; cancellation is
never converted into missing evidence.

A missing or invalid local package fails before fan-out. It is an
infrastructure failure, so the A2A Task becomes `FAILED` and no audit Artifact
is published.

## Moiré and Verdict

The runner plans only the implemented discriminating experiments:

- M1 for parameter robustness versus regime concentration;
- M2 for point-in-time availability correction versus cost sensitivity.

The host validates experiment identity and synthesizes refinements without
allowing one check Agent to rewrite another check's output. Final verdict
selection is deterministic.

## Events and Sensitive Data

Runtime events include stage, Agent, and tool timings. Prompts, tool arguments,
tool results, provider credentials, and raw exceptions are not persisted by
default. Public failures contain a correlation ID and safe stage name while
internal logs retain only the error type and redacted details.

## Deadlines

One audit is capped below the competition's 20-minute limit. Per-check
deadlines are capped at 360 seconds and run concurrently. Intake, Moiré,
Artifact persistence, and publication share the remaining budget.

## A2A Boundary

The official A2A JavaScript SDK provides:

- Agent Card discovery;
- HTTP+JSON and JSON-RPC 1.0 transports;
- Task submission, lookup, and cancellation;
- status and Artifact updates.

One external Task represents one complete audit. Internal checks are not
separate A2A agents. Streaming and push notifications are not advertised.

## Remaining Work

- provision the real G01 local package in each deployment;
- register G02 and G03 only after their strategies and datasets are frozen;
- implement public factor and comparison skills;
- add multi-turn clarification and durable remote Task recovery.
