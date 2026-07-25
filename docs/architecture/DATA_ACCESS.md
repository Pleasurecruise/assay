# Data Access Architecture

> Status: implemented local-package runtime boundary.
>
> See [CURRENT_STATE.md](../CURRENT_STATE.md) and
> [LOCAL_DATA_PACKAGE_PIPELINE.md](../product/LOCAL_DATA_PACKAGE_PIPELINE.md).

## Runtime Boundary

The production A2A service never initializes PandaData, reads PandaData
credentials, or registers online `panda_*` tools.

```text
Frozen StrategySpec
  -> deterministic LocalDataPlan
  -> LocalDataPackageResolver
  -> immutable package descriptor and checksums
  -> host-owned dataRef
  -> Python audit subprocesses
```

The resolver selects exactly one package by canonical strategy identity,
coverage, universe, and declared capabilities. It verifies the market-data
file, V9 manifest, and point-in-time membership tree before returning a
`dataRef`.

No absolute package path enters a model prompt. Claim reproduction, all five
checks, and Moiré receive the same task-bound `dataRef`.

## Service Availability

Package readiness is not process liveness:

- the server starts even when the registry is absent or invalid;
- `/healthz` remains available;
- `/readyz` returns `503` with `localDataPackages: false`;
- a request that reaches data resolution without a valid package ends as a
  `FAILED` A2A Task;
- no audit Artifact is emitted for this infrastructure failure;
- the runtime never falls back to an online provider.

## Python Adapter Responsibilities

`services/panda-adapter` owns two explicit roles:

1. offline PandaData package preparation and compatibility tests;
2. runtime deterministic calculations over a resolved local package.

The runtime role includes backtests, availability correction, regime splits,
homogeneity checks, and Moiré experiments. Runtime subprocesses read immutable
input through `ASSAY_LOCAL_DATA_PACKAGE_ROOT` and write task-scoped derived
output through `ASSAY_AUDIT_OUTPUT_ROOT`.

Python subprocesses use:

```text
uv run --project services/panda-adapter python -m <module>
```

`ASSAY_EXPERIMENT_PYTHON` may override the interpreter when a host has already
provisioned one.

## Offline Preparation

The adapter pins `panda_data==0.0.12` and Python `>=3.12,<3.13`. Provider
credentials are required only when an operator explicitly runs preparation:

```bash
bun run sdk:sync
bun run sdk:doctor
bun run sdk:init
```

Preparation code may call PandaData, but it must write a bounded, immutable
package and descriptor before production use. Credentials, tokens, DataFrames,
and raw provider errors must not cross into A2A messages, Agent tools, or
Artifacts.

## Storage Separation

```text
ASSAY_LOCAL_DATA_PACKAGE_ROOT/
  local-packages/*.json
  immutable market and PIT data

ASSAY_AUDIT_OUTPUT_ROOT/
  task-scoped derived artifacts
```

Input packages are read-only during audits. Derived output is never included
in package checksums and cannot replace package source data.
