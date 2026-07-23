# Parallel Check E2E Test

## 1. Scope

The opt-in E2E test covers:

```text
real model provider
  → AgentRuntime
  → five fresh oh-my-pi Agents
  → concurrent fan-out
  → strict branch JSON validation
  → ParallelAuditChecksResult
```

It does not yet cover PandaData, the Backtester, Intake, Moiré, reporting, or
the A2A gateway because those tool and orchestration layers are not
implemented.

With no data or backtest tools registered, an honest run returns
`insufficient_evidence` from all five branches. A conclusive result would
indicate unsupported model-generated evidence and fails the test.

## 2. Environment

Bun loads the root `.env` automatically. Copy the template:

```bash
cp .env.example .env
```

Minimum development configuration:

```dotenv
ASSAY_MODEL_PROVIDER=deepseek
ASSAY_MODEL_ID=deepseek-chat
ASSAY_MODEL_API_KEY=replace_with_a_real_key

ASSAY_E2E_TIMEOUT_MS=120000
ASSAY_E2E_AUDIT_ID=e2e_parallel_checks
ASSAY_E2E_SUBJECT_ID=e2e_strategy
ASSAY_E2E_INPUT=CSI 300 monthly momentum: rank by trailing 20-day return, hold the top 50 equal-weighted names, and rebalance monthly.
```

`DEEPSEEK_API_KEY` may replace `ASSAY_MODEL_API_KEY` when the provider is
`deepseek`.

`ARK_API_KEY`, `ARK_BASE_URL`, and `ARK_MODEL_DEEPSEEK` are reserved but not
wired into the model adapter. They do not currently enable a competition Ark
E2E run.

## 3. Run

Install workspace links once:

```bash
bun install
```

Then run:

```bash
bun run e2e:checks
```

This command makes five concurrent paid model requests. It is intentionally
excluded from `bun run check`.

## 4. Pass Conditions

The command exits with zero only when:

- all five canonical Agent IDs start and complete;
- every model response is valid contract JSON for its assigned Agent ID;
- no branch is replaced by the host runtime-error fallback;
- every branch honestly returns `insufficient_evidence`;
- the batch contains the canonical five-result order.

The command prints branch lifecycle lines to stderr and the final structured
result to stdout. `fanOutSpreadMs` is diagnostic only; deterministic unit tests
prove concurrency with a barrier and do not rely on network timing.

## 5. Failure Guide

| Error                                 | Meaning                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| Missing API key                       | `.env` was not loaded or the key is empty                      |
| Model not present in catalog          | Provider and model ID do not match the pinned oh-my-pi catalog |
| Branch failed before valid JSON       | Provider error, timeout, malformed JSON, or wrong Agent ID     |
| Unexpected conclusive result          | A tool-free Agent invented evidence or violated its guardrails |
| Fewer than five starts or completions | Runtime fan-out or lifecycle event regression                  |

Do not paste complete provider responses or `.env` contents into issues. Redact
keys and potentially sensitive strategy input.
