# Assay: Strategy Credibility Audit Agent

> Status: product direction converged on 2026-07-23. Competition brief:
> [PandaAI AdventureX Track Brief](https://ncn9g4d5xvof.feishu.cn/docx/YYsadGRNYopqOVxLFFrcorJjnzd).
> Data documentation:
> [PandaAI Data API](https://www.pandaaiquant.com/data-service/api-docs).

This directory is split by question:

- **PROPOSAL**: why the product should exist;
- [CHECKS](CHECKS.md): what it audits;
- [VERDICT_SPEC](VERDICT_SPEC.md): what it returns;
- [DATA_NOTES](DATA_NOTES.md): verified data facts and open questions;
- [DEMO](DEMO.md): how it is demonstrated and delivered;
- [ARCHITECTURE](ARCHITECTURE.md): how components are separated;
- [PIPELINE](PIPELINE.md): how one request flows through the system.

## 1. Purpose

AI is pushing the cost of producing trading strategies toward zero. A prompt
can generate a factor and a polished backtest curve in minutes. The cost of
deciding whether that result is credible has not fallen at the same rate: it
still depends on expert judgment, institutional checklists, and extensive
manual testing.

This widening gap between production and verification increases the supply of
false alpha faster than the market's ability to evaluate it. A strategy
claiming 18% annual return may hide selected parameters, future-aware
constituents, transaction-cost erosion, or an implicit bet on one historical
regime. Its author may not know which defect is present.

Assay exists to make strategy credibility verifiable rather than merely
claimed. It turns institutional due-diligence instincts into standardized,
reproducible, and explainable automated checks:

- parameter overfitting;
- look-ahead and point-in-time data errors;
- realistic transaction costs;
- market-regime dependency;
- signal homogeneity and decay.

## 2. Audience

### Primary Audience

Independent researchers and quantitative enthusiasts can use Assay now. They
are most exposed to convincing backtests because they do not have an
institutional risk process. As AI strategy-generation tools spread, their
first question remains the same: "Is this result real?" Assay provides the
missing verification layer.

### Agent-Ecosystem Audience

When agents produce strategies at machine scale, verification must also run at
machine scale. Assay exposes one audit capability through A2A so a
strategy-producing agent can validate its output before delivery.

The separation between production agents and verification agents is the
future workflow Assay is designed for. Internal check agents remain private
implementation details; the complete audit is the public A2A capability.

## 3. Product

**Assay is a strategy-credibility audit agent.**

Most competition agents attempt to discover alpha. Assay tests whether an
alpha claim survives independent scrutiny. A strategy audit runs five checks
in parallel. A factor audit runs the applicable profile. The Moiré Protocol
then investigates material disagreements with discriminating experiments.

The output contains:

- a deterministic five-level verdict;
- reproducible evidence;
- explicit missing evidence and limitations;
- recovery conditions and review triggers;
- structured and human-readable Artifacts.

## 4. Non-Goals

Assay does not:

- recommend securities;
- predict market direction;
- generate or optimize strategies;
- execute trades;
- promise returns.

These are product boundaries, not missing features. An auditor cannot also be
the producer without weakening independence, just as an auditor should not
prepare and then audit the same books.

The runtime consequence is that audit agents do not receive tools that create
orders or mutate trading systems. Tool tiers and side-effect policy are
defined in [RUNTIME.md](../architecture/RUNTIME.md).

## 5. Why This Track

- **A verification layer is differentiated.** Common track directions produce
  factors, strategies, research, portfolios, or generic multi-agent flows.
  Assay evaluates their credibility.
- **The collaboration is substantive.** Checks run independently rather than
  serially echoing one another. Disagreement triggers an experiment, and
  synthesis follows evidence rather than voting.
- **Compliance matches the product.** No return promises, no investment
  advice, and mandatory risk disclosure are natural properties of an audit.
- **Data gaps are contained.** Each check depends only on verified data
  capabilities. A missing interface degrades one result to
  `insufficient_evidence` instead of corrupting the complete audit.

## 6. Track Constraints

The current project records these delivery constraints from the competition
materials:

- submit a hosted A2A Remote Agent with a publicly reachable Agent Card;
- use DeepSeek V4 Pro as the required foundation model;
- complete one request within 20 minutes;
- accept natural-language tasks and expose an understandable process and
  result;
- provide at least three examples, documentation, a demo video, and a list of
  used skills.

These facts must be reconfirmed against the latest organizer material before
submission because the supplied Feishu page is dynamically rendered and may
not be accessible to automated documentation tooling.

## 7. Evaluation Mapping

| Evaluation concern             | Assay response                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Complete a complex task        | Strategy input, fixed experiment plan, parallel checks, cross-validation, and final Artifact     |
| Real multi-agent collaboration | Independent branches, bounded follow-ups, and evidence-based synthesis                           |
| Use platform data and skills   | Market data, adjustment factors, historical weights, tradability, status, factors, and calendars |
| Novel product value            | A verification layer that other strategy-producing agents can call before delivery               |

## 8. Naming

- **Assay** is the metallurgical process used to distinguish valuable ore from
  pyrite and measure its content.
- **Moiré Protocol** refers to a pattern that appears only when separate grids
  overlap: structure invisible from one view can emerge from several.
- **Verdict Scale** is the deterministic recommendation scale defined in
  [VERDICT_SPEC.md](VERDICT_SPEC.md).

The verdict levels are:

- `KEEP`
- `WATCH`
- `QUARANTINE`
- `RETIRE`
- `UNVERIFIABLE`
