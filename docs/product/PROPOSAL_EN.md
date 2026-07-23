# Assay + Moiré Protocol — PandaAI Track Proposal

> 中文版：[PROPOSAL.md](PROPOSAL.md)
>
> Status: converged (updated 2026-07-23); check items may be fine-tuned after the open questions in §8 are confirmed on site.
> Track brief: [PandaAI 7.22 ADVX Track](<../../reference/track-brief/track-brief.md>) · Data docs: [PandaAI Data API](https://www.pandaaiquant.com/data-service/api-docs?api=data_overview)

## Contents

1. [Overview](#1-overview) — what it is, why this direction
2. [Track Constraints & Scoring Map](#2-track-constraints--scoring-map)
3. [Data Capability Verification](#3-data-capability-verification) — which interfaces are usable, which are missing
4. [Check Catalogue](#4-check-catalogue) — what each of the five audits examines
5. [Workflow & Verdict Scale](#5-workflow--verdict-scale)
6. [Worked Example](#6-worked-example) — one audit from input to output
7. [Key Engineering Decisions](#7-key-engineering-decisions)
8. [Questions to Confirm On Site](#8-questions-to-confirm-on-site)
9. [Demo Design](#9-demo-design)
10. [Public A2A Skills](#10-public-a2a-skills)
11. [Naming](#11-naming)
12. [Development & Security Notes](#12-development--security-notes)
13. [Reference Links](#13-reference-links)

## 1. Overview

> **Assay — a strategy-credibility audit agent**
> While everyone builds agents that *discover* alpha, we build the touchstone that verifies whether alpha is real. Given a strategy or factor, five independent checks run in parallel, the **Moiré Protocol** cross-validation layer resolves contradictions between their conclusions, and the system outputs a five-level usage recommendation + reproducible numeric evidence + recovery conditions.

One-line positioning: everyone is mining for gold — we sell the assay (Assay); and the assaying method is mutual corroboration between independent checks (Moiré).

Why this direction:

- **Avoid the crowd.** The six official track directions (factor mining, strategy generation, research assistants, portfolio management, multi-agent pipelines) will be the most congested lanes on site, and everyone shares the same official Skills, so outputs converge. Everyone produces answers; nobody verifies them.
- **Fit the scoring.** The four things judges actually score — closing the loop on a complex task, real multi-agent collaboration ("not merely sequential chaining"), full use of platform data and Skills, and "a product never seen before that we believe will exist" — are each addressed head-on (see §2).
- **Compliance for free.** The track's compliance clauses (no return claims, no investment advice, mandatory risk disclosure) are shackles for profit-pitching strategy agents — and a product description for an audit product.
- **No bets on unverified data.** Every check relies only on interfaces verified to exist (§3); any on-site data gap affects a single sub-check, never the product.

## 2. Track Constraints & Scoring Map

Hard constraints:

- Submit as an **A2A Remote Agent**: self-hosted service + publicly accessible Agent Card URL, online throughout judging;
- Base model fixed to **DeepSeek V4 Pro**;
- Total response time per task **≤ 20 minutes**;
- Handle natural-language tasks; process and results must be clear and explainable;
- Submission includes ≥3 example tasks, documentation, a demo video, and the list of Skills used.

Scoring map:

| Judges look for | Our answer |
| --- | --- |
| A complex task completed, not a chat | Strategy in → 30+ variant backtests + day-by-day verification → structured verdict; a clear closed loop |
| Collaboration, not sequential chaining | Checks run independently with no cross-talk; contradictions trigger follow-up experiments; conclusions are synthesized from experiments, not votes (§5) |
| Full use of data & Skills | Market data / adjustment factors / index weights / tradable lists / ST status / factor library / trade calendar all in play (§4) |
| A product never seen before | The only verification-layer (vs. production-layer) entry on site; the demo can expose a fake alpha live |

## 3. Data Capability Verification

Verified on 2026-07-23. Method: the official doc pages (`?id=xx`) are JS-rendered and unreadable programmatically, so three independent evidence sources were cross-checked instead — the official GitHub `panda-data` repository (the implementation behind the competition data Skills; 38 method signatures are the de-facto contract), official community article 1163 ("Supported Skills / Data Interfaces"), article 117 ("Workflow & Strategy Help"), and the A2A specification.

**Verified available (our foundation):**

- `get_market_data` daily bars (5-year cap), `get_market_min_data` minute bars, `get_adj_factor` adjustment factors;
- `get_index_weights`: start/end dates required — historical index membership and weights at any point in time;
- `get_trade_list`: tradable roster by date; `get_stock_status_change`: ST status transitions;
- Trade calendar family: `get_trade_cal` / `get_prev_trade_date` / `get_last_trade_date`;
- `get_factor`: platform factor library (`start_date, end_date, factors, symbol, index_component, type`);
- `get_fina_reports`: quarterly financials; `is_latest=False` returns every disclosed version per symbol+quarter;
- Auth: environment variables `PANDA_DATA_USERNAME` / `PANDA_DATA_PASSWORD`.

**Verified missing or unreliable (designed around):**

- Financial data has **no announcement/disclosure-date** parameter or field (dates are converted to report-period quarters) → the financial-availability sub-check falls back to statutory disclosure-deadline heuristics;
- Industry constituents carry **inclusion dates but no exclusion dates**, and no date-range query;
- The backtest Skill's **output contract is unpublished** (the open-source result node returns only a `task_id`) → we build our own vectorized backtester (§7);
- Fund performance/style interfaces do not exist at the Skill layer; portfolio management accepts no custom holdings;
- A2A task persistence is implementation-defined → the whole flow closes in a single call, no cross-task state;
- Rate limits exist but no numbers are published → bounded parallelism + caching + backoff (§7).

## 4. Check Catalogue

| Check | Question it answers | Data sources (all verified) | Feasibility |
| --- | --- | --- | --- |
| Parameter robustness | Do returns come from the strategy's logic, or did this parameter set just get lucky historically? | Own vectorized backtester + `get_market_data` + `get_adj_factor`; variant matrix over parameter neighborhoods and shifted windows | ✅ Feasible |
| Data availability | Was every piece of information actually knowable at the time it was used? | Universe check: `get_index_weights` history; tradability: `get_trade_list` / `get_stock_status_change`; financials: disclosure-deadline heuristic + `is_latest` versions | ⚠️ Degraded but usable; full announcement-date check if §8 Q1 passes |
| Transaction-cost stress | How much survives realistic trading costs? At what cost level do returns hit zero? | Backtester cost tiers (standard fees, market impact, pessimistic) + turnover analysis | ✅ Feasible |
| Regime dependency | Do returns come from all market environments, or one special stretch? | Market/index data partitioned into regimes (volatility/trend/size, look-ahead-free) → per-regime return stats | ✅ Feasible (strongest data foundation) |
| Homogeneity & decay | Is this signal new, or a widely-used one already fading? | `get_factor` library + own correlation and year-over-year IC/RankIC decay | ✅ Feasible |
| Cross-validation (Moiré) | When check conclusions contradict, what finer structure explains it? | Zero data dependency; pure orchestration | ✅ Feasible (≤2 follow-up experiments) |

## 5. Workflow & Verdict Scale

```
Input: strategy/factor (natural language, factor expression, or code)
  ↓
① Intake: identify strategy type and data needs → audit plan,
   allocate backtest counts per check within an 18-minute operational budget
   (19-minute runtime hard cap)
  ↓
② Five checks run in parallel, independently (no cross-talk), each returning:
   { check, conclusion: pass / pass-with-reservations / fail / insufficient-evidence,
     key numbers, confidence }
  ↓
③ Cross-validation (Moiré):
   consistent conclusions → adopt directly;
   contradiction → design one experiment that discriminates between the two
   explanations (e.g. "re-run parameter perturbation split by regime"),
   synthesize a more precise conclusion from its result;
   still unresolved → mark "insufficient evidence" and report it as-is
  ↓
④ Output: five-level recommendation + per-check evidence + open questions
   + recovery conditions + risk disclosure
```

Verdict Scale: `KEEP / WATCH / QUARANTINE / RETIRE / UNVERIFIABLE`. Every level ships with upgrade conditions — the output is a conditional health report, not a one-shot death sentence. `UNVERIFIABLE` means refusing a strong conclusion when key evidence is missing; the demo must show it at least once, proving the system does not exist to manufacture dramatic verdicts.

## 6. Worked Example

One audit traced from input to output.

**Input task:**

> "Strategy: within CSI 300 constituents, at each month-end buy the 50 stocks with the largest 20-day gains, hold equal-weighted for one month. 2021–2025 backtest: 18% annualized, Sharpe 1.9. Assess whether this result is credible."

**The five checks in action:**

1. **Parameter robustness**: momentum windows 14/17/20/23/26 days, holdings 30–70 stocks, start date shifted ±6 months — ~30 backtests. Result: Sharpe 1.9 at the original parameters, 0.7 at 17 days, 0.5 at 23 days, 0.6 with the start moved 6 months earlier — the neighborhood averages only 35% of the peak; the parameters were almost certainly cherry-picked from history. **Conclusion: fail.**
2. **Data availability**: rebalance-day-by-day verification finds the strategy applied the 2025 CSI 300 roster back to 2021 — 37 stocks weren't in the index yet (survivorship bias). Re-running with the true point-in-time membership from `get_index_weights`: 18% → 13.8% annualized. **Conclusion: fail, corrected figures attached.**
3. **Transaction costs**: ~12× annual turnover. Cost tiers: no-cost 18% → standard fees 14.1% → with market impact 9.8% → pessimistic 6.2%; returns hit zero at 2.9× standard fees. **Conclusion: pass with reservations — the strategy isn't dead, but the realistic expectation is ~10%.**
4. **Regime dependency**: partitioned by volatility/trend/size and grouped: trending-up months +34% annualized, sideways months −2%, down months −8% — all returns come from the ~40% of time in trending regimes. **Conclusion: pass with reservations, must be labeled trend-dependent.**
5. **Homogeneity & decay**: correlation 0.93 with the library's standard momentum factor (not a new signal); IC decayed from 0.05 (2021) to 0.018 (2025) — over 60% of predictive power lost in five years. **Conclusion: fail.**

**Cross-validation, live:** Check 1 says the parameters are fragile; Check 4 says the strategy is stable in trending markets — a contradiction. Follow-up experiment "parameter perturbation split by regime": in trending markets all parameter variants hold Sharpe 1.2–1.6 (robust); in sideways markets they swing from −0.1 to −1.3 (extremely sensitive). Synthesized conclusion: **the parameter fragility exists only in sideways regimes** — more precise than either check alone, and it hands the user a concrete stop-use condition.

**Final output** (report + identical structured JSON via A2A Artifact):

> **Overall verdict: QUARANTINE (confidence 0.8)**
> Claimed 18% annualized; after correction and stress testing the reasonable expectation is 8–10%, valid only in trending regimes.
>
> | Check | Conclusion | Key numbers |
> | --- | --- | --- |
> | Parameter robustness | Fail | Neighborhood Sharpe only 35% of peak (refined: fragile only in sideways regimes) |
> | Data availability | Fail | 37 future constituents; corrected 18%→13.8% |
> | Transaction costs | Pass w/ reservations | 12× turnover; with impact 13.8%→9.8% |
> | Regime dependency | Pass w/ reservations | All returns from trending regimes (~40% of time) |
> | Homogeneity & decay | Fail | 0.93 correlation with classic momentum; IC −64% over 5 years |
>
> **Recovery conditions** (re-audit upgrades to WATCH when met): use point-in-time index membership; reduce rebalancing to quarterly to cut turnover; add a sideways-regime de-risking rule.
> **Limits of this audit**: financial availability estimated via statutory disclosure deadlines (no true announcement dates on the platform); market impact is an estimate.

Design principle: the report never says "we consider the risk elevated" — every conclusion points to a reproducible number, and the audit's own limitations (e.g. missing announcement dates) are stated inside the report. That honesty is part of the product's credibility.

## 7. Key Engineering Decisions

1. **Own lightweight vectorized backtester**: five years of daily bars + adjustment factors, pandas-vectorized, milliseconds per variant; no dependency on the official backtest Skill's unpublished output contract. Official research Skills are still used for factor analysis, visualization, and reporting — keeping the "full use of platform capability" score.
2. **Stateless design**: each audit closes in a single call; no reliance on A2A persistence; no cross-task state recovery needed.
3. **18-minute operational budget**: intake 1 min → five checks in parallel
   9–10 min → cross-validation 2–3 min → report 2 min → 2 min reserve. The
   runtime hard-stops at 19 minutes, below the track's 20-minute limit.
   Backtest counts are fixed at intake — never run-until-done.
4. **Models**: main reasoning on DeepSeek V4 Pro (track requirement); the low-latency Volcano Seed model only as auxiliary classification, mixing boundary to be confirmed on site.
5. **Rate limits & degradation**: bounded parallelism, query cache, finite backoff; under pressure shrink in order — variant count → history span → chart count. **Never cut checks or the refusal mechanism** (they are the product differentiation).
6. **Robustness**: 429/timeout handling, idempotent task input, structured errors and degraded results.

## 8. Questions to Confirm On Site

1. **(Decides whether data-availability runs at full strength)** Can competing agents get true announcement/disclosure dates for financial data? Confirmed absent at the Skill layer — does the data API layer have it? Is direct data-API access allowed?
2. For `is_latest=False` multi-version records, how are versions time-stamped (date vs. timestamp; disclosure time or not)?
3. Earliest coverage date of historical index weights; can industry constituents provide exclusion dates?
4. Can the factor-analysis Skill specify universe, sub-period, holding period, and neutralization (decides whether homogeneity checks can call official capability directly)?
5. Request caps per token / per IP / per minute / per day, and max concurrency (decides variant-matrix size)?
6. A2A judging: are structured DataPart Artifacts accepted? Is judging single-turn or multi-turn? How are timeouts and retries handled?

## 9. Demo Design

Three example tasks (matching the submission checklist):

1. Audit a normal momentum strategy — a report with praise and criticism, demonstrating fairness;
2. Audit a **deliberately overfit factor** — expose it live with reproducible evidence; the demo video's climax;
3. Comparative audit of two strategies with ranking — demonstrating decision-support value, and triggering one `UNVERIFIABLE` or cross-validation.

Must show: real data/Skill calls, division of labor and contradiction handling between checks, deterministic verdict rules, clear assumptions and risk disclosure, structured Artifacts, stable completion within 20 minutes. Must not show: endless debate loops, LLM self-grading as the verdict, correlation dressed as causation, automatic trade execution, return claims.

MVP layers (something submittable at every moment):

- **Layer 1 (valid submission)**: A2A skeleton + Agent Card + intake + parameter-robustness and cost checks (backtester only) + simple summary report;
- **Layer 2 (defense weapon)**: all five checks + Moiré contradiction detection and follow-up experiments + five-level verdicts;
- **Layer 3 (bonus)**: report visualization polish, the overfit target factor, auditing other teams' strategies live.

## 10. Public A2A Skills

The Agent Card exposes exactly three Skills:

- `audit_strategy`: full audit of one strategy → five-level verdict + evidence pack
- `audit_factor`: factor-focused audit (homogeneity + decay + robustness)
- `compare_robustness`: robustness comparison and ranking of two or more strategies

## 11. Naming

- Project name **Assay**: the metallurgical term for testing whether ore contains true gold or pyrite. A double entendre on "testing" and "gold content".
- Cross-validation mechanism **Moiré Protocol**: the moiré pattern — a third pattern that emerges when two grids overlap; structure invisible from any single view appears in the superposition of views.
- Verdict scale **Verdict Scale**: five usage recommendations, each with upgrade conditions.

## 12. Development & Security Notes

- Model and token usage guide (local file): [AdventureX PandaAI model support](<../../reference/model-api-guide.md>).
- That file contains plaintext event tokens — **never commit it to a public repo, screenshots, logs, or public chats**; this document copies no token.
- Never expose tokens or data-service credentials (`PANDA_DATA_USERNAME/PASSWORD`) in frontend or public code; `.env` stays in `.gitignore`.

## 13. Reference Links

Competition material (`reference/` contains event tokens, excluded by `.gitignore`, local only — the links below do not work on GitHub):

- [PandaAI 7.22 ADVX Track](<../../reference/track-brief/track-brief.md>)
- [AdventureX PandaAI model support](<../../reference/model-api-guide.md>)

Data-capability evidence sources:

- [PandaAI-Tech/panda-data](https://github.com/PandaAI-Tech/panda-data) (data Skills implementation)
- [panda-data-skill/api_reference.md](https://raw.githubusercontent.com/PandaAI-Tech/panda-data/main/panda-data-skill/api_reference.md)
- [panda_tools/tools/financial.py](https://raw.githubusercontent.com/PandaAI-Tech/panda-data/main/panda_tools/tools/financial.py)
- [panda_tools/tools/market_ref.py](https://raw.githubusercontent.com/PandaAI-Tech/panda-data/main/panda_tools/tools/market_ref.py)
- [PandaAI Supported Skills overview (article 1163)](https://www.pandaaiquant.com/community/article/1163)
- [PandaAI workflow & strategy help (article 117)](https://www.pandaaiquant.com/community/article/117)
- [Data API FAQ](https://www.pandaaiquant.com/data-service/api-docs?api=data_faq)

Protocols & models:

- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [Volcano Ark developer docs](https://docs.volcengine.com/docs/82379/2335857?lang=zh)
