# Verdict and Artifact Specification

> Status: target public Artifact contract. The single-check contract and
> validator are implemented in `packages/contracts/src/audit-checks.ts`; the
> complete verdict Artifact and A2A gateway remain planned.

## 1. Single-Check Result

Every audit result includes all five canonical checks:

```ts
interface AuditCheckResult {
  id:
    | "param-robustness"
    | "data-availability"
    | "cost-stress"
    | "regime-dependency"
    | "homogeneity-decay";
  conclusion:
    "pass" | "pass_with_reservations" | "fail" | "insufficient_evidence" | "not_applicable";
  confidence: number | null;
  evidence: readonly CheckEvidence[];
  missingEvidence: readonly MissingEvidence[];
  refinedByMoire?: string;
}
```

| Conclusion               | Meaning                                              |
| ------------------------ | ---------------------------------------------------- |
| `pass`                   | No material defect was found in this dimension       |
| `pass_with_reservations` | Usable only with explicit conditions                 |
| `fail`                   | A reproducible material defect was found             |
| `insufficient_evidence`  | Required evidence is unavailable or unresolved       |
| `not_applicable`         | The active skill profile does not require this check, or the audit ended before execution (§4.1) |

Executed checks use confidence in `[0, 1]`. `not_applicable` uses null
confidence and empty evidence arrays.

Evidence:

```ts
interface CheckEvidence {
  metric: string;
  value: string | number | boolean;
  unit: string;
  sourceRefs: readonly string[];
}

interface MissingEvidence {
  requirement: string;
  reason: string;
  sourceRefs: readonly string[];
}
```

`pass`, `pass_with_reservations`, and `fail` require at least one reproducible
evidence item. `insufficient_evidence` requires at least one missing-evidence
item.

## 2. Verdict Scale

| Verdict        | Meaning                        | Typical trigger                             |
| -------------- | ------------------------------ | ------------------------------------------- |
| `KEEP`         | Continue use and monitor       | Every applicable check passes               |
| `WATCH`        | Use with tracked reservations  | At least one reserved pass and no failures  |
| `QUARANTINE`   | Pause and repair before review | A failure has a feasible recovery condition |
| `RETIRE`       | Stop using the core approach   | A material failure has no feasible recovery |
| `UNVERIFIABLE` | Refuse a strong conclusion     | Required input or evidence is unavailable   |

Deterministic rules:

1. An unparseable input or any required `insufficient_evidence` result yields
   `UNVERIFIABLE`.
2. An unresolved Moiré dispute that could change the verdict first converts
   affected required checks to `insufficient_evidence`.
3. If every failed check has a scoped recovery condition, return
   `QUARANTINE`.
4. If any failed check has no feasible recovery path, return `RETIRE`.
5. Otherwise, any `pass_with_reservations` yields `WATCH`.
6. Otherwise, all applicable checks pass and the verdict is `KEEP`.
7. `not_applicable` never participates in grading.

Overall confidence is the minimum confidence of applicable checks after Moiré
refinement. The LLM does not choose the verdict.

## 3. Human-Readable Report

The Markdown report has three sections:

1. **Verdict page:** verdict, confidence, concise rationale, and five-row check
   table.
2. **Evidence pages:** reproducible tables or plots for every applicable check.
3. **Appendix:** Moiré disputes, follow-ups, recovery conditions, review
   triggers, assumptions, limitations, provenance, and risk disclosure.

Avoid vague risk language. Every material statement should point to a metric,
source reference, or explicit missing-evidence record.

## 4. Structured Audit Artifact

The final A2A Artifact contains a structured data Part with this versioned
shape:

