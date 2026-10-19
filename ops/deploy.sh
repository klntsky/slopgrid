#!/usr/bin/env bash
# Entry point for validating committed candidates, deploying releases, and
# inspecting deployment status through the operations CLI.
set -euo pipefail
exec node "$(dirname -- "${BASH_SOURCE[0]}")/cli.mjs" "$@"
