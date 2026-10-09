# Application layer

`LabApplication` is the shared use-case boundary for the CLI and future local
API/GUI adapters. It delegates domain work to the existing fixed, explore,
experiment, evidence, review and report modules.

Infrastructure capabilities are explicit injected ports. In particular, the
production factory does not provide an agent executor, execution backend or
exploratory generator until a safe V2 provider exists. Calling those use cases
therefore returns `CAPABILITY_UNAVAILABLE`; there is no legacy fallback.

Application code has no terminal, argv, process-exit or presentation concern.
It returns structured values, typed errors and JSON-compatible factual events.
Technical statuses and human-review statuses remain independent, and no
automatic winner, score, verdict, approval, rejection or promotion is derived.
