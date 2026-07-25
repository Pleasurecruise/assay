# Three Frozen Cases Online E2E

## Scope

`bun run e2e:checks` is the single final acceptance entry point. It performs
exactly one preparation-and-online suite:

```text
data:prepare
  → validate the canonical registry and its single data owner
  → materialize and validate three runtime packages
  → start one production A2A server
  → submit G01, then G02, then G03
  → write one accepted suite Artifact
```

Do not run `data:prepare`, start the A2A server, call Ark, replay V9, or refresh
a golden Artifact separately before this command. `e2e:checks` already owns the
required preparation and server lifecycle.

For every submitted natural-language request, the production path remains:

```text
natural language
  → Ark fills StrategySpec and claims
  → deterministic validation and freeze
  → claims-free DataPlan
  → strategyKey
  → unique local runtime package
  → one host-bound dataRef
  → Claim Reproduction
  → five audit checks
  → Moiré
  → verdict
  → AuditArtifact
```

The model never receives or selects a case label or `packageId`. `G01`, `G02`,
and `G03` are test-fixture labels only.

## Frozen cases

All three cases use the same evaluation window, CSI 300 point-in-time
membership, equal weighting, monthly close rebalancing, and the standard cost
model. Their data-relevant strategies and claims are frozen as follows:

| Label | Natural-language strategy                         | Claims                             | Runtime packageId                         |
| ----- | ------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| G01   | CSI 300; trailing 20-trading-day momentum; Top 50 | annual return `0.18`, Sharpe `1.9` | `csi300-momentum-20d-monthly-top50-equal` |
| G02   | CSI 300; trailing 14-trading-day momentum; Top 30 | annual return `0.60`, Sharpe `2.3` | `csi300-momentum-14d-monthly-top30-equal` |
| G03   | CSI 300; trailing 26-trading-day momentum; Top 70 | annual return `0.20`, Sharpe `0.9` | `csi300-momentum-26d-monthly-top70-equal` |

The exact natural-language inputs, also frozen in
`tests/e2e/src/golden-cases.ts`, are:

```text
G01: 沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9

G02: 请审计这套策略：2023-07-23 至 2026-07-23，在沪深 300 成分股中，每月底按过去 14 个交易日涨幅排序，买入前 30 只并等权持有。策略报告宣称年化收益 60%，夏普 2.3。

G03: 请独立复核：2023-07-23 至 2026-07-23，在沪深 300 成分股中，每月底按过去 26 个交易日涨幅排序，持有前 70 只，等权配置。管理人宣称年化收益 20%，夏普 0.9。
```

The corresponding strategy keys are:

| Label | strategyKey                                                               |
| ----- | ------------------------------------------------------------------------- |
| G01   | `sha256-a9d796047db6ccb208f3d82df70287afbb50ddca1fd544f67718155a4dc1bddb` |
| G02   | `sha256-9242fb1add11336293dd23983415e1493e25bdf924c06d04159b645b7f1c8195` |
| G03   | `sha256-15a2f8c08d6a7f1e2f8013d1c663c325cf9666b30a06a5d8382aefcfc99f21f9` |

Claims remain part of the audited `StrategySpec`, but are removed before the
`DataPlan` and `strategyKey` are produced. Changing claims alone must not
change package selection.

## Canonical registry and shared data

Git contains one physical copy of the reviewed market, PIT, and provenance
data. It does not contain one copy per case:

