# Panda Adapter

This package owns Assay's Python data and quantitative-computation boundary.

The production A2A server does not initialize the PandaData SDK and does not
fetch market data online. It resolves an immutable local data package, passes
only its host-owned `dataRef` into this package, and runs deterministic
backtests, availability checks, homogeneity checks, and Moiré experiments
against that package.

The pinned `panda_data` dependency remains for offline package preparation and
adapter compatibility tests. Provider credentials are needed only for an
explicit preparation command such as `sdk:init`; they are not part of the
production A2A startup or request path.

Runtime and preparation data must not be mixed:

- immutable input packages live under `ASSAY_LOCAL_DATA_PACKAGE_ROOT`;
- task-scoped derived output lives under `ASSAY_AUDIT_OUTPUT_ROOT`;
- online provider clients may prepare packages but must never be registered as
  production Agent tools;
- a missing or invalid local package fails the audit Task and never triggers an
  online fallback.

Python subprocesses are launched through `uv run --project
services/panda-adapter` by default. `ASSAY_EXPERIMENT_PYTHON` is an optional
host override for an already-provisioned interpreter.
