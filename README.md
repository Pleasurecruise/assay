# Assay

> Everyone is mining for alpha. We sell the assay.

Assay is an A2A strategy-credibility audit agent for the AdventureX 2026
PandaAI track. It parses a strategy, reproduces submitted claims, runs five
independent robustness checks, applies bounded Moiré cross-validation, and
returns a deterministic verdict with reproducible evidence.

Current implementation status: [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md).

## Workflow

```text
Natural-language strategy
  -> StrategySpec validation and freeze
  -> immutable local data package
  -> claim reproduction
  -> five checks in parallel
  -> Moiré M1/M2
  -> KEEP / WATCH / QUARANTINE / RETIRE / UNVERIFIABLE
  -> A2A JSON and Markdown Artifact
```

Only `audit_strategy` is public. Factor and comparison skills are not
implemented.

## Repository

```text
apps/
  a2a-server/        A2A transports and audit executor
  web/               Authenticated audit workbench
  runtime-cli/       Ark runtime smoke-test CLI
packages/
  contracts/         Strategy, check, verdict, and Artifact contracts
  finance-tools/     Local data planning and typed finance tools
  agent-runtime/     oh-my-pi runtime, policy, and events
  agents/            Five checks, parallel runner, and Moiré
  intake/            Ark parsing and StrategySpec freezing
services/
  panda-adapter/     Offline package preparation and local computation
tests/
  e2e/               A2A and golden-package acceptance tests
artifacts/           Sanitized checked-in acceptance evidence
docs/                Architecture, product, and development documentation
reference/           Local competition material and tokens; ignored by Git
```

`artifacts/` is evidence, not runtime market data. Immutable packages live
under `.cache/assay` and are intentionally ignored by Git. `reference/` is a
local-only input directory and must never be committed.

## Setup

```bash
mise install
mise exec -- bun install
mise exec -- bun run sdk:sync
mise exec -- bun run check
```

Copy `.env.example` to `.env` and configure:

```dotenv
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL_DEEPSEEK=

ASSAY_DATA_AS_OF=2026-07-23
ASSAY_LOCAL_DATA_PACKAGE_ROOT=.cache/assay
ASSAY_AUDIT_OUTPUT_ROOT=.cache/assay/audit-output

ASSAY_A2A_PORT=3001
ASSAY_A2A_PUBLIC_URL=http://127.0.0.1:3001
ASSAY_A2A_CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173

ASSAY_AUTH_BASE_URL=http://localhost:5173
BETTER_AUTH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ASSAY_DATABASE_PATH=data/assay.sqlite
```

`ASSAY_A2A_BEARER_TOKEN` is optional. When configured, both A2A transports
require `Authorization: Bearer <token>`.

## Local Data Requirement

Production never fetches PandaData online. A deployment must provision an
immutable package registry under `ASSAY_LOCAL_DATA_PACKAGE_ROOT`.

Missing or invalid local data does not stop the server process:

- `/healthz` remains `200`;
- `/readyz` returns `503`;
- Agent Card discovery remains available;
- an audit that requires data ends in Task state `FAILED`;
- no online fallback or audit Artifact is produced.

The repository does not bundle the real G01 package. See
[Local Data Package Pipeline](docs/product/LOCAL_DATA_PACKAGE_PIPELINE.md).

## Run

Start the server:

```bash
mise exec -- bun run a2a:server
```

Start the web workbench:

```bash
mise exec -- bun run --filter @assay/web dev
```

Open `http://localhost:5173`.

Service endpoints:

```text
http://127.0.0.1:3001/.well-known/agent-card.json
http://127.0.0.1:3001/a2a
http://127.0.0.1:3001/a2a/jsonrpc
http://127.0.0.1:3001/healthz
http://127.0.0.1:3001/readyz
http://127.0.0.1:3001/capabilities
```

The Windows Agent Card checker selects the HTTP+JSON interface. Streaming is
skipped because the Agent Card does not advertise it.

## Tests

```bash
bun run check
```

The real G01 acceptance test is opt-in and requires Ark credentials plus the
complete local package:

```bash
bun run e2e:checks
```

See [E2E Testing](docs/development/E2E_TESTING.md).

## Documentation

- [Current State](docs/CURRENT_STATE.md)
- [System Architecture](docs/product/ARCHITECTURE.md)
- [A2A Server](docs/product/A2A_SERVER.md)
- [Audit Pipeline](docs/product/PIPELINE.md)
- [Local Data Packages](docs/product/LOCAL_DATA_PACKAGE_PIPELINE.md)
- [Audit Checks](docs/product/CHECKS.md)
- [Verdict and Artifact](docs/product/VERDICT_SPEC.md)
- [Runtime Architecture](docs/architecture/RUNTIME.md)
- [Data Access](docs/architecture/DATA_ACCESS.md)

## Disclaimer

Assay produces technical robustness audits, not investment advice or return
promises. Every conclusion depends on the supplied strategy, frozen historical
data, and declared assumptions.
