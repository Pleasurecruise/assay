# Canonical Local Data Registry

This directory has two separate responsibilities:

- `registry.json` binds a claims-free `DataPlan` and semantic runtime
  `packageId` to a canonical source package.
- `csi300-momentum-20d-monthly-top50-equal/` owns the single committed copy of
  the CSI 300 market panel, point-in-time membership, audit-support provenance,
  and its integrity manifest.

The source directory name is retained for compatibility with the original
canonical package. It is a data owner, not a runtime routing shortcut.
`data:install` validates the source once and deterministically materializes one
independent runtime directory per binding under
`.cache/assay/local-packages/<packageId>/`.

Runtime selection is always:

```text
natural language
  -> frozen StrategySpec and separate claims
  -> claims-free DataPlan
  -> strategyKey
  -> unique runtime package
```

The registry must never contain case labels, claims, execution costs, raw
natural-language aliases, or a fallback package. Every binding has exactly
`packageId`, `sourceDataPackageId`, and `dataPlan`.

Do not duplicate `equity-daily.csv`, the PIT tree, or provenance for another
binding. Generated runtime copies belong only in `.cache/` and are not
committed.

## Shared source boundary

The source package contains the complete reviewed inputs; they are not sampled,
aggregated, or compressed for Git:

- the byte-exact 216,688-row equity daily panel;
- 37 point-in-time CSI 300 membership snapshots;
- all 112 promoted fallback-provenance files;
- the source summary and promoted preparation report.

Historical-member daily prices, CSI 300 index daily prices, and comparator
factors remain explicitly `degraded` because no complete verified dataset was
promoted. A degraded dataset has `path: null` and no placeholder under
`datasets/`.

Provider payloads that were incomplete remain only under
`provenance/incomplete-attempts/`; they are verified provenance, not runtime
inputs. Download parts, request-splitting state, tool caches, logs, derived
backtest contexts, and temporary outputs remain under `.cache/assay` and are
not versioned.

## Build and install

Install and semantically validate all three generated runtime packages with:

```bash
bun run data:prepare
```

Maintainers can rebuild the shared source and deterministic registry from
reviewed provider caches with `bun run data:package`, or refresh the provider
caches first with `bun run data:rebuild`.
