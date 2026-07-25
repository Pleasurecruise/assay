# Assay

> Everyone is mining for alpha. We sell the assay.

**Assay** is being built as a strategy-credibility audit agent for the
AdventureX 2026 PandaAI track ("Build the Next AI Trader"). It is designed to
run five independent checks in parallel — parameter robustness, data
availability, transaction-cost stress, market-regime dependency, and signal
homogeneity/decay. The planned **Moiré Protocol** cross-validation layer
resolves contradictions through discriminating follow-up experiments, then
returns a five-level verdict (`KEEP / WATCH / QUARANTINE / RETIRE /
UNVERIFIABLE`) with reproducible numeric evidence and recovery conditions.

The current implementation includes the black-and-white web workbench, the A2A
`audit_strategy` path, natural-language Intake through Volcano Ark,
deterministic `StrategySpec` validation/freezing, five isolated checks,
bounded Moiré follow-ups, task cancellation, deterministic local-data package
selection, one host-bound `dataRef`, an Assay-owned structured backtester, and
versioned JSON/Markdown Artifacts with reproducible source references.
Multi-turn clarification, durable task persistence, and the post-baseline
factor/comparison skills remain documented later phases.

While every other agent produces alpha, Assay verifies it. Auditing is a closed-loop complex task, naturally stateless per A2A call, and the track's compliance rules (no return claims, mandatory risk disclosure) describe our product rather than constrain it.

```
target workflow:
strategy / factor input
  → intake (audit plan, 18-minute operational budget)
  → 5 independent checks in parallel (no cross-talk)
  → Moiré cross-validation (contradiction → discriminating experiment)
  → verdict + evidence pack + recovery conditions (A2A Artifact)
```

Product design docs: [PROPOSAL](docs/product/PROPOSAL.md) (why) · [CHECKS](docs/product/CHECKS.md) (the five audits) · [VERDICT_SPEC](docs/product/VERDICT_SPEC.md) (output contract) · [DATA_NOTES](docs/product/DATA_NOTES.md) (platform facts & on-site checklist) · [DEMO](docs/product/DEMO.md) (delivery plan) · [ARCHITECTURE](docs/product/ARCHITECTURE.md) · [PIPELINE](docs/product/PIPELINE.md)

## Technology

- Monorepo: Bun workspaces
- Toolchain management: mise (`latest` Bun, Node.js, and uv; latest Python 3.12 patch)
- TypeScript toolchain: Vite+ for formatting, linting, type checking, and tests
- Agent runtime: `@oh-my-pi/pi-agent-core`
- Model integration: `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-catalog`
- Python: a separate adapter boundary for the PandaData SDK and quantitative workloads

## Repository Layout

```text
apps/
  a2a-server/        Official A2A SDK server and audit executor
  web/               React audit workbench
  runtime-cli/       Local runtime smoke-test entry point
packages/
  contracts/         Stable contracts shared by runtime, A2A, and tool layers
  finance-tools/     Typed PandaData and deterministic backtest Agent tools
  agent-runtime/     oh-my-pi adapter, agent registry, audit events, and tool policy
  agents/            Five audit agents and the typed parallel Main-Agent boundary
  intake/            Ark parser, deterministic validation, and StrategySpec freezer
services/
  panda-adapter/     Guarded Python boundary for the PandaData SDK
docs/
  product/           Product design: proposal, architecture, pipeline
  architecture/      Engineering decisions and roadmap
  development/       Engineering conventions
reference/           Local-only competition material (git-ignored; contains event tokens)
```

## Getting Started

```bash
mise install
mise exec -- bun install
mise exec -- bun run sdk:sync
mise exec -- bun run check
```

All npm registry dependencies are exact-pinned. Vite+ uses Bun as the package
manager through the root `packageManager` declaration.

The competition runtime reads prebuilt immutable packages and does not
initialize PandaData:

```bash
cp .env.example .env
# Register the bundled G01 package and run the local-package E2E.
mise exec -- bun run e2e:checks
```

`sdk:init` and the PandaData preparation scripts are retained only for
pre-competition package construction. See
[Local Data Package Pipeline](docs/product/LOCAL_DATA_PACKAGE_PIPELINE.md) for
the runtime boundary.

Run a request against a real model:

```bash
cp .env.example .env
mise exec -- bun run runtime -- "Audit this momentum strategy: CSI300 universe, top-50 by 20-day return, monthly rebalance."
```

## Run the demo locally

Create a root `.env` from `.env.example`, set the real Volcano Ark credentials,
point the server at the prebuilt package registry, and keep the browser origin
explicit:

```dotenv
ARK_API_KEY=...
ARK_MODEL_DEEPSEEK=...
ASSAY_DATA_AS_OF=2026-07-23
ASSAY_LOCAL_DATA_PACKAGE_ROOT=.cache/assay
ASSAY_AUDIT_OUTPUT_ROOT=.cache/assay/audit-output
ASSAY_A2A_CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
ASSAY_AUTH_BASE_URL=http://localhost:5173
# Optional for non-browser clients such as the Agent Card self-test tool.
ASSAY_A2A_BEARER_TOKEN=至少32位随机字符串
BETTER_AUTH_SECRET=至少32位随机字符串
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ASSAY_DATABASE_PATH=data/assay.sqlite
```

