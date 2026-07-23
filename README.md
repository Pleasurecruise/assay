# Assay

A multi-agent system for financial research. The current phase establishes an auditable and cancellable Agent Runtime that denies side-effecting tools by default. The A2A gateway, PandaData adapter, and complete research workflows will be built on top of this boundary.

## Technology

- Monorepo: Bun workspaces
- Toolchain management: mise (`latest` Bun, Node.js, Python, and uv)
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
  agents/            Financial agent definitions
services/
  panda-adapter/      Guarded Python boundary for the PandaData SDK
docs/
  architecture/      Architecture decisions and roadmap
  development/       Engineering conventions
```

## Getting Started

```bash
mise install
mise exec -- bun install
mise exec -- bun run sdk:sync
mise exec -- bun run check
```

Initialize PandaData before starting any service that uses market data:

```bash
copy .env.example .env
# Load the .env values into the process environment without printing them.
mise exec -- bun run sdk:init
```

Initialization fails closed when the SDK, credentials, or token exchange is
unavailable. See [PandaData Access Architecture](docs/architecture/DATA_ACCESS.md)
for the lifecycle and security boundary.

Run a request against a real model:

```bash
copy .env.example .env
mise exec -- bun run runtime -- "Analyze current market risks and identify the missing evidence."
```

`ASSAY_MODEL_PROVIDER` and `ASSAY_MODEL_ID` must resolve in the oh-my-pi model catalog. API keys are injected only through environment variables and never enter task payloads, events, or logs.

## Current Security Boundary

- Every task creates an isolated oh-my-pi `Agent` instance, preventing conversation state from leaking across requests.
- Tools declare a `read`, `write`, or `exec` tier. Tools without a declaration are treated as `exec`.
- `read` is allowed by default. `write` and `exec` are denied unless the host approval callback explicitly allows them.
- Events record only tool names, statuses, and call IDs. Tool arguments and credentials are excluded.
- A run is capped at 19 minutes by default, below the track's 20-minute total response limit.

See [Agent Runtime Architecture](docs/architecture/RUNTIME.md) for the detailed
design and [Naming Conventions](docs/development/NAMING.md) for repository-wide
naming rules.

## References

- [PandaAI AdventureX Track Brief](https://ncn9g4d5xvof.feishu.cn/docx/YYsadGRNYopqOVxLFFrcorJjnzd)
- [PandaAIQuant Data API Documentation](https://www.pandaaiquant.com/data-service/api-docs)
- [oh-my-pi Runtime Repository](https://github.com/can1357/oh-my-pi)
- [Official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)
