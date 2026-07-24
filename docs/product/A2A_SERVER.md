# Assay A2A Server Architecture

> Status: design draft. This document records the proposed boundary and
> lifecycle of the Assay A2A Server. It does not describe an implemented
> gateway.
>
> Related contracts and evidence:
> [STRATEGY_SPEC.md](STRATEGY_SPEC.md),
> [DATA_NOTES.md](DATA_NOTES.md),
> [DATA_ACCESS.md](../architecture/DATA_ACCESS.md),
> [RUNTIME.md](../architecture/RUNTIME.md),
> [PIPELINE.md](PIPELINE.md), and
> [VERDICT_SPEC.md](VERDICT_SPEC.md).
>
> External protocol references:
> [A2A specification](https://a2a-protocol.org/latest/specification/) and
> [official JavaScript SDK](https://github.com/a2aproject/a2a-js).

## 1. Design Goal

The Assay A2A Server is the public protocol and task-control plane for one
complete strategy-credibility audit. It must:

- expose Assay as a hosted A2A Remote Agent with a reachable Agent Card;
- accept both natural-language strategy descriptions and structured
  `StrategySpec` input;
- request missing or ambiguous information through multi-turn A2A
  interactions;
- validate the finalized strategy against Assay's product boundary and the
  capabilities actually available through PandaAI;
- run one complete audit within the competition budget;
- publish a machine-readable and human-readable final Artifact;
- preserve cancellation, idempotency, recovery, security, and provenance
  across the complete lifecycle.

The server is not another audit Agent. It does not perform the five checks,
compute a verdict, or directly call vendor SDK methods inside protocol
handlers.

## 2. Competition and Provider Facts

The design is constrained by the following organizer-provided facts:

- the submission is a self-hosted A2A Remote Agent;
- the platform discovers the service through a public Agent Card URL;
- the Agent must accept natural-language tasks;
- the required foundation model is the organizer-provided DeepSeek Pro
  endpoint;
- one complete response must stay within the stated 20-minute limit;
- the output must be explainable and include assumptions and risk disclosure;
- the Agent may only use authorized data and services.

The supplied model interface is a Volcano Ark, OpenAI-compatible Responses
API. The endpoint ID is passed as `model`, and credentials remain server-side
in `ARK_API_KEY`.

PandaData is a separate Python SDK authenticated with
`PANDA_DATA_USERNAME` and `PANDA_DATA_PASSWORD`. Its public Python method
surface is not the same boundary as the A2A interface, and the presence of an
SDK method does not prove that the competition service enables the method,
date range, fields, or concurrency needed by an audit.

The organizer material does not yet establish the evaluator's exact A2A
protocol version, transport, authentication scheme, structured-data support,
streaming behavior, or request timeout. These are compatibility inputs to the
gateway, not assumptions that should leak into the audit domain.

## 3. Core Lifecycle Decision

One A2A Task represents one audit request from the first input draft through
clarification, execution, and final Artifact:

```text
A2A Message
    │
    ▼
Task created
    │
    ▼
Intake draft ───── missing or ambiguous ─────► INPUT_REQUIRED
    ▲                                                │
    └──────── same taskId follow-up Message ─────────┘
    │
    ▼
Canonical StrategySpec frozen
    │
    ▼
CheckPlan fixed → audit execution → report
    │
    ▼
Artifact persisted and published
    │
    ▼
COMPLETED
```

`contextId` groups a related conversation that may contain several Tasks.
`taskId` identifies the lifecycle of this particular audit and its
`StrategySpec` draft.

Clarification replies must continue the same non-terminal Task. A completed,
failed, canceled, or otherwise terminal Task is immutable. A request to change
a completed strategy creates a new Task in the same context and may explicitly
reference the earlier Task.

## 4. System Boundary

```text
PandaAI Evaluator or another A2A Client
                    │
                    ▼
┌───────────────────────────────────────────────────────────────┐
│ Assay A2A Server                                              │
│                                                               │
│ Agent Card · authentication · protocol/version compatibility  │
│ Task lifecycle · input decoding · clarification · persistence │
│ progress mapping · cancellation · Artifact publication        │
└───────────────────────────────┬───────────────────────────────┘
                                │ versioned internal contracts
                                ▼
┌───────────────────────────────────────────────────────────────┐
│ Intake and Audit Application Layer                            │
│                                                               │
│ Strategy parser · deterministic validator · capability probe  │
│ StrategySpec freezer · CheckPlan builder · AuditOrchestrator   │
└──────────────────┬────────────────────────────┬───────────────┘
                   │                            │
                   ▼                            ▼
        ArkModelGateway              FinanceDataGateway
                   │                            │
                   ▼                            ▼
        Volcano Ark Responses API     private PandaData adapter
                                               │
                                               ▼
                                      panda_data Python SDK
```

The A2A Server depends only on versioned application ports. It must not import
`panda_data`, construct Ark clients in a request handler, or pass A2A objects
into check Agents.

## 5. Component Responsibilities

| Component | Responsibility |
| --- | --- |
| `AgentCardProvider` | Publishes only capabilities proven compatible with the PandaAI evaluator |
| `A2AProtocolAdapter` | Maps the selected A2A version and transport into version-neutral application commands and events |
| `AssayAgentExecutor` | Owns Task execution, continuation, cancellation, and event publication |
| `StrategyInputDecoder` | Reads natural-language, structured data, and JSON-text fallback Parts without applying business defaults |
| `IntakeService` | Produces and revises a typed strategy draft |
| `StrategySpecValidator` | Applies deterministic schema, range, cross-field, and product-scope validation |
| `ClarificationPlanner` | Converts only user-resolvable blockers into stable clarification questions |
| `CapabilityRegistry` | Records what the deployed Ark and PandaData integrations have actually verified |
| `StrategySpecFreezer` | Expands declared defaults, canonicalizes the Spec, records provenance, and computes its hash |
| `AuditOrchestrator` | Projects `FrozenAuditInput` into the implemented `ParallelAuditChecksRequest`, composes the existing `ParallelAuditCheckRunner` with Moiré and reporting; it does not know A2A (see §15.1) |
| `TaskStore` | Persists externally visible A2A Task state |
| `IntakeSessionStore` | Persists the authoritative draft, revisions, issues, and processed Messages |
| `ArtifactStore` | Persists final output before Task completion is published |

## 6. Public Input Forms

### 6.1 Natural language

A text Part may contain a strategy description:

```text
在沪深 300 中，每月底选择过去 20 个交易日涨幅最高的 50
只股票，等权持有。
```

Natural language is parsed by a stateless Intake parser using the required
DeepSeek Pro model. The parser returns untrusted structured output. A
deterministic validator, not the model, decides whether the draft is complete
and supported.

### 6.2 Structured StrategySpec

A structured data Part may carry a versioned request envelope:

```json
{
  "requestSchemaVersion": "1.0.0",
  "skill": "audit_strategy",
  "subject": {
    "id": "strategy_01",
    "input": {
      "kind": "strategy_spec",
      "spec": {
        "specVersion": "1",
        "universe": { "index": "000300.SH" },
        "signal": {
          "kind": "template",
          "template": "momentum",
          "params": { "window": 20 }
        },
        "selection": { "topN": 50, "weighting": "equal" },
        "rebalance": { "frequency": "monthly", "at": "close" },
        "window": { "start": "20210101", "end": "20251231" },
        "costs": { "model": "standard" }
      }
    }
  }
}
```

Structured input bypasses LLM extraction, but it never bypasses deterministic
validation, product-scope validation, Panda capability checks, or
canonicalization.

### 6.3 JSON text fallback

Until the PandaAI evaluator proves support for A2A structured data Parts, the
same request envelope may be accepted as JSON serialized inside a text Part.
This is a compatibility path; it is decoded into the same internal command and
must not become a second domain contract.

### 6.4 Mixed text and structured Parts

When one Message contains both structured input and text:

- structured fields are the authoritative field values;
- text may add intent, labels, explicit claims, or answers to outstanding
  questions;
- text never silently overwrites a structured field;
- any contradiction becomes a user-visible clarification issue;
- raw A2A metadata is not used as the authoritative strategy payload.

## 7. Draft and Canonical Strategy Models

The server must not collapse all input back into `string`. Intake operates on
a draft wrapper:

```ts
interface StrategyDraft {
  taskId: string;
  contextId: string;
  revision: number;
  partialSpec: DeepPartial<StrategySpec>;
  fieldProvenance: Readonly<Record<string, FieldProvenance>>;
  issues: readonly IntakeIssue[];
  defaultsApplied: readonly AppliedDefault[];
  processedMessageIds: readonly string[];
}
```

Each material field records whether it was:

- explicitly provided in structured input;
- extracted from a specific natural-language Message;
- supplied in a clarification reply;
- filled from a declared contract default;
- derived deterministically from another accepted field.

The canonical `StrategySpec` is created only after all user-resolvable blockers
are cleared. Five-check execution receives that immutable object, not raw
Messages or conversation history.

## 8. Default Policy

Defaults are allowed only when they are explicitly versioned in the
`StrategySpec` contract. Every applied default is expanded into the canonical
Spec and disclosed in the final Artifact.

For the MVP, the intended policy is:

| Field | Missing-field behavior |
| --- | --- |
| `universe.index` | Ask; there is no safe default universe |
| `signal` | Ask; there is no safe default signal |
| supported template parameters | Apply the template's declared defaults and disclose them |
| `selection.topN` | Ask |
| `selection.weighting` | Default to `equal`, the only MVP weighting mode, and disclose |
| `rebalance.frequency` | Ask |
| `rebalance.at` | Default to `close`, the only MVP execution point, and disclose |
| `window.start` / `window.end` | Ask; never invent a historical window |
| `costs.model` | Default to `standard` and disclose |
| `claims` | Keep absent; never invent performance claims |

An explicit unsupported value is not replaced by a default. For example,
`weighting: "cap"` does not silently become `"equal"`.

## 9. Intake Outcomes and Responsibility

Validation must return a typed outcome, not a single `valid` boolean:

```ts
type IntakeOutcome =
  | {
      kind: "ready";
      spec: CanonicalStrategySpec;
      plan: CheckPlan;
      capabilitySnapshot: CapabilitySnapshot;
    }
  | {
      kind: "input_required";
      draft: StrategyDraft;
      questions: readonly ClarificationQuestion[];
    }
  | {
      kind: "data_limited";
      spec: CanonicalStrategySpec;
      issues: readonly ProviderIssue[];
      disposition: "proceed_partial" | "unverifiable";
    }
  | {
      kind: "unsupported";
      issues: readonly UnsupportedIssue[];
    };
```

Every issue has an owner and a resolution route:

| Cause | Owner | Behavior |
| --- | --- | --- |
| Required information is missing | caller | `INPUT_REQUIRED` |
| Natural language has multiple plausible meanings | caller | `INPUT_REQUIRED` with explicit alternatives |
| A value is malformed or locally out of range but correctable | caller | `INPUT_REQUIRED` with field path and constraint |
| A requested feature is outside Assay's supported strategy family | Assay | Complete with an `UNVERIFIABLE` Artifact |
| A Panda capability is absent or lacks historical coverage | provider | Auto-disposed by the deterministic coverage policy below; never a user question |
| A transient dependency or gateway fails | system | bounded retry, then safe A2A failure when the whole Task cannot proceed |

Only caller-owned issues generate clarification questions — of any kind. The
server must not ask a user to repair a Panda outage, supply data that the
platform failed to provide, or approve a degraded scope. Provider limitations
are resolved by policy, not by dialogue.

### 9.1 Coverage Disposition Policy (MVP)

Scope consent (asking the caller to approve a narrowed audit) is deliberately
out of MVP scope: it would add a second interaction type, a
`preflight → INPUT_REQUIRED` back-edge in the state machine, and a dependency
on unverified evaluator support for repeated `INPUT_REQUIRED` continuation.
Instead, `data_limited` is resolved deterministically:

1. Compute the effective window: the intersection of the requested
   `window` and verified provider coverage, after subtracting signal
   lookback and the perturbation/time-shift margin required by the
   CheckPlan.
2. If the effective window spans at least 2 years (the existing
   STRATEGY_SPEC minimum), the disposition is `proceed_partial`: the audit
   runs on the effective window, affected checks may degrade, and the
   Artifact prominently discloses the requested-versus-effective window and
   every affected check.
3. Otherwise the disposition is `unverifiable`: the Task completes with an
   `UNVERIFIABLE` Artifact that states the provider limitation and includes
   a machine-readable `retryWith` suggestion (the narrowed spec the caller
   could resubmit as a new Task in the same context).

The policy is pure configuration plus arithmetic — no model involvement, no
state-machine change, no extra round-trip. If post-baseline evaluator testing
proves repeated `INPUT_REQUIRED` continuation works, explicit scope consent
can be layered on later as a new question kind without disturbing this
default.

## 10. Multi-Turn Clarification

### 10.1 Status transition

When caller-owned blockers remain, the Task enters A2A `INPUT_REQUIRED`. The
status Message contains both:

- a concise text explanation for people;
- a structured clarification request for Agent clients.

```json
{
  "kind": "strategy_clarification_request",
  "schemaVersion": "1.0.0",
  "draftRevision": 2,
  "draft": {
    "specVersion": "1",
    "universe": { "index": "000300.SH" },
    "signal": {
      "kind": "template",
      "template": "momentum",
      "params": { "window": 20 }
    },
    "selection": { "topN": 50, "weighting": "equal" },
    "rebalance": { "frequency": "monthly", "at": "close" }
  },
  "questions": [
    {
      "id": "strategy.window",
      "path": "/window",
      "kind": "missing_input",
      "prompt": "请提供回测的起止日期。",
      "answerSchema": {
        "type": "object",
        "required": ["start", "end"],
        "properties": {
          "start": { "type": "string", "pattern": "^[0-9]{8}$" },
          "end": { "type": "string", "pattern": "^[0-9]{8}$" }
        }
      }
    }
  ]
}
```

### 10.2 Follow-up input

The caller sends a new Message with a new `messageId` and the same `taskId`.
The response may be natural language or a structured patch:

```json
{
  "kind": "strategy_clarification_response",
  "schemaVersion": "1.0.0",
  "replyToRevision": 2,
  "answers": [
    {
      "questionId": "strategy.window",
      "value": {
        "start": "20210101",
        "end": "20251231"
      }
    }
  ]
}
```

`replyToRevision` prevents a delayed response from overwriting a newer draft.
Natural-language follow-ups are parsed only against the outstanding questions
and current draft, rather than by replaying the full conversation into a
stateful Agent.

### 10.3 Clarification rules

- Ask all currently known blocking questions in one round.
- Keep question IDs and field paths stable while the underlying issue remains.
- Revalidate the complete draft after every patch.
- Serialize concurrent replies to one Task and use optimistic revision checks.
- A round must resolve an issue, introduce a concrete new conflict, or reach a
  terminal outcome; it must not loop on paraphrased questions.
- Waiting for input is interruptible and cancelable.
- If the caller declines to answer, repeatedly provides no usable information,
  or the clarification policy expires, complete with a transparent
  `UNVERIFIABLE` result rather than inventing fields.

### 10.4 Clarification Limits (MVP defaults, configuration)

Two knobs bound the clarification loop. Both live in configuration, not code:

- **Round cap: 3 productive rounds per Task.** One round = one
  `INPUT_REQUIRED` transition through revalidation of the patched draft.
  Replies rejected by a stale `replyToRevision` and idempotent duplicate
  `messageId` replays do not consume a round. A well-behaved flow finishes
  in one round (§10.3 asks everything at once); round two absorbs a new
  conflict introduced by an answer; a third unresolved round means the
  caller is looping. Exhaustion completes the Task with the §4.1 Artifact,
  `reasonCode: insufficient_information`.
- **Reply timeout: 10 minutes per wait**, measured from `inputRequiredAt`.
  Agent callers answer in seconds; a human in a demo answers in minutes; a
  caller silent for 10 minutes is gone. Expiry completes the Task with the
  §4.1 Artifact, `reasonCode: clarification_expired`. The `expiresAt`
  timestamp is persisted with the Task and re-armed during restart
  recovery.

Together they bound a Task's clarification phase to at most three 10-minute
waits, so no separate whole-task lifetime knob is needed.

These defaults assume the organizer's 20-minute limit excludes
`INPUT_REQUIRED` waiting (our execution clock starts at `specFrozenAt`,
§16). That interpretation is unverified (§27); if evaluator testing shows
total wall-clock measurement, shrink the reply timeout by configuration —
the design does not change.

The authoritative draft lives in `IntakeSessionStore`. A2A Task history is
useful for interaction display but is not the source of truth because history
may be omitted, truncated, or unavailable after reconnection.

## 11. Internal and A2A State Models

The internal phase is more precise than the public A2A state:

| Internal phase | A2A state | Meaning |
| --- | --- | --- |
| `intake.received` | `SUBMITTED` | Task accepted |
| `intake.decoding` | `WORKING` | Input form and request envelope are being decoded |
| `intake.parsing` | `WORKING` | Natural language is being converted into a draft |
| `intake.awaiting_input` | `INPUT_REQUIRED` | Caller-owned blockers remain |
| `intake.preflight` | `WORKING` | Static and live capability checks are running |
| `audit.queued` | `WORKING` | Canonical Spec and CheckPlan are frozen |
| `audit.checking` | `WORKING` | Independent checks are running |
| `audit.moire` | `WORKING` | Material disagreements are being investigated |
| `audit.reporting` | `WORKING` | Verdict and final Artifact are being assembled |
| `terminal.completed` | `COMPLETED` | Final Artifact has been persisted and published |
| `terminal.canceled` | `CANCELED` | Actual execution has stopped |
| `terminal.failed` | `FAILED` | A system failure prevented a valid business result |

The protocol adapter maps these version-neutral names to the concrete enum
representation expected by the negotiated A2A version.

An `UNVERIFIABLE` verdict is normally a successful business result and
therefore uses A2A `COMPLETED`, not `FAILED`.

## 12. Intake and Capability Validation Order

Intake follows a fixed order:

1. authenticate and authorize the caller;
2. deduplicate `messageId` and validate Task/context continuity;
3. decode text, structured data, or JSON-text fallback;
4. validate request-envelope and `StrategySpec` versions;
5. reject unsafe payload classes and unsupported executable code;
6. parse natural language into a partial typed draft when needed;
7. apply only declared deterministic defaults;
8. validate required fields, types, enums, ranges, and cross-field semantics;
9. return all caller-resolvable issues together when clarification is needed;
10. check deployed system capabilities;
11. run bounded, cached Panda capability and coverage probes;
12. canonicalize and hash the accepted Spec;
13. fix data requirements, variant counts, CheckPlan, and budgets;
14. freeze the Spec before starting any audit branch.

Explicitly unsupported input should be detected before asking irrelevant
missing-field questions.

## 13. StrategySpec to PandaAI Mapping

The public `StrategySpec` remains vendor-neutral enough for callers to
understand, while adapters own Panda-specific parameter names and quirks.

| Strategy requirement | Panda capability used during preflight or execution |
| --- | --- |
| `universe.index` | `get_index_weights(index_symbol, start_date, end_date)` |
| library signal | `get_factor(factors, start_date, end_date, symbol/index_component, type)` |
| momentum, reversal, volatility templates | `get_market_data` plus `get_adj_factor` |
| turnover template | market data fields that include verified turnover coverage |
| weekly/monthly rebalance | `get_trade_cal` and related trade-date operations |
| point-in-time tradability | `get_trade_list` and `get_stock_status_change` |
| financial timing checks | `get_fina_forecast`, `get_fina_performance`, and guarded use of `get_fina_reports` |

The capability check must distinguish:

```ts
type CapabilityStatus =
  | "declared_by_sdk"
  | "verified_live"
  | "unavailable"
  | "not_implemented_by_assay"
  | "temporarily_failed";
```

Examples:

- an SDK exporting `get_market_data` is only `declared_by_sdk` until the
  competition service and return contract are tested;
- a factor name typo is caller-correctable;
- a valid factor with no authorized coverage is a provider limitation;
- a method that exists in the SDK but has no Assay adapter is a system
  implementation gap;
- a quarterly-report timestamp whose semantics are unverified remains an
  explicit audit limitation, not a user question.

Coverage probes must account for signal lookback, parameter perturbations, and
time-window shifts, not merely the visible `window.start` and `window.end`.

## 14. Vendor Gateways

### 14.1 ArkModelGateway

```ts
interface ArkModelGateway {
  execute(
    request: ModelRequest,
    options: {
      signal: AbortSignal;
      deadline: Date;
    },
  ): Promise<ModelResult>;
}
```

It owns:

- Ark base URL and endpoint aliases;
- `ARK_API_KEY`;
- Responses API request/response mapping;
- finite retry behavior;
- safe error classification;
- model capability probes;
- token and payload logging policy.

The A2A Server, Agent Card, Task metadata, and Artifacts never expose Ark
endpoint credentials.

### 14.2 FinanceDataGateway

```ts
interface FinanceDataGateway {
  capabilities(): Promise<CapabilitySnapshot>;
  query(
    request: FinanceDataRequest,
    options: {
      signal: AbortSignal;
      deadline: Date;
    },
  ): Promise<FinanceDataResult>;
}
```

The implementation talks to a private, long-lived Python PandaData adapter.
That process:

- initializes `panda_data` exactly once before becoming ready;
- owns Panda credentials and vendor-specific `snake_case` parameters;
- serializes DataFrames into a versioned JSON or Arrow contract;
- enforces field allowlists, row limits, date limits, deadlines, cache keys,
  bounded concurrency, and finite backoff;
- maps vendor failures to credential-safe error codes;
- is never exposed as a public Internet endpoint.

The current repository adapter only establishes guarded initialization and a
raw `get_market_data` call. Network transport, typed serialization, most
methods, cache, concurrency control, deadlines, and cancellation remain
prerequisites for the complete server.

## 15. Freeze, Hash, and Execution Boundary

When Intake returns `ready`, the server creates an immutable execution
snapshot:

```ts
interface FrozenAuditInput {
  requestSchemaVersion: string;
  strategySpecVersion: string;
  artifactSchemaVersion: string;
  skill: "audit_strategy";
  spec: CanonicalStrategySpec;
  specHash: string;
  dataAsOf: string;
  capabilitySnapshotId: string;
  checkPlan: CheckPlan;
  codeRevision: string;
}
```

Canonicalization must define object-key ordering, explicit default expansion,
date format, index-code normalization, and numeric representation. The hash is
computed from the canonical object, not from raw natural language or A2A
history.

Claims may be excluded from numerical cache keys because they do not change
calculations, but they remain part of the request and report fingerprint
because they change the final comparison narrative.

No clarification patch may mutate a frozen Task. A requested strategy change
after freeze cancels the current Task or creates a new referenced Task,
depending on caller intent.

A frozen Task never re-enters `INPUT_REQUIRED`. Data gaps discovered during
execution degrade the affected check to `insufficient_evidence` (§23) —
they never bounce the Task back to the caller.

### 15.1 Binding to the Implemented Check Contract

The five-check fan-out contract is already implemented and tested:
`ParallelAuditChecksRequest` in `packages/contracts/src/audit-checks.ts`,
executed by `ParallelAuditCheckRunner` in `packages/agents`. This document
binds to that contract; it does not redefine or fork it. Where this design
and the implemented contract name the same concept, the implemented name
wins (`skill`, `subject.id`, `auditId`, `schemaVersion`).

`AuditOrchestrator` performs a mechanical, loss-free projection:

| `FrozenAuditInput` source | `ParallelAuditChecksRequest` field | Rule |
| --- | --- | --- |
| — | `schemaVersion` | Constant `AUDIT_CHECK_SCHEMA_VERSION` from contracts |
| Task-scoped audit id | `auditId` | Generated once at Task creation; stable across process restarts and retries |
| `skill` | `skill` | Verbatim. `compare_robustness` never reaches this contract (the implemented type already excludes it) |
| Envelope `subject.id`, or generated | `subject.id` | Caller-supplied id when present, otherwise derived from `auditId` |
| `skill` | `subject.kind` | `audit_strategy` → `"strategy"`, `audit_factor` → `"factor"` (enforced by the runner's validator) |
| `spec` | `subject.input` | The canonical JSON serialization of `CanonicalStrategySpec` — see below |
| Factor profile (factor audits only) | `subject.hasPortfolioConstruction` | Set by Intake; ignored for strategy audits |
| `dataAsOf` | `dataAsOf` | Verbatim |
| Task trace id | `traceId` | Verbatim |
| `checkPlan` budgets | `budgets` | Per-check `timeoutMs` and `maxVariants` fixed during Intake |
| Provenance fields | `metadata` | String-valued only: `specHash`, `capabilitySnapshotId`, `codeRevision`, `requestSchemaVersion` |

Three decisions close the previously open seams:

1. **`subject.input` stays a string.** The implemented `AuditSubject.input`
   is a non-empty string and the runner embeds the whole
   `AuditCheckAgentRequest` as JSON into each check agent's prompt
   (`buildAgentInput`). The canonical `StrategySpec` therefore travels as its
   canonical JSON serialization inside `subject.input`. Check agents receive
   the structured spec intact; the runner, its validator, and its tests
   change not at all.

2. **`specHash` is computed over exactly the bytes placed in
   `subject.input`.** Freeze-time hash and execution-time payload are the
   same canonical serialization, so Artifact provenance can assert byte-level
   equality between what was frozen, what was hashed, and what every check
   agent saw.

3. **`CheckPlan` does not cross the boundary as a type.** It remains an
   Intake-internal structure (variant allocation rationale, data
   requirements, budget arithmetic). Only its per-check budget projection
   enters `budgets`; the rationale is persisted in `IntakeSessionStore` and
   disclosed in the Artifact, not passed to check agents.

Version fields remain independent by design: `requestSchemaVersion` versions
the public A2A envelope, `specVersion` versions the `StrategySpec` contract,
and `AUDIT_CHECK_SCHEMA_VERSION` versions the internal fan-out. A change in
one does not force a change in the others; the projection table above is the
single place where they meet.

On the result side, `ParallelAuditChecksResult` (`auditId`, `subjectId`,
`traceId`, five `checks`, `startedAt`, `completedAt`) flows unmodified into
Moiré and Artifact assembly. The orchestrator never edits check results;
`parseAuditCheckResult` in contracts remains the only result gate.

## 16. Time Budget

The server tracks separate timestamps:

- `taskReceivedAt`;
- `inputRequiredAt` and clarification expiry;
- `specFrozenAt`;
- `executionStartedAt`;
- `reportCutoverAt`;
- `executionDeadlineAt`.

Intake should return `INPUT_REQUIRED` promptly instead of holding a connection
open while waiting for a human or caller Agent.

The organizer's exact interpretation of the 20-minute limit across
multi-turn `INPUT_REQUIRED` pauses is not yet known. Deadline policy must
therefore be configurable and verified against the PandaAI test environment.
The MVP clarification defaults are fixed in §10.4: three productive rounds
and a 10-minute reply timeout per wait, both configuration values.
The audit execution plan still requires a hard internal deadline and a report
reserve; clarification must never cause an already-expired execution plan to
start silently.

Retries in Ark and PandaData receive the same remaining deadline. Each layer
must stop retrying when its work would consume the report reserve.

## 17. Progress Events

Public progress is stage-level and safe:

```text
Parsing strategy input
Waiting for required strategy fields
Validating data coverage
Running independent checks: 3/5 complete
Resolving one evidence disagreement
Preparing the audit Artifact
```

The server does not stream raw chain-of-thought, model prompts, tool
arguments, credentials, full PandaData responses, or unfiltered exceptions.
Event order is monotonic and every event is correlated with `taskId`,
`contextId`, `auditId`, and an internal sequence number.

Streaming improves observability but is not required for correctness. A client
that reconnects must recover the current Task and final Artifact from durable
state.

## 18. Final Artifact

Clarification questions and drafts are status Messages, not final Artifacts.

Early exits (unsupported input, exhausted or expired clarification, coverage
below the §9.1 threshold) publish **the same Artifact schema** as a completed
audit — five `not_applicable` checks, verdict `UNVERIFIABLE`, a required
`reasonCode`, result-level `missingInformation`, and an optional machine-
readable `retryWith` suggestion (VERDICT_SPEC §4.1). There is no separate
rejection document; callers only ever parse one shape.

After successful execution, Assay publishes one primary audit Artifact with:

- a structured data Part containing the versioned audit result;
- a text or Markdown Part containing the equivalent human-readable report.

The structured result includes or immutably references:

- the complete canonical `StrategySpec`;
- applied defaults and parsing assumptions;
- `specHash`;
- every canonical check result;
- verdict and confidence;
- missing evidence and provider limitations;
- Moiré disputes and follow-up results;
- recovery conditions and review triggers;
- mandatory risk disclosure;
- data, model-alias, contract, and code provenance without credentials.

Publication order is strict:

```text
validate Artifact
→ persist Artifact
→ publish Artifact event
→ persist completed Task state
→ publish COMPLETED
```

A Task must never be observable as completed without its final Artifact.

## 19. Persistence and Concurrency

The logical persistent records are:

```text
a2a_tasks
- task_id
- context_id
- caller_id
- public_state
- internal_phase
- audit_id
- created_at
- updated_at
- terminal_at

intake_sessions
- task_id
- revision
- draft_spec
- field_provenance
- unresolved_issues
- applied_defaults
- capability_snapshot_id
- frozen_spec
- spec_hash

processed_messages
- caller_id
- message_id
- task_id
- payload_hash
- resulting_revision

artifacts
- task_id
- artifact_id
- schema_version
- content_hash
- payload
- created_at
```

Requirements:

- duplicate `messageId` with the same payload returns the previous result;
- duplicate `messageId` with a different payload is rejected;
- one Task's follow-up Messages are serialized;
- draft updates use optimistic revision checks;
- Task state, session revision, and outbound event intent are committed
  atomically or through an outbox;
- an in-memory `AbortController` may control live work, but cannot be the
  durable Task or cancellation record.

For a single-instance competition deployment, SQLite or another transactional
store may be sufficient if it satisfies recovery and concurrency tests.
Multi-instance deployment additionally requires execution leases and a
cross-instance cancellation signal.

## 20. Cancellation

Cancellation is real execution control:

```text
A2A cancel
→ durable cancel_requested
→ AbortController.abort()
→ stop AuditOrchestrator
→ stop live check Agents
→ propagate cancellation through data/model gateways
→ confirm cleanup
→ publish CANCELED
```

`INPUT_REQUIRED` Tasks remain cancelable.

Canceling a TypeScript Promise is not sufficient if a Python SDK call remains
blocked. The Panda adapter must support a cancelable worker boundary, bounded
request timeout, or safe worker recycling. A canceled Task must not continue
consuming shared Panda or Ark quota in the background.

## 21. Security and Credential Boundaries

Three credential domains remain separate:

1. inbound A2A caller authentication;
2. Ark model credentials;
3. PandaData username and password.

Ark and PandaData credentials never appear in:

- Agent Cards;
- A2A Messages or metadata;
- StrategySpec;
- Task or Intake records;
- Artifacts;
- prompts;
- ordinary logs and exception bodies.

Additional controls:

- HTTPS for the public service;
- input size, nesting-depth, Part-count, and history limits;
- strict StrategySpec schema with unknown-field policy;
- no arbitrary Python or executable strategy input;
- URL and file-input rejection unless a supported skill explicitly requires
  them;
- safe public error codes with internal correlation IDs;
- bounded task, model, and data concurrency;
- explicit retention and purge policy for Tasks, drafts, and evidence;
- no raw vendor response or traceback returned to an A2A caller.

## 22. Agent Card

Assay remains one public Agent. Internal checks are not discoverable A2A
Agents.

The Card advertises only skills whose complete path — input contract,
Intake, execution, Artifact — is implemented and tested. The skill list is
configuration, so adding a skill later is a config change, not a redesign:

- `audit_strategy` — **MVP; the only skill on the baseline Card.** Its full
  path is designed in this document.
- `audit_factor` — stretch goal. The implemented check runner already
  supports it (`subject.kind: "factor"`, `hasPortfolioConstruction` gating),
  but the FactorSpec, envelope variant, and Intake path are not yet
  designed. Added to the Card only when that path passes tests.
- `compare_robustness` — post-baseline (DEMO.md already schedules
  comparison audit in the Polish phase). The implemented fan-out contract
  excludes it, the single-`subject` envelope cannot carry two subjects, and
  two 15-17 minute audits do not fit the 20-minute budget sequentially.
  Callers can meanwhile compare two audit Artifacts client-side — the skill
  adds convenience, not capability.

Two kinds of "no" use two different channels:

- a request for a skill **not on the Card** is rejected at the protocol
  level (error response / rejected state) — the Card is the contract;
- a request for an advertised skill with **out-of-scope input** completes
  with the §4.1 `UNVERIFIABLE` Artifact — a formal business result.

`audit_strategy` advertises both natural-language and structured
`StrategySpec` input only after the corresponding modes pass the PandaAI
evaluator's compatibility tests. The skill description should state:

- the supported MVP strategy family;
- the required semantic fields;
- that missing fields may produce `INPUT_REQUIRED`;
- the structured request schema version;
- the final output media types;
- the non-investment-advice boundary.

Clarification is continuation of the original skill, not a separate
`clarify_strategy` skill.

The final Card's protocol version, transport URLs, mode vocabulary,
authentication scheme, streaming flag, and push-notification flag are selected
from verified PandaAI evaluator behavior rather than copied from the
organizer's illustrative Card.

## 23. Failure Semantics

| Condition | Result |
| --- | --- |
| Natural language is incomplete but answerable | `INPUT_REQUIRED` |
| Structured Spec is correctable | `INPUT_REQUIRED` with field-level issues |
| Text conflicts with structured input | `INPUT_REQUIRED` with both values shown |
| Arbitrary code or unsupported strategy family | `COMPLETED` with `UNVERIFIABLE` Artifact (§4.1 shape, `reasonCode: unsupported_input`) |
| Caller will not provide required information | `COMPLETED` with `UNVERIFIABLE` Artifact (`reasonCode: insufficient_information` after the §10.4 round cap, or `clarification_expired` after the 10-minute reply timeout) |
| One Panda capability is unavailable | affected check becomes `insufficient_evidence`; siblings continue |
| Required historical coverage is narrower than requested | deterministic coverage policy (§9.1): proceed on the effective window with disclosed degradation, or complete `UNVERIFIABLE` (`reasonCode: coverage_too_narrow`) with a `retryWith` suggestion |
| Model or data dependency transiently fails for the whole audit | bounded retry, then A2A `FAILED` with safe retry guidance |
| Caller cancels | actual work stops, then `CANCELED` |
| Report deadline is reached | preserve valid partial evidence and unresolved limitations; never fabricate completion |

## 24. Proposed Repository Placement

```text
apps/
  a2a-server/
    src/
      server.ts
      agent-card.ts
      protocol-adapter.ts
      assay-executor.ts
      request-decoder.ts
      event-mapper.ts
      configuration.ts

packages/
  contracts/
    src/
      audit-checks.ts        # existing — implemented and tested
      strategy-spec.ts       # new
      audit-request.ts       # new: public envelope, reuses audit-checks vocabulary
      clarification.ts       # new
      audit-artifact.ts      # new

  intake/
    src/
      intake-service.ts
      natural-language-parser.ts
      strategy-validator.ts
      clarification-planner.ts
      strategy-freezer.ts

  agents/
    src/
      definitions.ts             # existing
      parallel-check-runner.ts   # existing — five-check fan-out
      audit-orchestrator.ts      # new: FrozenAuditInput → ParallelAuditChecksRequest → Moiré → report

  finance-tools/
    src/
      finance-data-gateway.ts

services/
  panda-adapter/
    # private long-lived Python service
```

`packages/agent-runtime` continues to own one isolated internal Agent
invocation. It does not own A2A Tasks, clarification state, Panda credentials,
or final Artifact persistence.

### 24.1 Implementation Phasing

This document is the complete design; it is not the build order. Phases
follow DEMO.md (walking skeleton → submission baseline → polish). Anything
not listed for a phase is not built in that phase.

| Phase | Scope |
| --- | --- |
| **Skeleton** | Agent Card (`audit_strategy` only) · text input → Intake parse → validate → freeze → runner → Artifact publication, end to end · incomplete or unsupported input exits early via the §4.1 Artifact (no clarification yet) |
| **Baseline** (submission) | Multi-turn clarification (§10, §10.4) · structured input + JSON-text fallback (§6) · default policy (§8) · coverage disposition (§9.1) · SQLite persistence, `messageId` idempotency, serialized replies (§19) · restart recovery · cancellation (§20) · stage-level progress events (§17) · strict publication order (§18) · credential separation, input limits, no-exec policy (§21) · `specHash` (§15) |
| **Polish** | SSE streaming (polling is the baseline path) · full per-field provenance (baseline tracks `defaultsApplied` only) · Panda adapter caching and worker recycling · retention/purge policy · `audit_factor` path |
| **Out of scope** | Outbox/atomic event commit (single instance; state and Artifact are durable, a lost progress event is acceptable) · multi-instance leases and cross-instance cancellation · Arrow serialization (JSON suffices) · `compare_robustness` |

Two simplifications apply to §5 at baseline: `A2AProtocolAdapter` is a thin
wrapper over the official SDK's types for the one deployed protocol version —
the version-neutral command layer waits until a second version exists; and
`CapabilityRegistry` is a static configuration file plus an in-memory probe
cache, not a service.

What stays in baseline despite looking heavy — because it protects the demo
itself: durable Task state, `messageId` idempotency, Artifact-before-COMPLETED
ordering, and restart recovery. A service restart during review must not
strand or corrupt a Task.

## 25. Test Strategy

### Contract tests

- natural-language, structured-data, and JSON-text decoding converge on one
  internal request;
- canonical StrategySpec validation and default expansion;
- clarification request and response schemas;
- canonical JSON and stable hash;
- Artifact includes the frozen Spec and risk disclosure.

### Intake state-machine tests

- complete structured input skips LLM parsing;
- complete natural language proceeds without a confirmation-only round;
- missing dates enter `INPUT_REQUIRED`;
- a same-Task follow-up resolves the issue and resumes execution;
- stale `replyToRevision` cannot overwrite a newer draft;
- duplicate Message handling is idempotent;
- conflicting text and structured fields never resolve silently;
- unsupported input completes as `UNVERIFIABLE`;
- provider and system failures never become fake user questions.

### A2A integration tests

- Agent Card discovery;
- Task creation, polling, streaming, and reconnection;
- multiple `INPUT_REQUIRED` cycles on one Task;
- Task/context mismatch rejection;
- Artifact publication before completion;
- cancellation while working and while awaiting input;
- service restart recovery.

### PandaAI compatibility tests

- evaluator-selected A2A version and transport;
- actual Agent Card parsing;
- natural-language Message invocation;
- structured data Part invocation or JSON-text fallback;
- follow-up Message using the same Task;
- Ark Responses endpoint behavior;
- live PandaData initialization, method availability, fields, date coverage,
  rate limiting, and safe failure mapping;
- three complete organizer-facing example tasks under the time limit.

## 26. Decisions Already Fixed

- Assay is one public A2A Agent.
- One Task owns one audit draft through clarification and completion.
- `contextId` groups interactions; it is not the StrategySpec source of truth.
- Natural language and structured StrategySpec converge on one Intake
  contract.
- Structured input bypasses LLM extraction, not validation.
- User-resolvable missing information uses `INPUT_REQUIRED`.
- Provider limitations and system gaps are not disguised as user questions.
- The canonical StrategySpec is frozen before the CheckPlan starts.
- Check Agents receive the frozen Spec, not A2A history.
- Final results use an Artifact; Messages are for interaction and progress.
- Completion follows successful Artifact persistence and publication.
- Ark, PandaData, and inbound A2A credentials stay in separate boundaries.
- Execution binds to the implemented `ParallelAuditChecksRequest` and
  `ParallelAuditCheckRunner`; contract vocabulary from `packages/contracts`
  (`skill`, `subject.id`, `auditId`, `schemaVersion`) is authoritative.
- The canonical `StrategySpec` travels as canonical JSON inside
  `subject.input`; `specHash` is computed over exactly those bytes.
- `CheckPlan` stays Intake-internal; only its per-check budgets project into
  the fan-out request's `budgets`.
- Provider limitations are auto-disposed by the deterministic coverage
  policy (§9.1); scope consent is out of MVP scope. A frozen Task never
  re-enters `INPUT_REQUIRED`.
- Early exits reuse the single audit Artifact schema with `reasonCode` and
  optional `retryWith` (VERDICT_SPEC §4.1); there is no separate rejection
  document.
- The MVP Agent Card publishes `audit_strategy` only; skills join the Card
  by configuration once their full path passes tests. Unadvertised skills
  are rejected at the protocol level, not with an Artifact.
- Clarification is bounded by configuration: 3 productive rounds and a
  10-minute reply timeout per wait (§10.4).
- Build order follows §24.1 phasing; outbox, multi-instance leases, and
  Arrow serialization are explicitly out of scope.

## 27. Open Questions Requiring PandaAI Verification

- Which A2A protocol version and transport will the evaluator use?
- What exact Agent Card schema and discovery path does it parse?
- Does it support structured data Parts, vendor media types, and multiple
  Parts in one Message?
- Does it support `INPUT_REQUIRED` continuation with the same Task?
- Does it support streaming, polling, cancellation, and reconnection?
- What inbound authentication mechanism will PandaAI use?
- How is the 20-minute limit measured across a clarification pause?
- What are the evaluator's connection and idle timeouts?
- Which PandaData methods, fields, history ranges, and concurrency limits are
  actually enabled?
- What is the real server-side status of `get_market_data`?
- What semantics does the `get_fina_reports` date-related surface provide in
  the competition environment?
- Does the Ark endpoint support every model behavior required by the current
  oh-my-pi runtime, including tool calls, structured output, streaming, and
  cancellation?

Until these are answered by organizer confirmation or a live test
environment, they remain compatibility probes and configuration choices, not
domain assumptions.
