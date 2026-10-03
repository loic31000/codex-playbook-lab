#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js est introuvable.' >&2; exit 127; }
exec node "$project_root/src/cli.mjs" test "$@"
