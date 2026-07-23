# System Architecture

> 中文版：[ARCHITECTURE.md](ARCHITECTURE.md)
>
> Status: 🚧 draft skeleton, iterating with development. This document draws the "boxes" — which modules the system consists of, their responsibilities and dependencies; how things "flow" between them is in [PIPELINE_EN.md](PIPELINE_EN.md).

## 1. Module Overview

```
┌─────────────────────────────────────────────────────┐
│                    A2A Server                        │
│     (Agent Card hosting · task intake · Artifacts)   │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │     Intake      │  task parsing · audit plan · budget allocation
              └────────┬────────┘
                       │
    ┌──────┬──────┬────┴───┬──────────┬─────────┐
┌───▼──┐┌──▼───┐┌──▼───┐┌──▼──────┐┌──▼──────┐  │
│param ││data  ││cost  ││regime   ││homogen. │  │  five checks (parallel)
│robust││avail.││stress││depend.  ││& decay  │  │
└───┬──┘└──┬───┘└──┬───┘└──┬──────┘└──┬──────┘  │
    └──────┴──────┴────┬───┴──────────┘         │
              ┌────────▼────────┐               │
              │ Moiré x-validate│  contradiction detection · follow-up experiments
              └────────┬────────┘               │
              ┌────────▼────────┐               │
              │     Report      │  verdict · evidence pack · JSON Artifact
              └─────────────────┘               │
                                                │
   ┌────────────────┐   ┌────────────────┐     │
   │   Backtester   │   │   Data Layer   │ ←───┘ (called by the checks)
   │ own vectorized │   │ panda-data     │
   │ engine         │   │ wrapper · cache│
   └────────────────┘   │ · rate limiting│
                        └────────────────┘
```

## 2. Module Responsibilities

### A2A Server

- Hosts `/.well-known/agent-card.json`, exposing three Skills: `audit_strategy` / `audit_factor` / `compare_robustness`
- Accepts natural-language tasks, returns structured Artifacts (DataPart) + reports
- Stateless: each call closes its own loop, no reliance on A2A task persistence

### Intake

- Identifies strategy type, parameters, and data dependencies from natural language / factor expressions / code
- Produces the audit plan: which checks to dispatch and how many backtests each
  gets (the 18-minute operational budget is fixed here; the runtime hard cap is
  19 minutes)

### Checks (five)

Each check is an independent module with a uniform I/O contract:

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `param_robustness` | Variant matrix over parameter neighborhoods + shifted windows | Backtester |
| `data_availability` | Day-by-day verification of universe / tradability / financial timing | Data Layer |
| `cost_stress` | Cost-tier re-runs + turnover erosion + zero-return threshold | Backtester |
| `regime_dependency` | Regime partitioning + per-regime return stats | Backtester + Data Layer |
| `homogeneity_decay` | Correlation vs. factor library + yearly IC decay | Data Layer |

Uniform output: `{ check, conclusion: pass / pass-with-reservations / fail / insufficient-evidence, key numbers, confidence }`

### Moiré (cross-validation)

- Aggregates the five structured results and detects contradictions
- Designs discriminating follow-up experiments for contradictions (≤2 rounds), re-dispatching the relevant check modules
- Synthesizes conclusions; marks "insufficient evidence" when unresolved

### Backtester (own vectorized engine)

- Daily bars + adjustment factors, pandas-vectorized, milliseconds per variant
- Supports: parameterized rebalancing rules, cost tiers, regime slicing, point-in-time universes
- Reason to exist: the official backtest Skill's output contract is unpublished (see PROPOSAL §3)

### Data Layer

- panda-data interface wrapper (auth: `PANDA_DATA_USERNAME/PASSWORD` env vars)
- Shared query cache, bounded concurrency, backoff retries on 429/timeouts

### Report

- Human-readable report (Markdown: verdict table + per-check evidence + recovery conditions + stated limits)
- Machine-readable JSON (same content, returned as A2A DataPart)

## 3. Dependency Principles

- **Zero dependencies between checks** (parallel and independent; Moiré is the only convergence point)
- Checks depend only on the two infrastructure pieces: Backtester and Data Layer
- The LLM (DeepSeek V4 Pro) appears only in Intake (parsing), Moiré (experiment design), and Report (prose); every numeric conclusion comes from computation, never from the model

## 4. Product Modules → Repository Locations

The repository is bootstrapped as a Bun monorepo + Python services (see root README). Product modules map as follows:

| Product module (§1 diagram) | Repository location | Language | Status |
| --- | --- | --- | --- |
| A2A Server | `packages/` (A2A gateway, TBD) | TS | TBD |
| Intake | `packages/agents` (intake agent) | TS | TBD |
| Five checks | `packages/agents` (one agent per check, see §5) | TS | TBD |
| Moiré cross-validation | `packages/agents` (orchestrator) | TS | TBD |
| Report | `packages/agents` + `packages/contracts` (output contract) | TS | TBD |
| Backtester | `services/` side (Python, pandas-vectorized; same boundary principle as panda-adapter: DataFrames never cross the process boundary, output via Arrow/JSON contract) | Python | TBD |
| Data Layer | `services/panda-adapter` (bootstrapped) + `packages/finance-tools` (TS tool wrappers, TBD; tool list in `docs/architecture/DATA_ACCESS.md` Tool Roadmap) | Python + TS | Partial |

The runtime foundation (isolated Agent instance per task, read/write/exec tool tiers, audit events, 19-minute cap) is in `docs/architecture/RUNTIME.md` — its stateless and time-bounded design matches this proposal's engineering decisions.

## 5. Check ↔ Agent Mapping

Agent IDs follow the kebab-case rule in `docs/development/NAMING.md`:

| Check | Agent ID | Notes |
| --- | --- | --- |
| Intake | `intake` | Produces the audit plan and budget allocation |
| Parameter robustness | `param-robustness` | Variant-matrix backtests |
| Data availability | `data-availability` | Universe / tradability / financial timing verification |
| Transaction-cost stress | `cost-stress` | Cost tiers + turnover erosion |
| Regime dependency | `regime-dependency` | Per-regime return statistics |
| Homogeneity & decay | `homogeneity-decay` | Factor-library correlation + IC decay |
| Cross-validation | `moire-orchestrator` | Contradiction detection and follow-up experiment orchestration |

> Note: the bootstrap commit's `coordinator / market-researcher / risk-reviewer` are generic placeholders to be refactored per this table; `ASSAY_AGENT_ID` values update accordingly. Public A2A Skill names are unchanged: `audit_strategy` / `audit_factor` / `compare_robustness` (snake_case, per NAMING.md tool-ID rules).
