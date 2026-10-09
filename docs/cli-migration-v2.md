# CLI migration matrix (V1 to V2)

The V2 CLI is an adapter over `LabApplication`. It never falls back to the V1
engine. Historical top-level aliases remain temporarily available and are
explicitly classified below.

| Historical command | Status | V2 command | Engine | Notes |
| --- | --- | --- | --- | --- |
| `check` | MIGRATED | `diagnostics` | Application V2 | `check` remains an alias of Application diagnostics. |
| `list` | MIGRATED | `prompts list` | Application V2 | Uses `src/fixed/prompt-discovery.ts`. |
| `benchmark` | LEGACY_ALIAS | `benchmarks list` for discovery | V1 for execution; Application V2 for listing | V2 execution requires a configured safe provider and never calls this alias. |
| `suite` | LEGACY_ONLY | `legacy suite` | V1 | Top-level alias temporarily retained. |
| `test` | LEGACY_ONLY | `legacy test` | V1 | Top-level alias temporarily retained. |
| `resume` | LEGACY_ALIAS | `experiment resume` | V1 alias / Application V2 namespace | No cross-engine fallback. |
| `results` | LEGACY_ALIAS | `experiment report`, `artifact show` | V1 alias / Application V2 namespace | V2 reads the evidence store and factual report. |
| `clean` | LEGACY_ONLY | `legacy clean` | V1 | No V2 equivalent in #31. |
| `run-test` | LEGACY_ONLY | `legacy run-test` | V1 | No V2 equivalent. |
| `save-run` | LEGACY_ONLY | `legacy save-run` | V1 | V2 persistence is handled by the evidence store. |

Additional V2 commands are `experiment create`, `experiment run`,
`review set`, `promote`, and `cases generate`. Production currently has no
safe V2 agent executor or exploratory generator. Those commands return the
typed `CAPABILITY_UNAVAILABLE` error until such providers are configured.

All V2 commands support `--json`. Application errors map centrally to stable
exit codes:

| Error | Exit code |
| --- | ---: |
| success | 0 |
| `INTERNAL_ERROR` | 1 |
| `INVALID_ARGUMENT` | 2 |
| `NOT_FOUND` | 3 |
| `CONFLICT` | 4 |
| `CAPABILITY_UNAVAILABLE` | 5 |
| `INFRASTRUCTURE_FAILURE` | 5 |
| `DATA_INTEGRITY_FAILURE` | 5 |
| `CANCELLED` / handled SIGINT | 130 |