Create a Google OAuth Web application and register this exact local redirect
URI:

```text
http://localhost:5173/api/auth/callback/google
```

The server automatically creates/migrates the SQLite file on startup. Better
Auth user, account, verification, and session records live in that database,
along with each user's private audit history. The browser stores only the
selected UI language; authentication uses an HttpOnly cookie and completed
audits are no longer written to `localStorage`.

The web client defaults to the same-origin development proxy, so an
`apps/web/.env` file is not required for `http://localhost:5173`. To make the
choice explicit, copy `apps/web/.env.example` and keep:

```dotenv
VITE_A2A_URL=same-origin
```

Start the A2A server and web workbench in two terminals:

```bash
mise exec -- bun run a2a:server
```

```bash
mise exec -- bun run --filter @assay/web dev
```

Open `http://localhost:5173`, sign in with Google, keep **Strategy** selected,
and submit:

The development server also listens on LAN and Tailscale interfaces. By
default (or with `VITE_A2A_URL=same-origin`), browser requests stay on the Vite origin and its
development proxy forwards Agent Card, A2A, capability, and health requests
to the server on `127.0.0.1:3001`. Direct browser clients may instead use
`VITE_A2A_URL=auto`; add every such workbench origin, including its scheme and
port, to the comma-separated `ASSAY_A2A_CORS_ORIGIN` allowlist.

> Audit a CSI 300 strategy from 20210101 through 20251231: rank by trailing
> 20-day momentum, hold the top 50 equal-weighted names, rebalance monthly at
> close, and use standard costs.

The workbench sends one text Part, displays Task status updates, supports
protocol-level cancellation, and polls the A2A server until completion. It
then renders the verdict, confidence, all five check cards, and the
collapsible full report. A missing, unmatched, or checksum-invalid local
package fails closed before any audit check; the server never falls back to
online retrieval or invented numbers. If required strategy details are absent, the result is presented as
a prominent early exit with its missing information and recovery conditions.

The server listens on port `3001`; discovery and health endpoints are
`http://127.0.0.1:3001/.well-known/agent-card.json` and
`http://127.0.0.1:3001/healthz`. The Agent Card currently advertises only
`audit_strategy`; Factor and Compare are visible as coming-soon modes and
cannot submit.

When `ASSAY_A2A_BEARER_TOKEN` is configured, both the HTTP+JSON and JSON-RPC
A2A endpoints require `Authorization: Bearer <token>`. Without this optional
token, the A2A transports are public so external Agent Card checkers can call
them. Better Auth remains scoped to browser authentication and private
per-user audit-history APIs. The public Agent Card advertises the Bearer
requirement without exposing the token itself.

## Model Configuration

The track mandates DeepSeek V4 Pro through Volcano Ark. The A2A server reads
`ARK_API_KEY`, `ARK_BASE_URL`, and `ARK_MODEL_DEEPSEEK`; the endpoint ID is
sent as the Responses API `model`. The standalone runtime CLI remains a
development path and reads `ASSAY_MODEL_PROVIDER`, `ASSAY_MODEL_ID`, and
`ASSAY_MODEL_API_KEY`/`DEEPSEEK_API_KEY`. Credentials must remain in
environment variables; local competition token material lives in the
git-ignored `reference/model-api-guide.md`.

## Current Security Boundary

- Every task creates an isolated oh-my-pi `Agent` instance, preventing conversation state from leaking across requests.
- Tools declare a `read`, `write`, or `exec` tier. Tools without a declaration are treated as `exec`.
- `read` is allowed by default. `write` and `exec` are denied unless the host approval callback explicitly allows them.
- Tool lifecycle events exclude arguments and results. Agent events include
  streamed text, final output, and errors, so hosts must treat them as
  sensitive and avoid persisting them by default.
- A run is capped at 19 minutes by default, below the track's 20-minute total response limit.

See [Agent Runtime Architecture](docs/architecture/RUNTIME.md) for the detailed
design and [Naming Conventions](docs/development/NAMING.md) for repository-wide
naming rules. See [Testing Standard](docs/development/TESTING.md) for unit and
integration test boundaries,
[Parallel Check E2E Test](docs/development/E2E_TESTING.md) for the opt-in
real-model fan-out test, and [Toolchain](docs/development/TOOLCHAIN.md) for
version and command policy.

## Disclaimer

Assay outputs are technical robustness checks of trading strategies, not
investment advice. All conclusions derive from historical data under stated
assumptions; the limits of each check (e.g. disclosure-deadline heuristics when
true announcement dates are unavailable) are declared inside every report.

## References

- [PandaAI AdventureX Track Brief](https://ncn9g4d5xvof.feishu.cn/docx/YYsadGRNYopqOVxLFFrcorJjnzd)
- [PandaAIQuant Data API Documentation](https://www.pandaaiquant.com/data-service/api-docs)
- [oh-my-pi Runtime Repository](https://github.com/can1357/oh-my-pi)
- [Official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)
- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
