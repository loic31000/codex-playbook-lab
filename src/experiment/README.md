# Experiment orchestration

This V2 layer freezes a complete logical execution plan before any agent run.
Plan order is contractual: Experiment, TestCase, repetition, then baseline and
treatment. IDs and the canonical SHA-256 plan fingerprint contain no time or
random component.

The model-input contract is shared with fixed benchmarks: baseline receives the
exact `TestCase.input`; treatment receives exact `PromptVersion.content`, the
stable `\n\n---\n\n` separator, and exact `TestCase.input`. Generated-case
provenance is never included.

Orchestration state is serializable but not persisted by this issue. Completed
and failed logical runs are terminal on normal resume; running and cancelled
runs are retried with an incremented attempt. All human-review states remain
`pending_review`. Events and statuses are technical facts only.

`StrictExperimentExecutionBackend` prepares one master `StrictWorkspaceSnapshot`
per invocation. A policy probe establishes the technical baseline before the
first agent run, and every run environment is checked against it. Resume checks
the prior baseline before executing an agent.
