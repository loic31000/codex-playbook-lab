# Experiment orchestration

This V2 layer freezes a complete logical execution plan before any agent run.
Plan order is contractual: Experiment, TestCase, repetition, then baseline and
treatment. IDs and the canonical SHA-256 plan fingerprint contain no time or
random component. Canonical object keys use deterministic JavaScript code-unit
ordering, never locale-aware or linguistic ordering; Unicode strings are not
normalized.

The model-input contract is shared with fixed benchmarks: baseline receives the
exact `TestCase.input`; treatment receives exact `PromptVersion.content`, the
stable `\n\n---\n\n` separator, and exact `TestCase.input`. Generated-case
provenance is never included.

Orchestration state is serializable but not persisted by this issue. Completed
and failed logical runs are terminal on normal resume; running and cancelled
runs are retried with an incremented attempt. All human-review states remain
`pending_review`. Events and statuses are technical facts only.

Resume treats serialized state as untrusted input. Every logical wrapper,
domain `ExperimentRun`, historical event, and execution baseline is validated
against the immutable plan before the backend opens. A pending run has exactly
attempt 0; running, completed, failed, and cancelled runs have attempt 1 or
greater. The state machine never produces pending with a positive attempt, so
that combination is rejected. The latest non-skipped lifecycle event must
match the run's current technical status and attempt. Once execution has
started, the prior technical baseline is mandatory and its target must exactly
match the plan target. Baseline `gitStatus` preserves the exact
`git status --porcelain=v1 -z` value and accepts any string, including the empty
string for a clean repository, or `null`; it is never trimmed or normalized.

`StrictExperimentExecutionBackend` prepares one master `StrictWorkspaceSnapshot`
per invocation. A policy probe establishes the technical baseline before the
first agent run, and every run environment is checked against it. Resume checks
the prior baseline before executing an agent.
