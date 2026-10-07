# Exploratory generated cases

This V2 slice asks an injected generator for case proposals and records factual
provenance. It does not run A/B experiments, score cases, promote fixed cases,
or make human-review decisions.

The generator model input is exactly `GeneratorPromptVersion.content`, followed
by the stable separator `\n\n---\n\n`, followed by the studied
`PromptVersion.content`. The API accepts no benchmark, expectation, oracle,
review status, or benchmark result.

Generated Markdown is preserved byte-for-byte as a JavaScript string. Its exact
SHA-256 is recorded in `contentFingerprint` and verified by the domain factory.
Exact duplicates remain in the result and are reported by fingerprint. A seed
is recorded only when the adapter confirms it as `seedUsed`; a seed never
implies deterministic generation.
