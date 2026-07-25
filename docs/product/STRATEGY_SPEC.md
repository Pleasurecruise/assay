# StrategySpec

> Status: implemented canonical input contract for `audit_strategy`.
>
> TypeScript validators in `packages/contracts` are authoritative.

## Scope

The current contract supports ranked equity-selection strategies with periodic
rebalancing. It does not execute caller-supplied Python or arbitrary code.
Unsupported input completes with an `UNVERIFIABLE` business Artifact before
data resolution.

The same canonical spec is used by intake, claim reproduction, the backtester,
all five checks, and final provenance.

## Shape

```ts
interface StrategySpec {
  specVersion: "1";
  universe: {
    index: string;
  };
  signal:
    | {
        kind: "template";
        template: "momentum" | "volatility" | "turnover_rate";
        params?: {
          window?: number;
          direction?: "high" | "low";
        };
      }
    | {
        kind: "library";
        factor: string;
        direction: "high" | "low";
      };
  selection: {
    topN: number;
    weighting?: "equal";
  };
  rebalance: {
    frequency: "weekly" | "monthly";
    at?: "close";
  };
  window: {
    start: string;
    end: string;
  };
  costs?: {
    model: "none" | "standard";
  };
  claims?: {
    annualReturn?: number;
    sharpe?: number;
    maxDrawdown?: number;
  };
}
```

Protocol fields use `camelCase`. Provider-specific preparation code converts
to `snake_case` only inside the Python boundary.

## Field Rules

### Universe

`universe.index` is normalized to a canonical market symbol. The implemented
local engine currently supports the registered CSI 300 case
(`000300.SH`). A descriptor cannot claim support for an unimplemented
universe.

### Signal

Template parameters are bounded and expanded deterministically. The default
momentum window is 20 trading days.

Library factors are accepted only when present in the host-provided verified
catalog. Model output cannot extend that catalog.

Formula strings, file payloads, and executable Python are outside the current
public contract.

### Selection

`topN` must stay inside the contract range and must be compatible with the
registered universe. Equal weighting is the only implemented weighting method
and is applied as a declared default.

### Rebalance

Weekly and monthly schedules are supported. `at` defaults to `close`.
Backtester execution timing is defined in [BACKTESTER.md](BACKTESTER.md).

### Window

Dates use `YYYYMMDD`. Dates must be real calendar dates, the end cannot exceed
the frozen provider cutoff, and the requested span cannot exceed five years.

When the natural-language input omits the whole window, the current vertical
slice applies a declared trailing-three-year default relative to
`ASSAY_DATA_AS_OF`. Partial or invalid windows are never repaired silently.

### Costs

The default is `standard`. Costs affect execution and claim reproduction but
do not affect local market-package identity.

### Claims

Claims are optional submitted performance statements. They are frozen into
the audited subject and reproduced before fan-out.

Claims are removed by `strategyForData` before computing `strategyKey`.
Changing only claims must select the same local package.

## Validation Outcomes

| Condition                            | Outcome                                   |
| ------------------------------------ | ----------------------------------------- |
| Complete supported spec              | Freeze and continue                       |
| Required field missing               | `UNVERIFIABLE / insufficient_information` |
| Unsupported signal or arbitrary code | `UNVERIFIABLE / unsupported_input`        |
| Invalid date or out-of-range value   | `UNVERIFIABLE` with all issues            |
| Valid spec but no local package      | Infrastructure failure, Task `FAILED`     |

Validation aggregates missing fields instead of stopping at the first issue.

## Canonicalization

The host:

1. normalizes supported symbols and enum values;
2. expands defaults;
3. rejects unknown fields;
4. serializes canonical JSON;
5. hashes the exact bytes;
6. deep-freezes the complete spec;
7. creates a claims-free data-planning projection.

The canonical bytes and hash are reused throughout the audit. Models and tools
cannot replace them.

## G01 Example

```json
{
  "specVersion": "1",
  "universe": {
    "index": "000300.SH"
  },
  "signal": {
    "kind": "template",
    "template": "momentum",
    "params": {
      "window": 20
    }
  },
  "selection": {
    "topN": 50,
    "weighting": "equal"
  },
  "rebalance": {
    "frequency": "monthly",
    "at": "close"
  },
  "window": {
    "start": "20230723",
    "end": "20260723"
  },
  "costs": {
    "model": "standard"
  },
  "claims": {
    "annualReturn": 0.18,
    "sharpe": 1.9
  }
}
```

## Versioning

`specVersion` changes only for incompatible contract changes. Adding a new
strategy family requires coordinated updates to:

- contract parsing and canonicalization;
- intake validation;
- data planning;
- local package descriptors;
- Python loaders and experiments;
- golden acceptance tests.