```json
{
  "schemaVersion": "1.0.0",
  "kind": "strategy_audit",
  "auditId": "audit_01",
  "generatedAt": "2026-07-23T12:00:00Z",
  "results": [
    {
      "subjectId": "strategy_01",
      "verdict": "QUARANTINE",
      "confidence": 0.8,
      "summary": "Corrected performance is lower and concentrated in trending regimes.",
      "checks": [
        {
          "id": "param-robustness",
          "conclusion": "fail",
          "confidence": 0.85,
          "evidence": [
            {
              "metric": "neighborhoodSharpeRetention",
              "value": 0.35,
              "unit": "ratio",
              "sourceRefs": ["artifact:backtest/parameter-grid"]
            }
          ],
          "missingEvidence": [],
          "refinedByMoire": "Fragility is concentrated in flat regimes."
        },
        {
          "id": "data-availability",
          "conclusion": "fail",
          "confidence": 0.9,
          "evidence": [
            {
              "metric": "futureConstituentCount",
              "value": 37,
              "unit": "count",
              "sourceRefs": ["dataset:panda-data/index-weights"]
            }
          ],
          "missingEvidence": []
        },
        {
          "id": "cost-stress",
          "conclusion": "pass_with_reservations",
          "confidence": 0.8,
          "evidence": [
            {
              "metric": "annualTurnover",
              "value": 12,
              "unit": "multiple",
              "sourceRefs": ["artifact:backtest/cost-stress"]
            }
          ],
          "missingEvidence": []
        },
        {
          "id": "regime-dependency",
          "conclusion": "pass_with_reservations",
          "confidence": 0.8,
          "evidence": [
            {
              "metric": "trendingRegimeReturnShare",
              "value": 1,
              "unit": "ratio",
              "sourceRefs": ["artifact:backtest/regime-split"]
            }
          ],
          "missingEvidence": []
        },
        {
          "id": "homogeneity-decay",
          "conclusion": "fail",
          "confidence": 0.85,
          "evidence": [
            {
              "metric": "libraryFactorCorrelation",
              "value": 0.93,
              "unit": "ratio",
              "sourceRefs": ["dataset:panda-data/factor-library"]
            }
          ],
          "missingEvidence": []
        }
      ],
      "moire": {
        "disputesOpened": 1,
        "resolved": ["Parameter fragility is concentrated in flat regimes."],
        "unresolved": []
      },
      "recoveryConditions": [
        {
          "scope": "data-availability",
          "condition": "Use point-in-time historical index constituents."
        },
        {
          "scope": "cost-stress",
          "condition": "Reduce turnover and rerun the complete cost curve."
        }
      ],
      "reviewTriggers": ["A new market regime or data revision appears."],
      "assumptionsAndLimits": ["Quarterly report availability uses statutory disclosure deadlines."]
    }
  ],
  "comparison": null,
  "riskDisclosure": [
    "This is a technical robustness audit, not investment advice or a return promise."
  ],
  "provenance": {
    "inputHash": "sha256:...",
    "dataAsOf": "2026-07-22",
    "dataSources": [
      {
        "id": "panda-data",
        "version": "0.0.12"
      }
    ],
    "codeRevision": "git-sha"
  },
  "nextReview": "After recovery conditions are implemented."
}
```

Contract rules:

- `schemaVersion` follows SemVer. Removing fields, changing meaning, or
  tightening an enum requires a major version.
- All top-level fields except `nextReview` are required.
- `riskDisclosure` is non-empty.
- `strategy_audit` and `factor_audit` contain exactly one result.
  `robustness_comparison` contains at least two.
- Every result lists all five canonical check IDs.
- Recovery scopes are a check ID, `intake`, or `evidence`.
- `comparison` is non-null only for `robustness_comparison` and contains a
  subject ranking plus evidence references.
- Provenance participates in the idempotency and cache key.
- A result with verdict `UNVERIFIABLE` and no executed checks must set
  `reasonCode` (§4.1); `reasonCode` is absent otherwise.
- Public JSON fields use camelCase, Agent IDs use kebab-case, enum values use
  snake_case, and verdicts use uppercase codes.

### 4.1 Early-Exit UNVERIFIABLE Results

Some audits terminate before any check executes: the input is outside the
supported strategy family, clarification is exhausted or expires, or verified
data coverage falls below the deterministic threshold
(A2A_SERVER §9.1). These early exits reuse **the same Artifact schema** — there
is no separate rejection document, and callers only ever parse one shape.

