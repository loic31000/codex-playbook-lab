#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ "$1" != "stdio" ]; then
  echo "expected strict stdio mode" >&2
  exit 64
fi

mkdir -p "${CODEX_HOME:-/tmp/codex-home}"

exec codex exec-server \
  --listen stdio \
  --linux-sandbox-pid-namespace isolate
