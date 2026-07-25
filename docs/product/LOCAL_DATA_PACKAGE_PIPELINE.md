# Local Data Package Pipeline

> Status: runtime planning, resolution, integrity checks, and `dataRef` wiring
> are implemented. Each deployment must still provision the ignored G01 data
> files and descriptor. G02 and G03 are not defined or registered.
>
> This document supersedes every earlier proposal for runtime PandaData
> acquisition.

## Decision

Competition runtime never fetches market data from PandaData. Operators prepare
immutable packages before deployment.

```text
Natural-language A2A request
  -> Ark StrategySpec parsing
  -> deterministic validation and freeze
  -> claims-free strategy projection
  -> LocalDataPlan
  -> immutable package registry match
  -> integrity verification
  -> task-bound dataRef
  -> claim reproduction
  -> five checks
  -> Moiré
  -> Audit Artifact
```

The model parses strategy fields. It does not select packages, paths,
capabilities, checksums, or a `dataRef`.

## Current State

Implemented:

- canonical strategy projection without claims;
- deterministic `strategyKey`;
- `LocalDataPlan`;
- package descriptor parsing and exact matching;
- path containment and symbolic-link rejection;
- market file, V9 manifest, and PIT tree checksums;
- one task-bound `dataRef` shared by every numerical stage;
- non-blocking server startup when the registry is absent;
- readiness reporting through `/readyz`;
- request failure when no valid package is available.

Deployment gap:

- `.cache/` is intentionally ignored by Git;
- the target machine must contain the G01 market panel, V9 manifest, PIT tree,
  and registry descriptor;
- G02 and G03 remain unspecified.

## Strategy Identity

`StrategySpec` remains the only complete input contract. Data planning removes
claims:

```ts
type CanonicalStrategyDefinition = Omit<CanonicalStrategySpec, "claims">;
```

Claims never influence package selection:

```text
same strategy + different claims
  -> same strategyKey
  -> same LocalDataPlan
  -> same packageId
```

Transaction-cost assumptions also do not affect market-data identity. Claim
reproduction may switch to a no-cost convention while retaining the same
package.

## LocalDataPlan

```ts
interface LocalDataPlan {
  schemaVersion: "assay-local-data-plan-v1";
  strategyKey: string;
  indexSymbol: string;
  window: {
    start: string;
    end: string;
  };
  requiredCoverage: {
    start: string;
    end: string;
  };
  requirements: readonly LocalDataRequirement[];
}

type LocalDataRequirement =
  | "trade_calendar"
  | "pit_membership"
  | "adjusted_close"
  | "trade_status"
  | "index_daily"
  | "comparator_factors"
  | "strategy_signal_factors";
```

The plan describes required data, not provider calls. It contains no PandaData
method, pagination, retry, credential, or rate-limit information.

For G01, the registered evaluation window and required coverage are fixed by
the frozen V9 package. Any future case must declare its complete warm-up and
evaluation coverage before registration.

## Package Descriptor

Each descriptor represents one strategy identity:

```ts
interface LocalDataPackageDescriptor {
  schemaVersion: "assay-local-data-package-v1";
  packageId: string;
  strategyKey: string;
  universe: {
    indexSymbol: string;
    membershipMode: "point_in_time";
  };
  window: {
    start: string;
    end: string;
  };
  coverage: {
    start: string;
    end: string;
    asOf: string;
  };
  capabilities: Record<
    Exclude<LocalDataRequirement, "strategy_signal_factors">,
    "ready" | "degraded"
  >;
  paths: {
    marketDataCache: string;
    v9CacheRoot: string;
    pitCacheRoot: string;
  };
  checksums: {
    marketData: string;
    v9Manifest: string;
    pitTree: string;
  };
}
```

Descriptors live under:

```text
ASSAY_LOCAL_DATA_PACKAGE_ROOT/local-packages/<packageId>.json
```

The filename must equal the descriptor package ID.

## Registry Layout

```text
ASSAY_LOCAL_DATA_PACKAGE_ROOT/
├─ local-packages/
│  └─ g01-csi300-momentum.json
├─ csi300-3y.csv
├─ v9-p1-v1/
│  └─ manifest.json
└─ pit-availability-v1/
   └─ index-weights/
      └─ 000300_SH/
         └─ <snapshot files>
```

The registry descriptor is metadata, not market data. Unit tests use synthetic
fixtures; production descriptors must point to frozen data prepared from the
verified provider source.

## Matching and Integrity

A package matches only when all conditions hold:

1. exact `strategyKey`;
2. exact index universe;
3. exact evaluation window;
4. complete required coverage;
5. every required capability is declared;
6. descriptor paths stay inside the registry root;
7. source files and PIT tree match their checksums.

The result must be unique.

| Result                   | Behavior                                     |
| ------------------------ | -------------------------------------------- |
| One valid package        | Return a task-bound `dataRef`                |
| No package               | Fail the audit Task                          |
| Multiple matches         | Fail the audit Task                          |
| Invalid descriptor       | Mark readiness false and fail the audit Task |
| Invalid path or checksum | Mark readiness false and fail the audit Task |

There is no default package and no online fallback.

## dataRef

The host creates:

```text
assay-local-data-v1:<auditId>:<packageId>:sha256-<descriptorDigest>
```

Properties:

- one audit has one `dataRef`;
- it binds the Task, package, and descriptor bytes;
- it contains no absolute path;
- it is never accepted from model output;
- claim reproduction, all checks, and Moiré use the same value;
- Python loaders revalidate it before reading package data.

## Process and Readiness Semantics

Registry validation no longer prevents the server process from starting.

```text
missing registry
  -> server starts
  -> healthz = 200
  -> readyz = 503
  -> Agent Card remains discoverable
  -> audit request reaches data resolution
  -> Task = FAILED
  -> no audit Artifact
```

Infrastructure failure must not be represented as an `UNVERIFIABLE` business
Artifact. `UNVERIFIABLE` is reserved for normal product outcomes such as
incomplete or unsupported input.

## Registered Cases

| Case | Strategy                                                          | Claims                        | packageId             |
| ---- | ----------------------------------------------------------------- | ----------------------------- | --------------------- |
| G01  | CSI 300, 20-day momentum, monthly rebalance, top 50, equal weight | 18% annual return, 1.9 Sharpe | `g01-csi300-momentum` |
| G02  | Not defined                                                       | Not defined                   | Not registered        |
| G03  | Not defined                                                       | Not defined                   | Not registered        |

Changing only claims does not create another package.

## Preparation Boundary

`services/panda-adapter` retains the pinned PandaData dependency for explicit
offline preparation and compatibility tests. Production does not:

- initialize PandaData;
- read PandaData credentials;
- instantiate an online acquisition gateway;
- register online `panda_*` tools;
- use provider readiness as process liveness;
- recover from local failure by fetching online.

Prepared input is immutable. Task-scoped output is written separately under
`ASSAY_AUDIT_OUTPUT_ROOT`.

## Acceptance

Before a real G01 audit:

1. provision all G01 source files;
2. generate `local-packages/g01-csi300-momentum.json`;
3. verify all checksums;
4. start the A2A server;
5. confirm `/readyz` returns `200`;
6. run `bun run e2e:checks`;
7. run the Windows Agent Card self-test.

The complete E2E requires Ark credentials and the G01 local package. It does
not require PandaData credentials or runtime market-data network access.
