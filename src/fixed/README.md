# Fixed benchmark slice

This V2 slice keeps control-plane metadata separate from agent input:

- prompt discovery produces domain `PromptDefinition` and `PromptVersion` values;
- benchmark discovery produces a domain `FixedCase` containing only the Markdown body;
- `FixedBenchmarkDefinition` retains source and expectation metadata in the Lab;
- the executor receives an explicit model input, never the benchmark definition.

`BASELINE` receives `FixedCase.input` exactly. `TREATMENT` receives
`PromptVersion.content`, then the stable separator `\n\n---\n\n`, then
`FixedCase.input`. Changing this separator is an input-contract change.

Execution uses two environments cloned from one `StrictWorkspaceSnapshot`.
Results contain technical facts and retain `pending_review`; this layer does not
produce scores, winners, or human-review decisions.