Shape rules for an early-exit result:

- `verdict` is `UNVERIFIABLE` and `confidence` is `null`;
- `checks` still lists all five canonical IDs, each with conclusion
  `not_applicable`, null confidence, and empty evidence arrays (exactly the
  shape `parseAuditCheckResult` already enforces);
- `reasonCode` is required and explains why nothing ran:

```ts
type EarlyExitReasonCode =
  | "unsupported_input"        // outside the supported strategy family
  | "insufficient_information" // caller declined or gave unusable answers
  | "clarification_expired"    // INPUT_REQUIRED wait exceeded policy
  | "coverage_too_narrow";     // effective window below the §9.1 threshold
```

- `missingInformation` (result-level, same `MissingEvidence` item shape)
  lists every unresolved requirement — per-check `missingEvidence` stays
  empty because `not_applicable` requires it;
- `retryWith` (optional) carries a machine-readable resubmission suggestion,
  e.g. the narrowed `StrategySpec` for `coverage_too_narrow`;
- `moire` reports zero disputes; `recoveryConditions` may use the existing
  `intake` scope; `riskDisclosure` remains mandatory.

A per-check `not_applicable` only means "this slot has no data"; the
result-level `reasonCode` is the single authoritative explanation. Compact
example:

```json
{
  "subjectId": "strategy_02",
  "verdict": "UNVERIFIABLE",
  "confidence": null,
  "summary": "The strategy uses custom Python code, which is outside the supported strategy family.",
  "reasonCode": "unsupported_input",
  "missingInformation": [
    {
      "requirement": "signal expressed as a library factor, template, or panda_factor formula",
      "reason": "arbitrary executable code cannot be audited",
      "sourceRefs": ["doc:STRATEGY_SPEC#signal"]
    }
  ],
  "checks": [
    { "id": "param-robustness", "conclusion": "not_applicable", "confidence": null, "evidence": [], "missingEvidence": [] },
    { "id": "data-availability", "conclusion": "not_applicable", "confidence": null, "evidence": [], "missingEvidence": [] },
    { "id": "cost-stress", "conclusion": "not_applicable", "confidence": null, "evidence": [], "missingEvidence": [] },
    { "id": "regime-dependency", "conclusion": "not_applicable", "confidence": null, "evidence": [], "missingEvidence": [] },
    { "id": "homogeneity-decay", "conclusion": "not_applicable", "confidence": null, "evidence": [], "missingEvidence": [] }
  ],
  "moire": { "disputesOpened": 0, "resolved": [], "unresolved": [] },
  "recoveryConditions": [
    { "scope": "intake", "condition": "Resubmit the signal as a template or library factor." }
  ],
  "reviewTriggers": [],
  "assumptionsAndLimits": []
}
```

## 5. A2A Delivery

Assay publishes one Artifact for the audit output, with:

- a structured data Part containing the versioned object above;
- optionally, a text Part containing the equivalent Markdown report.

Progress and clarification use Messages or task status updates. Final output
does not rely on Message history. The gateway must publish the Artifact before
marking the A2A Task completed.

## 6. Public Skills

- `audit_strategy`: one strategy, all five checks, `kind=strategy_audit`.
  **MVP — the only skill on the baseline Agent Card** (A2A_SERVER §22).
- `audit_factor`: one factor, profile-based checks, `kind=factor_audit`.
  **Post-MVP (stretch):** the check runner supports it, but the FactorSpec,
  envelope, and Intake path are not yet designed; schema reserved.
- `compare_robustness`: at least two same-kind subjects,
  `kind=robustness_comparison`; mixed kinds return `UNVERIFIABLE`.
  **Post-baseline (Polish phase per DEMO.md):** excluded from the
  implemented fan-out contract and from the 20-minute budget; schema
  reserved. Callers can compare two audit Artifacts client-side meanwhile.
