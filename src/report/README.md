# Factual human report

This slice builds a read-only, versioned report from an immutable execution
plan, the latest valid checkpoint, archived attempts and the append-only human
review journal. Corrupt checkpoints, manifests or review records fail closed.

The structured report is the single source for canonical JSON and deterministic
Markdown rendering. It contains technical facts, portable source references and
explicitly labelled human decisions. It never infers a qualitative assessment,
changes a human review status, promotes a case, or embeds large artifact blobs.

Completeness describes only whether the evidence dossier is technically
terminal and coherent. Missing evidence stays missing; it is never replaced by
zero, an empty result or an inferred success.
