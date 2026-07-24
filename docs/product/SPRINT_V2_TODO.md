# Sprint v2 vertical-slice TODO

This list records the deliberate shortcuts in the local 8-hour vertical slice.
It is not a D8/D9 contract or a claim that the shortcuts are production-safe.

## Current acceptance blocker

- The accepted saved demonstration still uses a deterministic flat-price
  synthetic cache. Its numbers prove wiring only and are not market evidence.
- A full real-data diagnostic completed against 216,577 factor/status rows
  covering 300 fixed-snapshot symbols and 727 trading dates from 2023-07-24
  through 2026-07-23. Parameter robustness returned `pass` with neighborhood
  Sharpe retention `1.035`; cost stress returned `pass_with_reservations` with
  pessimistic annual return `0.2429`.
- No real-data check returned `fail`. The other three checks are intentionally
  `insufficient_evidence`, so the predeclared fail-first rule cannot override
  them and the honest final verdict is `UNVERIFIABLE`. The failed acceptance
  run therefore did not overwrite the accepted synthetic evidence bundle.
- Do not tune thresholds or costs after observing this result. Post-sprint
  product design must either allow the no-fail/two-wired-check case to remain
  `UNVERIFIABLE`, or predeclare and implement a separate claim-reproduction
  check. The measured baseline Sharpe near `1.045` versus the input claim
  `1.9` is not parameter robustness or cost stress evidence.

## Replace the integration-only data

- Implemented: live cache construction joins `get_factor(close)` adjusted
  prices with `get_market_data(..., fields=["trade_status"])` into the canonical
  `date` / `symbol` / `adjClose` / `tradeStatus` panel consumed by the engine.
- Implemented: `tradeStatus == 0` is the only tradable state. Selected
  unavailable names are not rank-backfilled, execution-day unavailability
  leaves cash, and an already-held unavailable name remains locked.
- Implemented: classified transport failures use bounded retries. The v3
  builder requests factor data in seven-calendar-day horizontal windows and
  status data one trading day at a time, then persistently bisects failed
  windows/symbol sets so interrupted runs reuse completed fragments.
- Implemented: the engine's cache-miss path delegates to that same resumable
  builder; there is no second full-window download path with weaker retry
  semantics.
- Implemented: fragment identity binds dataset/schema version, the complete
  universe hash, request window, and exact symbol subset. Fragment and final
  cache publication are atomic.
- Replace the single end-date CSI 300 constituent snapshot with point-in-time
  membership. Until then, survivorship bias remains uncontrolled.
- Add explicit coverage checks for the PIT universe, requested dates, maximum
  signal lookback, and data cutoff.
- Add provider cutoff and content hashes to the cache manifest when the data
  source exposes a stable cutoff identity.

## Replace the minimal execution model

- Suspensions, delistings, and missing prices are currently forward-filled
  without replacement holdings. Limit-up/down, minimum commissions, capacity,
  and order-size impact are not modeled.
- The engine always uses the sprint's month-end signal and next-trading-day
  close execution convention.
- `annualTurnover` uses the sprint's initial-capital denominator.
- The pessimistic cost case is a fixed `1.5 × realistic` proxy. A numerical
  break-even cost multiplier is not yet returned.

## Close the evidence and runtime gaps

- `artifact:backtest/param-grid` and `artifact:backtest/cost-ladder` are fixed
  source-reference strings; there is no experiment registry or ownership
  validation in this slice.
- The production ArtifactStore remains in memory. Only the accepted local demo
  bundle is saved for sprint evidence.
- The parameter grid is hard-coded to 15 variants. Only parameter robustness
  and cost stress have tools; the other three checks intentionally return
  `insufficient_evidence`.
- The frozen canonical StrategySpec is bound by the host after tool-schema
  validation and checked against the frozen hash. The model submits only
  experiment kind and budget, and exactly one successful call is required.
- Fail-first currently maps any material `fail` directly to `RETIRE`.
  QUARANTINE recovery mapping is deferred.
- The intake applies a sprint-only trailing-three-year default and narrow
  normalization for CSI 300, momentum, and explicit percentage/Sharpe claims.
- Ark Responses compatibility disables OpenAI-only stream options and reasoning
  summaries. The runtime strips presentation wrappers around otherwise strict
  JSON, but does not repair invalid result fields.

## Deferred documentation

- Reconcile `BACKTESTER.md` and `STRATEGY_SPEC.md` with the code after the
  vertical slice. Do not adopt unimplemented `AuditPlan`, experiment registry,
  artifact persistence, extended check-result fields, or full D8/D9 semantics
  until their backlog items are implemented and tested.
