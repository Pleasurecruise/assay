# Local Golden Package E2E

## Scope

`bun run e2e:checks` runs the golden input through the production A2A path:

```text
natural-language strategy
  → Ark StrategyIntake
  → data-relevant DataPlan
  → deterministic local package resolution
  → one host-bound dataRef
  → Claim Reproduction
  → five checks
  → Moiré
  → deriveVerdict
  → AuditArtifact
```

The input is:

```text
沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9
```

The market, PIT, and V9 inputs are the prebuilt G01 golden package under
`.cache/assay`. The E2E makes a real Ark model call but does not call PandaData
at runtime. It is opt-in and is not part of the ordinary unit-test command.

## Environment

Load the root `.env` without printing it. The online test requires:

```dotenv
ARK_API_KEY=...
ARK_MODEL_DEEPSEEK=...
ASSAY_CODE_REVISION=...
ASSAY_DATA_AS_OF=2026-07-23
ASSAY_LOCAL_DATA_PACKAGE_ROOT=.cache/assay
ASSAY_AUDIT_OUTPUT_ROOT=.cache/assay/audit-output
```

Before the A2A server starts, the E2E validates the existing V9 cache and writes
only the small descriptor:

```text
.cache/assay/local-packages/g01-csi300-momentum.json
```

The descriptor binds the existing market CSV, V9 manifest, and immutable CSI
300 PIT snapshot tree by checksum. The E2E does not copy, download, or rewrite
the market data. `ASSAY_AUDIT_OUTPUT_ROOT` is the separate writable location
for task-scoped derived artifacts.

The Python executable may be pinned with:

```dotenv
ASSAY_EXPERIMENT_PYTHON=services/panda-adapter/.venv/bin/python
```

## Run

```bash
bun run e2e:checks
```

On success, the sanitized result is written to:

```text
artifacts/v9/assay-real-data-run.json
```

## Pass conditions

The command succeeds only when:

- the golden sentence is parsed into the expected strategy and claims;
- the data-relevant strategy produces the registered G01 `strategyKey`;
- local package resolution runs after Intake and before every audit stage;
- all three descriptor checksums are verified before the package is bound;
- the Artifact records the frozen package's original PandaData provenance;
- Claim Reproduction receives `18%` and `1.9`;
- all five checks execute against the same host-bound `dataRef`;
- Moiré and the existing verdict path complete;
- the A2A task reaches `COMPLETED` with a valid `AuditArtifact`.

No PandaData credentials are required. Do not paste `.env`, provider
responses, local absolute paths, or Ark credentials into reports.
