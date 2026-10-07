# Strict isolated runner

## Architecture

The production boundary is:

```text
trusted host app-server
  -> private inherited stdio
  -> docker run --network none
  -> Codex exec-server 0.160.0
  -> dedicated named volume at /workspace
```

The app-server receives `StrictExecutionEnvironment.definition()`. Docker then
starts `exec-server --listen stdio`; there is no network listener or published
port.

## Threat model and visible resources

The agent is treated as hostile. Its container receives one writable named
volume at `/workspace`. The source target, Lab repository, host home, Docker
socket and host credentials are never bind-mounted. Only fixed non-secret
environment variables are passed to Docker.

The root filesystem is read-only. `/tmp` is a bounded tmpfs. Capabilities are
dropped, `no-new-privileges` is enabled, the process is non-root, and network
mode is `none`.

## Snapshot strategy

The caller must supply both a `TargetRef` and an explicit source path. The
runner resolves the real paths of the target and forbidden roots before the
security comparison. A symlink or junction escaping the target root is
rejected rather than dereferenced. The runner records filesystem and Git
identity, copies the source through
`docker cp` into a dedicated snapshot volume, and verifies the copied state.
Execution volumes are cloned from that snapshot volume by a networkless
provisioning container. The real agent never sees the source host path.

Baseline and treatment environments therefore have distinct volumes but the
same initial fingerprint, HEAD, tree and status.

## Lifecycle and cleanup

`StrictRunner.prepare()` creates a snapshot. A snapshot creates or scopes an
execution environment through `createEnvironment()` or `withEnvironment()`.
The environment exposes `start`, `exec`, `captureResult`, `stop` and `cleanup`.
`withSnapshot` and `withEnvironment` clean resources in success, failure and
abort paths. Cleanup is idempotent, retries a bounded number of times, and
verifies factual absence after deletion. A failed cleanup remains retryable.
Docker object deletion is restricted to the runner-owned name prefix.

The source is fingerprinted again during snapshot cleanup; any source mutation
is reported as an invariant violation.

## Evidence

Captured results are factual: initial/final fingerprints, Git HEAD/tree/status,
structured manifest-to-manifest run changes, changed paths and Docker policy
facts. Git patches are explicitly named `initialGitDiffFromHead` and
`finalGitDiffFromHead`; neither is represented as the run delta. The runner
does not score output, choose a winner, or modify human-review state.

## Version and limits

The trusted-host caller must collect the real `codex --version` output and pass
it as `trustedHostCodexVersionEvidence`. The runner rejects that evidence unless
it is exactly `codex-cli 0.160.0`; it does not itself discover the host binary.
The image pins the same version and verifies the binary after build.

The isolation properties were proven on Windows 10.0.19045 with Docker 29.6.2
and Linux containers. This is not a general multi-OS or multi-version
guarantee. A version or platform change requires a new validation campaign.
