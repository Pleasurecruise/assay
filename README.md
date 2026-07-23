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

The current implementation includes the runtime foundation, five isolated
audit-agent definitions, their typed parallel fan-out boundary, and the
PandaData-adapter foundation. Data and backtest tools, Intake, Moiré
orchestration, reporting, and the A2A gateway remain roadmap items documented
under `docs/product/`.

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
  runtime-cli/       Local runtime smoke-test entry point
packages/
  contracts/         Stable contracts shared by runtime, A2A, and tool layers
  agent-runtime/     oh-my-pi adapter, agent registry, audit events, and tool policy
  agents/            Five audit agents and the typed parallel Main-Agent boundary
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

Initialize PandaData before starting any service that uses market data:

```bash
cp .env.example .env
# Load the .env values into the process environment without printing them.
mise exec -- bun run sdk:init
```

Initialization fails closed when the SDK, credentials, or token exchange is
unavailable. See [PandaData Access Architecture](docs/architecture/DATA_ACCESS.md)
for the lifecycle and security boundary.

Run a request against a real model:

```bash
cp .env.example .env
mise exec -- bun run runtime -- "Audit this momentum strategy: CSI300 universe, top-50 by 20-day return, monthly rebalance."
```

## Model Configuration

The track mandates DeepSeek V4 Pro through Volcano Ark. The current CLI reads
only `ASSAY_MODEL_PROVIDER`, `ASSAY_MODEL_ID`, and
`ASSAY_MODEL_API_KEY`/`DEEPSEEK_API_KEY`; it does **not** yet read the `ARK_*`
variables listed as reserved target configuration in `.env.example`. Wiring
the Ark endpoint into the model adapter is therefore a blocking roadmap item,
and the generic DeepSeek provider is development-only. Credentials must remain
in environment variables; local competition token material lives in the
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
