# System Architecture

> Status: implemented `audit_strategy` vertical slice.
>
> [CURRENT_STATE.md](../CURRENT_STATE.md) is the authoritative readiness
> summary. [PIPELINE.md](PIPELINE.md) defines request flow.

## System Overview

```text
┌────────────────────────────────────────────────────────────────────┐
│                              Clients                               │
│       Agent Card checker | A2A client | authenticated web UI       │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │
┌─────────────────────────────────▼──────────────────────────────────┐
│                           A2A Server                               │
│ Agent Card | HTTP+JSON | JSON-RPC | Task lifecycle | cancellation │
│ healthz | readyz | capabilities | Artifact publication            │
└───────────────┬───────────────────────────────────────┬────────────┘
                │                                       │
        ┌───────▼────────┐                     ┌────────▼─────────┐
        │     Intake     │                     │ Auth and History │
        │ Ark parse      │                     │ Better Auth      │
        │ validate       │                     │ SQLite           │
        │ freeze spec    │                     └──────────────────┘
        └───────┬────────┘
                │
        ┌───────▼─────────────────┐
        │ Local Data Resolution   │
        │ claims-free plan        │
        │ registry match          │
        │ checksum verification   │
        │ task-bound dataRef      │
        └───────┬─────────────────┘
                │
        ┌───────▼────────┐
        │ Claim           │
        │ Reproduction    │
        └───────┬────────┘
                │
       ┌────────┼──────────┬──────────┬──────────────┐
       │        │          │          │              │
┌──────▼───┐ ┌──▼──────┐ ┌─▼──────┐ ┌─▼────────┐ ┌─▼────────────┐
│Parameter │ │Data     │ │Cost    │ │Regime   │ │Homogeneity  │
│robustness│ │available│ │stress  │ │dependency│ │and decay    │
└──────┬───┘ └──┬──────┘ └─┬──────┘ └─┬────────┘ └─┬────────────┘
       └────────┴──────────┴──────┬───┴────────────┘
                                  │
                         ┌────────▼────────┐
                         │ Moiré M1 / M2   │
                         │ host synthesis  │
                         └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                         │ Verdict and     │
                         │ A2A Artifact    │
                         └─────────────────┘

┌──────────────────────────────┐  ┌─────────────────────────────────┐
│ Volcano Ark                 │  │ Local Data and Python Compute   │
│ intake and check Agents     │  │ immutable package registry      │
│                             │  │ panda-adapter local experiments │
└──────────────────────────────┘  └─────────────────────────────────┘
```

Volcano Ark supplies natural-language parsing and the five check Agents.
Market evidence comes only from a host-selected immutable local package.
Production never fetches PandaData online.

## Components

| Component              | Responsibility                                                             | Location                 |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------ |
| A2A Server             | Agent Card, transports, Task lifecycle, cancellation, health and readiness | `apps/a2a-server`        |
| Web workbench          | Authenticated audit UI and history                                         | `apps/web`               |
| Intake                 | Ark parsing, deterministic validation, canonical freeze                    | `packages/intake`        |
| Contracts              | Strategy, check, Moiré, verdict, and Artifact schemas                      | `packages/contracts`     |
| Data planner           | Claims-free strategy identity and requirements                             | `packages/finance-tools` |
| Local package resolver | Unique match, path safety, checksums, task-bound `dataRef`                 | `apps/a2a-server`        |
| Agent runtime          | Fresh oh-my-pi Agent, tool policy, cancellation, event mapping             | `packages/agent-runtime` |
| Five checks            | Fixed prompts, tools, parallel runner, Moiré planner                       | `packages/agents`        |
| Python adapter         | Offline package preparation and local quantitative execution               | `services/panda-adapter` |

## A2A Server

The public Agent Card advertises only `audit_strategy`. HTTP+JSON and JSON-RPC
use A2A 1.0. Streaming and push notifications are disabled.

The server may start while local data is not ready:

- `/healthz` reports process liveness;
- `/readyz` reports model and local-package readiness;
- `/capabilities` exposes whether packages are configured;
- an audit that cannot resolve a verified package becomes `FAILED`.

Optional Bearer authentication protects both A2A transports. Google
authentication and SQLite persistence apply to browser history, not public
Agent Card discovery.

## Intake and Data Identity

Intake converts natural language into one canonical `StrategySpec`. Validation,
defaults, canonical serialization, and hashing are deterministic.

Claims are retained for claim reproduction but removed before data planning.
Changing only claims or transaction-cost assumptions must not select another
market-data package.

The resolver requires one exact package match by:

- strategy key;
- index universe;
- evaluation window and coverage;
- required capabilities;
- descriptor and source checksums.

No match, multiple matches, unsafe paths, or checksum failure stop the audit.
There is no default package and no online fallback.

## Independent Checks

| Agent ID            | Responsibility                           |
| ------------------- | ---------------------------------------- |
| `param-robustness`  | Parameter-neighborhood stability         |
| `data-availability` | Point-in-time membership and tradability |
| `cost-stress`       | Transaction-cost sensitivity             |
| `regime-dependency` | Performance concentration across regimes |
| `homogeneity-decay` | Factor similarity and annual IC decay    |

Each branch receives the same frozen strategy and `dataRef`, but no sibling
messages or conclusions. Invalid output or a branch failure degrades only that
check. Caller cancellation aborts the entire audit.

## Moiré and Reporting

Moiré runs after independent checks. The implemented host planner permits at
most M1 and M2 discriminating experiments. Results are validated and
synthesized deterministically.

The final Artifact contains:

- the frozen strategy and provenance;
- claim reproduction when claims were submitted;
- all five canonical check slots;
- Moiré disputes and refinements;
- verdict, confidence, recovery conditions, and risk disclosure.

The language model does not select the final verdict.

## Storage

```text
.cache/assay/                 immutable local packages, ignored by Git
.cache/assay/audit-output/    task-scoped derived calculation output
data/assay.sqlite             local auth and private audit history
artifacts/                    checked-in sanitized acceptance evidence
```

Acceptance evidence is not runtime source data and cannot replace a local
package.

## Status

| Capability                                         | Status          |
| -------------------------------------------------- | --------------- |
| A2A server and Agent Card                          | Implemented     |
| Natural-language strategy intake                   | Implemented     |
| Local package planning and resolution              | Implemented     |
| Claim reproduction and five checks                 | Implemented     |
| Moiré M1/M2 and deterministic verdict              | Implemented     |
| Web authentication and private history             | Implemented     |
| Canonical CSI 300 source package bundled           | Implemented     |
| G01/G02/G03 claims-free runtime bindings           | Implemented     |
| Factor and comparison public skills                | Not implemented |
| Multi-turn clarification and durable Task recovery | Not implemented |
