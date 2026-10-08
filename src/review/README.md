# Human review and case promotion

Human review is an explicit, append-only layer over immutable technical attempt
manifests. Review actions never alter technical status, evidence, artifacts, or
checkpoints. A missing journal means `pending_review`; any malformed journal
entry fails closed instead of falling back to an older decision.

Generated-case promotion is a second explicit human action. It requires a
finalized attempt and a non-pending human decision, but does not require
approval. Promotion writes a versioned exact-body benchmark, a provenance
sidecar, and a portable immutable evidence-store audit. It never creates an
answer, oracle, score, winner, or automatic qualitative conclusion.
