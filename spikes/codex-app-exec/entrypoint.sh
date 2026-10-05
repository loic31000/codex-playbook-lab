#!/bin/sh
set -eu

if [ ! -f /workspace/package.json ]; then
  cp -R /opt/fixture/. /workspace/
  git -C /workspace init --quiet
  git -C /workspace config user.name "Codex App Exec Spike"
  git -C /workspace config user.email "spike@example.invalid"
  git -C /workspace add -A
  GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' \
  GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' \
    git -C /workspace -c core.hooksPath=/dev/null -c commit.gpgSign=false commit --quiet --message initial
fi

mkdir -p "${CODEX_HOME:-/tmp/codex-home}"

if [ "$#" -ne 1 ]; then
  echo "expected exec-server capability-token SHA-256" >&2
  exit 64
fi

exec codex exec-server \
  --listen ws://0.0.0.0:4500 \
  --ws-auth capability-token \
  --ws-token-sha256 "$1" \
  --linux-sandbox-pid-namespace isolate
