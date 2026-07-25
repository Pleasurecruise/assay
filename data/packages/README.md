# Complete case data packages

This directory contains the versioned, case-level data inputs used to build
Assay's ignored runtime registry. The datasets are not sampled, aggregated, or
compressed for Git.

The current package,
`csi300-momentum-20d-monthly-top50-equal`, contains:

- the byte-exact 216,688-row equity daily panel used by the audit;
- 37 point-in-time CSI 300 membership snapshots;
- all 112 promoted fallback-provenance files;
- a source summary and the full promoted preparation report.

The package manifest records the current data boundary honestly. Historical
member daily prices, CSI 300 index daily prices, and comparator factors are
still `degraded` because no complete, verified dataset was promoted for those
inputs. A degraded dataset has `path: null`; it must not be represented by a
placeholder file under `datasets/`.

Real provider payloads that were never complete enough to promote are retained
only under `provenance/incomplete-attempts/`: 366 historical-member fragments
and four comparator-factor payloads. Their manifest records why they are not
runtime-eligible. Request-splitting records, download parts, resumable request
state, tool caches, run logs, derived backtest contexts, and temporary outputs
remain under `.cache/assay` and are not versioned.

Install and semantically validate the runtime copy with:

```bash
bun run data:prepare
```

This produces `.cache/assay/local-packages/`. The A2A resolver and Python audit
loader read only that generated runtime registry.

Maintainers can rebuild the committed case package from reviewed provider
caches with `bun run data:package`, or refresh those caches and rebuild with
`bun run data:rebuild`.
