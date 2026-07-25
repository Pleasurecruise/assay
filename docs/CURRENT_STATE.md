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
- Claims-free data planning and immutable local-package resolution.
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

Each deployment must provision an immutable local package registry under
`ASSAY_LOCAL_DATA_PACKAGE_ROOT`. The repository does not commit these packages;
`.cache/` is intentionally ignored.

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

## Current Deployment Gap

The code and fixture tests are implemented, but a real deployment must still
provision and register the G01 immutable data package before `/readyz` becomes
ready and a complete audit can run. G02 and G03 are not registered.

## Not Implemented

- `audit_factor` and `compare_robustness` public skills.
- Multi-turn A2A clarification and durable remote Task recovery.
- Streaming and push notifications.
- Runtime online PandaData acquisition.
