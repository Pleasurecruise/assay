# PandaData Access Architecture

## Boundary

PandaData is a Python SDK and must not be imported by the TypeScript agent
runtime. Data access crosses a narrow adapter boundary:

```text
Data Agent
  -> TypeScript AgentTool (`market_data`)
  -> PandaData adapter transport
  -> initialized Python process
  -> `panda_data.get_market_data`
```

The Python adapter lives in `services/panda-adapter`. TypeScript tools that
call it will live in `packages/finance-tools`. This keeps vendor credentials,
SDK-specific types, DataFrames, and retry behavior outside prompts and agent
state.

## Installation

Python and `uv` are managed by mise. Install the adapter and its pinned
PandaData dependency from the repository root:

```bash
mise install
mise exec -- bun run sdk:sync
```

The adapter currently pins `panda_data==0.0.12`. Updating the SDK is an explicit
dependency change and must be followed by adapter tests and a data-contract
review.

The package metadata for PandaData 0.0.12 declares Python 3.10 or newer, while
the SDK's own package documentation requires Python 3.12 or newer. It also pins
`numpy<2`; the NumPy 1.26 line supports Python only through 3.12. Assay
therefore uses the latest Python 3.12 patch through mise and constrains this
adapter to `>=3.12,<3.13`. This follows the intersection of the vendor's
documented and transitive runtime constraints without overriding dependency
metadata.

A successful dependency resolution is not sufficient: `sdk:doctor` must import
the real SDK before the adapter is considered installable.

## Initialization Contract

The SDK has a strict lifecycle:

1. The package must be installed before the adapter process starts.
2. `PANDA_DATA_USERNAME` and `PANDA_DATA_PASSWORD` must be present in the
   process environment.
3. The adapter calls `panda_data.init_token` exactly once during process
   startup.
4. The process becomes ready only after initialization succeeds.
5. Every data method rejects calls made before successful initialization.

Initialize the installed SDK:

```bash
copy .env.example .env
# Load the variables into the process environment without printing them.
mise exec -- bun run sdk:init
```

`sdk:init` performs a real credential exchange. It intentionally fails when
credentials are absent or rejected. A future HTTP or RPC server must construct
its client through `create_initialized_client`; it must never expose a route
before that factory returns.

## Credential Rules

- Credentials enter only through process environment variables or a future
  secret manager.
- Credentials are never accepted in agent tasks, tool arguments, A2A messages,
  audit events, or ordinary logs.
- The adapter never returns a token to TypeScript.
- Initialization errors may report an error category but must not include
  usernames, passwords, tokens, or raw vendor responses that contain secrets.

## Tool Contract

The first TypeScript integration will expose a read-tier tool named
`market_data`. Its input contract will use protocol-facing `camelCase` fields
and convert them to the PandaData SDK's `snake_case` parameters inside the
adapter.

The adapter will enforce symbol formats, date ranges, field allowlists, row
limits, deadlines, and structured error codes. Raw DataFrames will be converted
to a versioned JSON or Arrow contract before crossing the process boundary.

## Current Scope

This phase installs the SDK and implements its guarded initialization lifecycle.
It does not yet start a network listener. The transport and TypeScript
`packages/finance-tools` client are the next data-access milestone.

## Tool Roadmap (product-driven)

The five audit checks (see `docs/product/ARCHITECTURE.md`) require these
read-tier tools beyond `market_data`, all verified available in the
PandaData SDK / competition skill layer:

| Tool ID                 | SDK method                                   | Consumed by                             |
| ----------------------- | -------------------------------------------- | --------------------------------------- |
| `market_data`           | `get_market_data`                            | all backtest-based checks               |
| `adj_factor`            | `get_adj_factor`                             | backtester (price adjustment)           |
| `index_weights`         | `get_index_weights`                          | data-availability (survivorship bias)   |
| `trade_list`            | `get_trade_list`                             | data-availability (tradability)         |
| `stock_status_change`   | `get_stock_status_change`                    | data-availability (ST states)           |
| `factor_library`        | `get_factor`                                 | homogeneity-decay (correlation, IC)     |
| `trade_calendar`        | `get_trade_cal` / `get_prev_trade_date`      | intake, all checks                      |
| `financial_disclosures` | `get_fina_forecast` / `get_fina_performance` | data-availability (real `info_date`)    |
| `fina_reports`          | `get_fina_reports` (`is_latest=False`)       | data-availability (disclosure versions) |

Adapter-level requirements carried over from the product design:

- **Shared query cache**: identical queries across concurrent checks must hit
  the adapter cache, not the vendor API.
- **Bounded concurrency + backoff**: rate limits exist but are unpublished;
  the adapter owns bounded parallelism and finite exponential backoff on 429.
- **Known data gaps** (design around, do not work around): the current
  `get_fina_reports` tool contract has report-period semantics and exposes no
  announcement-date parameter; forecast and performance interfaces do expose
  `info_date`. Industry constituents carry inclusion dates but no exclusion
  dates.
