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

The test submits the equivalent of:

```text
For the CSI 300, buy the 50 stocks with the highest trailing 20-day return at
each month end, weight them equally, and audit the claimed 18% annual return
and 1.9 Sharpe.
```

The repository commits the complete registered case package under
`data/packages/<semantic-package-id>/`. Its equity history is real,
uncompressed, and unsampled: 216,688 rows, 300 stocks, and 727 trading days
(about 7.2 MiB). The package also contains 37 point-in-time CSI 300 membership
snapshots and 112 fallback provenance records.

The canonical Git tree is:

```text
data/packages/csi300-momentum-20d-monthly-top50-equal/
├── manifest.json
├── datasets/
│   ├── equity-daily.csv
│   └── index-membership/000300.SH/
└── provenance/
    ├── source-summary.json
    ├── fallback-records/
    ├── incomplete-attempts/
    └── preparation-report.json
```

`bun run e2e:checks` runs `data:prepare` before the online flow, so a fresh
checkout does not need a separate manual installation step. `data:install`
verifies the complete canonical package, then deterministically converts it
into the existing runtime layout and manifest at
`.cache/assay/local-packages/<semantic-package-id>/`. `data:validate` then runs
the offline Python semantic validation against the generated runtime package.
`data:prepare` is the ordinary setup alias for
`data:install && data:validate`. The E2E makes a real Ark model call but does
not call PandaData at runtime. It is opt-in and is not part of the ordinary
unit-test command.

Run `bun run data:prepare` independently before a deployment or direct A2A
server start. Maintainer-only `data:rebuild` expands to
`data:base && data:audit-support && data:package && data:prepare`. If provider
caches already exist, `data:package` rebuilds only the complete case package; run
`data:prepare` afterward to install and validate it. The resumable workspace
stays under `.cache/assay`, which is never committed.

## Environment

Load the root `.env` without printing it. The online test requires:

```dotenv
ARK_API_KEY=...
ARK_MODEL_DEEPSEEK=...
ASSAY_CODE_REVISION=...
ASSAY_DATA_AS_OF=2026-07-23
ASSAY_LOCAL_DATA_PACKAGE_ROOT=.cache/assay/local-packages
ASSAY_AUDIT_OUTPUT_ROOT=.cache/assay/audit-output
```

`ASSAY_LOCAL_DATA_PACKAGE_ROOT` already defaults to
`.cache/assay/local-packages`, so that line is optional. Before the A2A server
starts, the E2E loads and validates the installed semantic package without
rewriting it:

```text
.cache/assay/local-packages/
└── csi300-momentum-20d-monthly-top50-equal/
    ├── manifest.json
    ├── market-data.csv
    ├── audit-support/
    │   ├── manifest.json
    │   └── fallback-provenance/
    └── pit-membership/
        └── index-weights/
            └── 000300_SH/
```

The canonical manifest freezes the complete equity file, the whole membership
tree, and every declared provenance descriptor by integrity value. It also records
`historical-member-daily`, `index-daily`, and `comparator-factors` as
`status: degraded` with `path: null`, because formally verifiable data for
those datasets has not been obtained. The package must not invent placeholder
files under `datasets/`.

`provenance/incomplete-attempts/` retains only genuine, non-promoted payload:
366 historical-member files covering 25 of 79 missing stocks, and four
comparator payload files containing 33 rows for one date. Index-daily produced
no payload. These records remain provenance only; the manifest paths stay
`null`, and neither resolver nor audit loader may treat them as dataset input.

Installation validates those canonical bytes before converting the equity
file, membership tree, fallback records, and preparation report. The generated
runtime package deliberately omits canonical-only
`provenance/source-summary.json` and `provenance/incomplete-attempts/`.

Runtime resolution is a separate check: the runtime manifest binds
`marketData`, the entire `auditSupport` tree, and the entire `pitMembership`
tree. All three boundaries must verify before a `dataRef` is created.

Both the A2A resolver and Python audit loader are pointed at this installed
registry. Neither treats `data/packages/` as a runtime directory.

The package is read-only during E2E execution. `.cache/assay` is never
committed; only parts, checkpoints, request splits, tooling and uv caches, run
logs, temporary outputs, and derived host-corrected data remain outside the
complete Git package. In particular, the comparator attempt's eleven
`.split.json` request files and all `.parts` files are excluded.
`ASSAY_AUDIT_OUTPUT_ROOT` is the separate writable location for task-scoped
derived artifacts.

Python subprocesses use `uv run --project services/panda-adapter` by default on
every platform. A specific interpreter may still be pinned when needed:

```dotenv
# Windows
ASSAY_EXPERIMENT_PYTHON=services/panda-adapter/.venv/Scripts/python.exe
# Linux/macOS
# ASSAY_EXPERIMENT_PYTHON=services/panda-adapter/.venv/bin/python
```

## Run

```bash
bun run e2e:checks
```

The command first runs `data:prepare` (`data:install && data:validate`), then
starts the online Ark/A2A acceptance flow.

On success, the sanitized result is written to:

```text
artifacts/v9/assay-real-data-run.json
```

## Pass conditions

The command succeeds only when:

- the golden sentence is parsed into the expected strategy and claims;
- the data-relevant strategy produces the `strategyKey` registered by the
  semantic package;
- local package resolution runs after Intake and before every audit stage;
- all three package-manifest checksums are verified before the package is bound;
- the Artifact records the frozen package's original PandaData provenance;
- Claim Reproduction receives `18%` and `1.9`;
- all five checks execute against the same host-bound `dataRef`;
- Moiré and the existing verdict path complete;
- the A2A task reaches `COMPLETED` with a valid `AuditArtifact`.

No PandaData credentials are required. Do not paste `.env`, provider
responses, local absolute paths, or Ark credentials into reports.

`G01` is only the test-case label for this input and its expected result. It is
not part of the runtime identity; the package ID is the semantic
`csi300-momentum-20d-monthly-top50-equal`.
