# Audit Pipeline

> 中文版：[PIPELINE.md](PIPELINE.md)
>
> Status: 🚧 draft skeleton, iterating with development. This document draws the "arrows" — the complete flow of one audit request from entry to return, its time budget, and degradation paths; the modules themselves are in [ARCHITECTURE_EN.md](ARCHITECTURE_EN.md).

## 1. End-to-End Timeline

The track hard limit is 20 minutes and the runtime hard cap is 19 minutes. The
table allocates an 18-minute operational budget, leaving one additional minute
for hard-stop handling and result delivery:

| Stage | Budget | Content | Parallelism |
| --- | --- | --- | --- |
| ① Intake | 1 min | Parse strategy → audit plan → backtest allocation | — |
| ② Five checks | 9–10 min | Each check independently fetches data, runs variants, emits structured results | 5-way parallel |
| ③ Cross-validation | 2–3 min | Contradiction detection → follow-up experiments (≤2) → synthesis | Experiments parallelizable |
| ④ Report | 2 min | Verdict + evidence pack + JSON Artifact | — |
| Reserve | 2 min | Network jitter, rate-limit retries | — |

Principle: backtest counts are **fixed at stage ①** within the budget — never run-until-done; any stage that overruns degrades per §4 and never returns empty-handed.

## 2. Data Flow

```
natural-language task
  │  ① Intake: LLM parsing
  ▼
CheckPlan { strategy profile, per-check variant quotas, data requirements }
  │  ② parallel dispatch
  ├─→ param robustness ──┐
  ├─→ data availability ─┤   each lane independently calls Data Layer / Backtester
  ├─→ cost stress ───────┼─→ CheckResult × 5
  ├─→ regime dependency ─┤   { conclusion, key numbers, confidence }
  └─→ homogeneity/decay ─┘
  │  ③ Moiré
  ▼
contradiction pairs → experiment design (LLM) → re-runs (computation) → synthesis
  │  ④ Report
  ▼
Verdict { five-level verdict, per-check detail, open questions,
          recovery conditions, stated limits }
  ├─→ Markdown report (human)
  └─→ JSON DataPart (A2A Artifact, machine)
```

## 3. Key Control Points

- **No cross-talk in stage ②**: the five checks cannot see each other's results, guaranteeing conclusion independence (the precondition for Moiré's validity)
- **LLM/computation boundary**: all numeric conclusions come from computation; the LLM only parses (①), designs experiments (③), and writes prose (④)
- **Caching**: identical data queries (e.g. the same bar range) are shared across checks and fetched once
- **Rate-limit handling**: the Data Layer owns bounded concurrency; 429/timeout → exponential backoff with finite retries

## 4. Degradation Paths

Under quota or time pressure, shrink in order — **reduce scale, never mechanisms**:

1. Variant count (30 → 15; coarser neighborhood granularity)
2. History span (5 years → 3 years)
3. Chart count (keep numeric tables)

Never cut (they are the product differentiation):

- All five checks, always (data unavailable → that check reports "insufficient evidence", never skipped)
- Moiré contradiction detection (follow-up experiments may drop from 2 to 1, never to 0)
- The `UNVERIFIABLE` refusal mechanism and stated limits

## 5. Failure & Edge Cases

| Case | Handling |
| --- | --- |
| Input cannot be parsed into a backtestable strategy | Return `UNVERIFIABLE` + list of missing information; never guess |
| A data interface is down for the whole run | Mark that check "insufficient evidence", others proceed, noted in report |
| A single check times out | Conclude partially from finished variants, discount confidence |
| Total time approaches 16 min | Skip unstarted follow-up experiments and enter reporting immediately |
| Same strategy re-submitted | Idempotent: cache hit returns the previous result |
