#!/usr/bin/env bash
set -euo pipefail

git config --global --add safe.directory "${CODEX_LAB_REPO_DIR:-/workspace/test-repo}"

if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null
fi

if [[ -f "${CODEX_LAB_REPO_DIR}/package-lock.json" && ! -d "${CODEX_LAB_REPO_DIR}/node_modules" ]]; then
  npm ci --ignore-scripts --prefix "${CODEX_LAB_REPO_DIR}"
fi

exec node /opt/codex-lab/src/cli.mjs "$@"
