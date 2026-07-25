# Demo and Delivery Plan

> Status: the `audit_strategy` application path is implemented. A complete
> demonstration still requires provisioning the real G01 local package.
> Factor and comparison examples remain future work.
>
> See [PROPOSAL.md](PROPOSAL.md) for delivery constraints,
> [CHECKS.md](CHECKS.md) for expected check behavior, and
> [VERDICT_SPEC.md](VERDICT_SPEC.md) for output shape.

## 1. Example Tasks

1. Current: audit the registered G01 momentum strategy and show claim
   reproduction, five checks, Moiré, and the final Artifact.
2. Future: audit a registered deliberately fragile strategy.
3. Future: compare two same-kind subjects after the comparison skill is
   implemented.

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

## 3. Delivery Status

1. **Implemented:** A2A gateway, Intake, local data resolver, deterministic
   backtester, five checks, Moiré M1/M2, verdict aggregation, final Artifacts,
   cancellation, authentication, and web history.
2. **Deployment requirement:** provision and register the real G01 package;
   verify `/readyz`; run the complete G01 acceptance.
3. **Future:** G02/G03, factor and comparison skills, durable A2A Task
   recovery, and streaming.

## 4. Submission Checklist

- [ ] Public Agent Card and supported A2A interface URL
- [ ] Service remains reachable during review
- [ ] Real G01 package provisioned and `/readyz` returns `200`
- [ ] G01 completes through the public A2A interface
- [ ] Usage, architecture, skill, and output documentation
- [ ] Demo video showing the complete flow
- [ ] Data and research skill inventory
- [ ] Risk disclosure in every final Artifact
- [ ] Repository or requested delivery package submitted to the organizer
