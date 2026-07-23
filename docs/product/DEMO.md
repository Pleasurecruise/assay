# Demo and Delivery Plan

> See [PROPOSAL.md](PROPOSAL.md) for delivery constraints,
> [CHECKS.md](CHECKS.md) for expected check behavior, and
> [VERDICT_SPEC.md](VERDICT_SPEC.md) for output shape.

## 1. Example Tasks

1. Audit a normal momentum strategy and show both supporting and opposing
   evidence.
2. Audit a deliberately overfit factor and expose it with reproducible
   evidence.
3. Compare two same-kind subjects, rank robustness, and trigger either a Moiré
   follow-up or an `UNVERIFIABLE` result.

## 2. Demo Requirements

Show:

- real data and tool calls;
- visible division of work across independent checks;
- at least one Moiré discriminating experiment;
- deterministic verdict rules rather than LLM scoring;
- assumptions, limitations, and risk disclosure;
- a structured Artifact in addition to prose;
- stable completion within 20 minutes;
- at least one honest refusal or non-upgrade.

Do not show:

- unbounded agent debate;
- LLM self-scoring as evidence;
- correlation described as causation;
- automatic trading;
- return promises.

## 3. Delivery Milestones

1. **Runtime milestone:** five isolated check agents, parallel runner, typed
   contracts, and tests. Data and backtest tools may still be absent, so honest
   runs return `insufficient_evidence`.
2. **Submission baseline:** A2A gateway, Intake, Backtester, all data tools,
   five checks, Moiré follow-ups, verdict aggregation, and final Artifacts.
3. **Polish:** visual evidence pages, a controlled overfit target, comparison
   audit, and resilient deployment.

## 4. Submission Checklist

- [ ] Public Agent Card and supported A2A interface URL
- [ ] Service remains reachable during review
- [ ] At least three tested example tasks
- [ ] Usage, architecture, skill, and output documentation
- [ ] Demo video showing the complete flow
- [ ] Data and research skill inventory
- [ ] Risk disclosure in every final Artifact
- [ ] Repository or requested delivery package submitted to the organizer