```text
data/packages/
├── README.md
├── registry.json
└── csi300-momentum-20d-monthly-top50-equal/
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

`registry.json` uses `assay-case-data-registry-v1`. Each claims-free binding
has exactly:

```text
packageId
sourceDataPackageId
dataPlan
```

All three bindings reference the same
`sourceDataPackageId=csi300-momentum-20d-monthly-top50-equal`. The source owns
the byte-exact 216,688-row equity panel, 37 point-in-time CSI 300 membership
snapshots, 112 promoted fallback-provenance files, and the preparation
evidence.

Historical-member daily prices, CSI 300 index daily prices, and comparator
factors remain explicitly degraded. Non-promoted payloads under
`provenance/incomplete-attempts/` are evidence only and never become runtime
datasets.

`data:install` validates this source once, then deterministically materializes
three independent ignored runtime packages:

```text
.cache/assay/local-packages/
├── csi300-momentum-14d-monthly-top30-equal/
├── csi300-momentum-20d-monthly-top50-equal/
└── csi300-momentum-26d-monthly-top70-equal/
```

Each runtime directory contains its own `manifest.json`, `market-data.csv`,
`audit-support/`, and `pit-membership/`. Runtime copies are generated under
`.cache`; they are not additional Git data owners.

The three runtime manifests have different `packageId`, `strategyKey`, and
manifest digest. Their underlying immutable boundaries must be identical:

| Boundary      | Shared checksum                                                           |
| ------------- | ------------------------------------------------------------------------- |
| marketData    | `sha256-27779f08aac594467eb16be723a2ac0e743042fddb078e4ca704ea6484dd9382` |
| auditSupport  | `sha256-d8018da42a6e8e4ddf074741b3ab55cda9e3e6040f6a448ac13903d7b9563886` |
| pitMembership | `sha256-8a5b143d9faeb18d49f73564a1ab5e84a628e1da975b83f57376b3bc1a27dc4a` |

Both the TypeScript resolver and Python audit loader read only the installed
runtime registry. Neither treats `data/packages/` as a runtime directory, and
neither falls back to online PandaData.

## One online suite lifecycle

The suite validates all three installed packages before starting the server.
It then creates one production A2A application and one listening server.

Using one client against that server, it submits the frozen natural-language
inputs strictly in this order:

```text
G01 task reaches COMPLETED and passes mechanism assertions
  → G02 task reaches COMPLETED and passes mechanism assertions
    → G03 task reaches COMPLETED and passes mechanism assertions
```

Only the natural-language text is sent. The label, expected strategy,
strategyKey, claims, and packageId stay on the test side as assertions.

There is no suite retry loop, and Ark parsing is configured for one attempt.
If sending, polling, task completion, Artifact extraction, or a mechanism
assertion fails, the exception stops the loop immediately. No later case is
submitted and Ark is not called again automatically. The acceptance timeline
records the failure stage, and the server is closed by the suite lifecycle.
The accepted suite Artifact is not written for a partial run.

## Environment

Load the root `.env` without printing it. The online suite requires:

```dotenv
ARK_API_KEY=...
ARK_MODEL_DEEPSEEK=...
ASSAY_CODE_REVISION=<the tested 40-character Git commit>
```

`ARK_BASE_URL` is optional and defaults to the configured Volcano Ark endpoint.
No PandaData credential is required because all audit data comes from the
installed local registry.

Python subprocesses use:

```text
services/panda-adapter/.venv/bin/python
```

The runtime registry is read-only. Task-scoped derived files are written under
`.cache/assay/audit-output`; diagnostics for an unaccepted candidate remain
under `.cache/assay/run-logs` and are not golden Artifacts.

## Run

Run the final acceptance once:

```bash
bun run e2e:checks
```

The command expands to `data:prepare` followed by the online Ark/A2A suite.
Do not pre-run its constituent stages as separate acceptance attempts.

On complete success, the sanitized suite result is written to:

```text
artifacts/v9/assay-golden-cases-run.json
```

The legacy single-case path `artifacts/v9/assay-real-data-run.json` is not
overwritten.

## Pass conditions

The command succeeds only when all of the following are true:

- the three natural-language inputs parse into their exact frozen strategies
  and separate claims;
- the three `strategyKey` values are distinct and match the frozen values;
- the three runtime `packageId` values are distinct and resolve from their
  claims-free `DataPlan`;
- all three runtime packages expose the same market, audit-support, and PIT
  checksums while retaining different manifest identities;
- claims-only changes resolve to the same package;
- an unregistered strategy is rejected and cannot select a fallback package;
- each case completes Claim Reproduction with its own claims;
- each case executes all five audit checks against its host-bound `dataRef`;
- each case completes Moiré and the existing verdict derivation;
- all three A2A tasks reach `COMPLETED` with valid `AuditArtifact` values;
- the cases complete in frozen G01, G02, G03 order within one server lifecycle;
- one `assay-v9-golden-case-suite-v1` Artifact is persisted at the suite path.

Do not paste `.env`, provider responses, local absolute paths, or Ark
credentials into reports.
