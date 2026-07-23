# Agent Runtime Architecture

> Status: 🚧 stub — this file is linked from README; the runtime owner should
> expand it. Content below is consolidated from the bootstrap commit's README
> section so the link resolves.

## Isolation Model

Every task creates an isolated oh-my-pi `Agent` instance. No conversation
state crosses requests, which also matches the product's stateless-per-call
A2A design (`docs/product/ARCHITECTURE.md`): one audit = one call = one
closed loop, no dependence on A2A task persistence.

## Tool Policy

- Tools declare a `read`, `write`, or `exec` tier; undeclared tools are
  treated as `exec`.
- `read` is allowed by default. `write` and `exec` are denied unless the host
  approval callback explicitly allows them.
- Planned PandaData tools will be `read`-tier. The planned backtester tool is
  compute-only and side-effect free; neither tool family is registered yet.

## Audit Events

Tool lifecycle events record tool names, statuses, and call IDs, without tool
arguments or results. Agent lifecycle events currently include streamed model
text (`agent.delta`), the final output (`agent.completed`), and failure text
(`agent.failed`). The complete event array is also returned in
`RuntimeTaskResult`; the CLI writes model deltas to stdout.

These agent events can contain task or model-generated sensitive content.
Hosts must treat them as sensitive and must not persist them by default.
Credential redaction and an explicit event-retention policy remain open
hardening work; the current event contract must not be described as
metadata-only.

## Time Budget

A run is capped at 19 minutes by default, leaving margin under the track's
20-minute total response limit. The product-level allocation of that budget
across intake / checks / cross-validation / reporting is specified in
`docs/product/PIPELINE.md`.

## Open Items

- Ark endpoint routing for the competition DeepSeek V4 Pro model
  (see README "Model Configuration").
- A2A gateway wiring (agent card, task endpoint, structured DataPart output).
- Registration of the five audit-check agents and the Moiré orchestrator
  (`docs/product/ARCHITECTURE.md` §5).
