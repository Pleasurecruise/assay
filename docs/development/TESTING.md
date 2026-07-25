# Testing Standard

## 1. Purpose

Tests protect protocol boundaries, isolation, deterministic orchestration, and
failure semantics. They must not merely reproduce implementation details.

## 2. Test Layers

### Contract Tests

Contract tests cover:

- stable Agent IDs and canonical ordering;
- accepted conclusion and confidence domains;
- required evidence for conclusive results;
- required explanations for missing evidence;
- exact `not_applicable` representation;
- rejection of non-finite numbers and cross-agent ID impersonation.

These tests live under `packages/contracts/tests/`.

### Orchestration Unit Tests

Tests under `packages/agents/tests/` use an in-memory
`AuditCheckTaskRunner` fake. They must cover:

- all applicable branches start before any branch is allowed to finish;
- one branch failure does not discard successful siblings;
- invalid or wrong-ID output degrades only the affected branch;
- skill profiles dispatch the correct branches;
- canonical five-result ordering is preserved;
- caller cancellation rejects the batch and is not converted into
  `insufficient_evidence`;
- invalid requests fail before dispatch.

Parallelism tests use a barrier or deferred promise. Do not use timing
thresholds or sleeps; they are slow and nondeterministic.

### Runtime Unit Tests

Runtime tests cover registry validation, tool-tier policy, event mapping,
deadlines, and abort propagation. Model streams should be faked at the
oh-my-pi boundary when practical.

### Integration Tests

Integration tests may cover:

- one `AgentRuntime` invocation with a deterministic fake model;
- local package loaders and deterministic Backtester tools against fixtures;
- complete check fan-out with fixture data;
- the A2A `AgentExecutor`, event bus, Artifact publication, and cancellation.

Integration tests that require credentials or live services must be opt-in and
must never run as part of the default unit-test command.

The current real-model test is documented in
[E2E_TESTING.md](E2E_TESTING.md).

## 3. Isolation Rules

- Unit tests must not call real LLM providers, PandaData, or external A2A
  endpoints.
- Tests must not depend on local `.env` credentials.
- Every test creates its own fake runner and mutable state.
- No test may rely on execution order from another test.
- Use fixed fixture values for evidence; never use live market values.
- Do not snapshot secrets, complete prompts, or raw model streams.

## 4. Assertions

Prefer assertions on public behavior:

- dispatched Agent IDs and request fields;
- result ordering and conclusions;
- failure containment;
- cancellation and deadline behavior;
- schema validation errors.

Avoid assertions on private fields or incidental prompt whitespace.

## 5. Commands

```bash
bun run test
bun run typecheck
bun run fmt:check
bun run check
```

Run focused tests during development:

```bash
bunx vitest run packages/contracts/tests/audit-checks.test.ts
bunx vitest run packages/agents/tests/parallel-check-runner.test.ts
```

## 6. Definition of Done

A multi-agent runtime change is complete when:

- new protocol behavior has a contract test;
- fan-out, profile, failure, or cancellation changes have orchestration tests;
- default tests make no network calls;
- format, type checking, and unit tests pass;
- architecture and protocol documentation match the implementation.
