# Agent Runtime Architecture

> Status: the generic runtime and five-check fan-out are implemented. Data
> tools, Backtester tools, Intake, Moiré, reporting, and the A2A gateway remain
> roadmap work.

## 1. Layering

```text
A2A gateway (planned)
  └─ Main Agent / audit orchestrator
       └─ ParallelAuditCheckRunner
            ├─ AgentRuntime.run(param-robustness)
            ├─ AgentRuntime.run(data-availability)
            ├─ AgentRuntime.run(cost-stress)
            ├─ AgentRuntime.run(regime-dependency)
            └─ AgentRuntime.run(homogeneity-decay)
                 └─ fresh @oh-my-pi/pi-agent-core Agent per call
```

The A2A gateway owns remote task lifecycle. `AgentRuntime` owns one isolated
oh-my-pi invocation. `ParallelAuditCheckRunner` owns internal fan-out and
result validation. These responsibilities must not be collapsed into a single
stateful Agent.

## 2. oh-my-pi Composition

The repository pins `@oh-my-pi/pi-agent-core` and uses its public runtime
surface:

- construct a fresh `Agent` with model, prompt, tools, and empty messages;
- subscribe to agent, message, and tool lifecycle events;
- invoke one self-contained `prompt`;
- enforce host policy through `beforeToolCall`;
- propagate timeout or caller cancellation through `agent.abort`;
- unsubscribe and abort during cleanup.

This follows the library's evented Agent design while keeping product policy
and multi-agent orchestration outside the dependency.

## 3. Isolation Model

Every `AgentRuntime.run` call creates a new Agent. No messages, pending tool
calls, steering queues, or mutable Agent state cross request boundaries.

All five checks may share:

- the immutable normalized subject;
- an audit and trace identifier;
- immutable cached data query results;
- model configuration and tool definitions.

They may not share:

- conversation history;
- conclusions or partial conclusions;
- mutable tool state that is not scoped by audit and branch;
- sibling events as prompt input.

## 4. Main-Agent Interface

The public internal boundary is:

- `ParallelAuditChecksRequest`: audit ID, skill profile, subject, optional
  data date, per-check budgets, and trace metadata;
- `AuditCheckAgentRequest`: the subset visible to one branch;
- `ParallelAuditChecksResult`: one canonical ordered list containing all five
  check IDs;
- `AuditCheckResult`: validated branch output.

The interfaces live in `packages/contracts/src/audit-checks.ts`. The runner
lives in `packages/agents/src/parallel-check-runner.ts`.

Applicable branches start concurrently with `Promise.all`. This is host-level
parallelism, not model-directed subagent spawning. It provides a typed result
to the parent and avoids free-form sibling communication.

## 5. Branch Failure and Cancellation

Branch failure is contained:

- runtime error;
- branch deadline;
- invalid JSON;
- invalid result fields;
- a returned ID different from the expected Agent ID.

Each becomes `insufficient_evidence` for only that check. Successful siblings
remain available.

Caller cancellation is not contained. The same `AbortSignal` reaches every
runtime call, each live Agent is aborted, and the batch rejects. This allows a
future A2A `cancelTask` implementation to stop real work instead of returning a
misleading evidence result.

## 6. Tool Policy

Tools declare a `read`, `write`, or `exec` tier. Undeclared tools are treated
as `exec`.

- `read` is allowed by default.
- `write` and `exec` require explicit host approval.
- Planned PandaData query tools are `read`.
- The planned Backtester is compute-only and side-effect free, but its final
  tier must be declared explicitly when registered.

Tool arguments and results are omitted from lifecycle audit events. This
reduces exposure but does not make all runtime events metadata-only.

## 7. Events and Sensitive Data

Runtime events include:

- agent start, streamed text, completion, and failure;
- tool start and completion;
- policy denial.

Agent text and failure messages may contain sensitive user or model-generated
content. Hosts must not persist them by default. Credential redaction,
retention policy, and safe aggregate telemetry remain hardening work.

## 8. Deadlines

One runtime call is capped at 19 minutes. The parallel check phase normally
uses a 9-10 minute per-branch budget because branches run concurrently. Intake,
Moiré, reporting, and return reserve share the remaining operating budget.

The runner accepts a per-check `timeoutMs`, which is still capped by
`AgentRuntime`.

## 9. A2A Boundary

The external server should use the official A2A JavaScript SDK:

- implement one `AgentExecutor` for the complete Assay audit;
- map one inbound audit to one A2A Task;
- publish working status while internal stages run;
- propagate cancellation to the batch `AbortSignal`;
- publish structured and text output as Artifact Parts;
- mark the task completed only after Artifact publication.

Internal checks are not separate A2A agents. This keeps protocol lifecycle out
of numerical check logic and avoids five independently persisted remote tasks
for one audit.

## 10. Open Work

- Ark endpoint routing for the required DeepSeek V4 Pro model.
- PandaData and Backtester tool registration per check.
- Intake and fixed budget-plan contracts.
- Moiré follow-up dispatch.
- Full audit Artifact validator and deterministic verdict aggregator.
- Official A2A JavaScript SDK gateway, Agent Card, streaming, and cancellation.
