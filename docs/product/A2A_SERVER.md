# Assay A2A Server

> Status: implemented for the `audit_strategy` vertical slice.
>
> See [CURRENT_STATE.md](../CURRENT_STATE.md) for deployment readiness and
> [VERDICT_SPEC.md](VERDICT_SPEC.md) for the Artifact contract.

## Public Surface

The server uses the official `@a2a-js/sdk` package and exposes:

| Endpoint                       | Purpose                           |
| ------------------------------ | --------------------------------- |
| `/.well-known/agent-card.json` | Public Agent Card                 |
| `/a2a`                         | A2A 1.0 HTTP+JSON                 |
| `/a2a/jsonrpc`                 | A2A 1.0 JSON-RPC                  |
| `/healthz`                     | Process liveness                  |
| `/readyz`                      | Model and local-package readiness |
| `/capabilities`                | Assay capability snapshot         |

The Agent Card advertises:

- one skill: `audit_strategy`;
- text input;
- JSON and Markdown output;
- HTTP+JSON and JSON-RPC 1.0 interfaces;
- no streaming, push notifications, or extended card.

`audit_factor` and `compare_robustness` are not advertised.

## Request Lifecycle

One inbound A2A Task represents one complete audit:

```text
A2A acceptance
  -> skeleton decode
  -> Ark strategy intake
  -> deterministic data plan
  -> immutable local package resolution
  -> claim reproduction
  -> five-check parallel fan-out
  -> bounded Moiré
  -> Artifact validation and persistence
  -> Artifact publication
  -> COMPLETED
```

The server publishes working status updates between stages. It persists the
validated Artifact before publishing the terminal completed state.

Caller cancellation propagates through one `AbortSignal` to live Agents and
Python subprocesses. The Task becomes `CANCELED`.

## Input

The current skill accepts one or more text Parts, joined as natural-language
strategy input. File and structured data Parts are not supported.

Ark maps text into the fixed `StrategySpec` schema. The host then:

1. validates every field;
2. applies declared defaults;
3. canonicalizes and freezes the spec;
4. computes its hash;
5. removes claims before data planning.

The model cannot choose a package ID, data path, `dataRef`, verdict, or package
capability.

Incomplete or unsupported input completes with an `UNVERIFIABLE` early-exit
Artifact. This is a successful business outcome, not an infrastructure
failure.

## Local Data Resolution

Production resolves only immutable local packages under
`ASSAY_LOCAL_DATA_PACKAGE_ROOT`.

A package must match exactly by strategy key, universe, window, coverage, and
required capabilities. The resolver validates path containment, rejects
symbolic links, and verifies market data, manifest, and point-in-time tree
checksums.

The returned `dataRef` binds:

- the current audit ID;
- package ID;
- descriptor digest.

The `dataRef` is host-only and is never taken from model output.

## Startup and Readiness

Local data readiness must not prevent the protocol process from starting.

| Condition                | `/healthz` | `/readyz` | Audit request |
| ------------------------ | ---------- | --------- | ------------- |
| Valid registry           | `200`      | `200`     | Runs normally |
| Registry absent          | `200`      | `503`     | `FAILED`      |
| Descriptor invalid       | `200`      | `503`     | `FAILED`      |
| Package checksum invalid | `200`      | `503`     | `FAILED`      |

Agent Card discovery and both A2A transports remain available while readiness
is false. No invalid package condition produces an `UNVERIFIABLE` Artifact,
and no condition enables online PandaData fallback.

## Failure Semantics

| Condition                                   | Terminal behavior                                                    |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Empty or incomplete input                   | `COMPLETED` with `UNVERIFIABLE` Artifact                             |
| Unsupported strategy input                  | `COMPLETED` with `UNVERIFIABLE` Artifact                             |
| Local registry or package failure           | `FAILED`, no audit Artifact                                          |
| Ark or internal runtime failure             | `FAILED`, no audit Artifact                                          |
| One check fails after fan-out               | Other checks continue; failed branch becomes `insufficient_evidence` |
| Caller cancellation                         | `CANCELED`                                                           |
| Artifact persistence or publication failure | `FAILED`                                                             |

Public failures contain a correlation ID and stage but no provider response,
credential, filesystem path, stack trace, or model text.

## Authentication

`ASSAY_A2A_BEARER_TOKEN` optionally protects both A2A transports. The public
Agent Card advertises the Bearer scheme without exposing the token.

Better Auth is separate:

- Google OAuth authenticates the web workbench;
- session cookies are HttpOnly;
- private audit history is stored per user in SQLite;
- browser authentication does not replace optional A2A Bearer authentication.

## Model Configuration

The server uses one Volcano Ark configuration:

```dotenv
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL_DEEPSEEK=
```

The endpoint ID is sent as the Responses API model. Credentials remain in the
host environment and never enter Task data or Artifacts.

## Data Configuration

```dotenv
ASSAY_DATA_AS_OF=2026-07-23
ASSAY_LOCAL_DATA_PACKAGE_ROOT=.cache/assay
ASSAY_AUDIT_OUTPUT_ROOT=.cache/assay/audit-output
```

The data snapshot date is fixed. Input packages and derived output use
separate roots.

Python modules run through `uv run --project services/panda-adapter` unless
`ASSAY_EXPERIMENT_PYTHON` explicitly pins an interpreter.

## Persistence

The current A2A SDK Task store and audit Artifact store are in memory.
Authenticated web audit history is durable in SQLite. Multi-turn
clarification, restart-safe A2A Task recovery, and durable remote Task state
are not implemented.

## Agent Card Self-Test

The Windows Agent Card checker can:

1. resolve the public Agent Card;
2. validate both A2A 1.0 interfaces;
3. select HTTP+JSON;
4. submit a normal call;
5. skip streaming because the Card declares it unsupported.

Card validation does not imply data readiness. A complete audit call requires
`/readyz` to report a valid local package.
