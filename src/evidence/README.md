# Reliable evidence storage

The V2 evidence store is an explicitly rooted, versioned filesystem archive.
Plans, attempt starts, finalized manifests, and append-only checkpoints are
immutable canonical JSON records. Large exact text payloads are write-once
SHA-256 blobs referenced by portable store-relative paths.

`runStoredExperimentPlan()` composes the #27 state machine with a recording
backend. It never reimplements orchestration: the durable running checkpoint is
written before `executeRun()`, `started.json` is written before the agent, and a
normal backend result is finalized into `manifest.json`. A crash therefore
leaves a visible partial attempt that a later process resumes as a new attempt.

Checkpoint readers validate format, version, plan identity, and the checkpoint
content fingerprint. A corrupt newest checkpoint is reported and skipped in
favor of the newest valid predecessor. Sequence names use at least eight
digits, remain valid above `99999999`, and are ordered numerically. Operational
filesystem errors are propagated rather than treated as content corruption.

Final manifests discriminate a normal `process_exit` from an
`execution_error`. The latter records only facts that exist and never invents
an exit code or transcript. On resume, an immutable terminal manifest that is
ahead of the latest checkpoint is validated against its plan and `started.json`,
then reconciled into a new append-only checkpoint before any agent can run.
Stored orchestration state omits
ephemeral container and volume facts; manifests retain only factual portable
workspace, transcript, fingerprint, artifact, and domain evidence data.

The storage layer never computes a winner, score, correctness judgment,
promotion, or human-review decision.
