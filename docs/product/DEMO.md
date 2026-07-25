# Demo and Delivery Plan

> Status: the `audit_strategy` application path and all three strategy
> bindings are implemented. A complete demonstration requires running
> `bun run data:prepare` to generate and validate the three-package runtime
> registry.
> Factor and comparison examples remain future work.
>
> See [PROPOSAL.md](PROPOSAL.md) for delivery constraints,
> [CHECKS.md](CHECKS.md) for expected check behavior, and
> [VERDICT_SPEC.md](VERDICT_SPEC.md) for output shape.

## 1. Example Tasks

1. Current: in one A2A server lifecycle, submit the three frozen
   natural-language strategy inputs sequentially and show claim reproduction,
   five checks, Moiré, and the final Artifact for each.
2. Current: show that the three claims-free bindings select three semantic
   runtime packages while reusing the checksums of one shared canonical data
   source.
3. Future: compare two same-kind subjects after the comparison skill is
   implemented.

G01, G02, and G03 are fixture and acceptance labels only. They are not sent as
runtime routing keys and do not appear in package IDs.

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
2. **Deployment requirement:** run `bun run data:prepare` to validate the
   shared canonical source and generate the three-package registry; verify
   `/readyz`; run the three-input sequential acceptance in one server
   lifecycle.
3. **Future:** factor and comparison skills, durable A2A Task recovery, and
   streaming.

## 4. Submission Checklist

- [ ] Public Agent Card and supported A2A interface URL
- [ ] Service remains reachable during review
- [ ] `bun run data:prepare` generated and validated all three runtime packages
- [ ] `/readyz` returns `200` against the generated registry
- [ ] All three fixture inputs complete sequentially through one public A2A
      server lifecycle
- [ ] Usage, architecture, skill, and output documentation
- [ ] Demo video showing the complete flow
- [ ] Data and research skill inventory
- [ ] Risk disclosure in every final Artifact
- [ ] Repository or requested delivery package submitted to the organizer
