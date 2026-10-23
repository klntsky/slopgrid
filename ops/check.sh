#!/usr/bin/env bash
# Run operations regression checks locally using isolated fixtures.
set -euo pipefail
exec node "$(dirname -- "${BASH_SOURCE[0]}")/check.mjs" "$@"
