#!/usr/bin/env bash
# Run operations regression checks on the configured host in tmux bg,
# streaming the remote log and returning the check result.
set -euo pipefail
exec node "$(dirname -- "${BASH_SOURCE[0]}")/check.mjs" "$@"
