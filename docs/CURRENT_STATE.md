# Current Implementation State

> Updated: 2026-07-25.
>
> This file is the authoritative status summary. Product specifications may
> describe later phases, but they must not contradict the runtime boundaries
> recorded here.

## Implemented

- Official A2A 1.0 HTTP+JSON and JSON-RPC transports.
- Public Agent Card with the `audit_strategy` skill.
- Natural-language intake through Volcano Ark, deterministic validation, and
  frozen `StrategySpec` provenance.
- Claims-free data planning and immutable local-package resolution across
  three registered strategy bindings.
- Claim reproduction, five isolated audit agents, bounded Moiré M1/M2
  experiments, deterministic verdict synthesis, and JSON/Markdown Artifacts.
- Task cancellation, execution timelines, optional A2A Bearer authentication,
  Google authentication, SQLite-backed private audit history, and the web
  workbench.
- Local Python execution through the `services/panda-adapter` project.

## Data Boundary

Production does not initialize PandaData and does not fetch market data
online. PandaData remains pinned only for offline package preparation and
adapter compatibility tests.

The repository commits one shared canonical source package, its integrity
manifest, and a registry containing three claims-free strategy bindings. Each
deployment must run `bun run data:prepare` to validate that source and
deterministically materialize three immutable runtime packages under
`ASSAY_LOCAL_DATA_PACKAGE_ROOT`. Generated `.cache/` runtime packages remain
intentionally ignored.

Startup and request semantics are separate:

- `/healthz` reports whether the A2A process is alive.
- `/readyz` returns `503` while the local registry is absent or invalid.
- Agent Card and A2A transports remain available while the service is not
  ready.
- An audit that reaches local data resolution without a valid package ends in
  A2A Task state `FAILED`.
- Missing or invalid infrastructure never produces an `UNVERIFIABLE`
  business Artifact and never triggers an online fallback.

`UNVERIFIABLE` remains a successful business result only for supported
early-exit semantics such as incomplete or unsupported input.

## Model Boundary

The A2A server and runtime CLI use one Volcano Ark configuration:

```dotenv
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL_DEEPSEEK=
```

Local market data does not make the complete audit network-free. Natural
language intake and audit agents still call the configured Ark endpoint.

## Current Deployment Requirement

All three strategy bindings are registered. G01, G02, and G03 are fixture and
acceptance labels only; runtime intake does not recognize or route by those
labels. It freezes the parsed natural-language strategy, builds a claims-free
data identity, and resolves one of the three semantic runtime package IDs.

A fresh deployment must run `bun run data:prepare` before service startup and
point `ASSAY_LOCAL_DATA_PACKAGE_ROOT` at the generated, validated registry.
Acceptance then starts one A2A server and submits the three frozen
natural-language inputs sequentially through that same server lifecycle.

## Not Implemented

- `audit_factor` and `compare_robustness` public skills.
- Multi-turn A2A clarification and durable remote Task recovery.
- Streaming and push notifications.
- Runtime online PandaData acquisition.
