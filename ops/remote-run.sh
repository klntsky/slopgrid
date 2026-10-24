#!/usr/bin/env bash
set -euo pipefail
umask 077
run=${1:?Missing run directory}
root=${2:?Missing deployment root}
mkdir -- "$run/worker.claim" || { echo 'This run already has a worker claim; create a new run.' >&2; exit 75; }
exec > "$run/run.log" 2>&1
target=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).target)' "$run/request.json")
admission=private
if test "$target" = staging || test "$target" = production; then
  exec 9> "$root/deployment.lock"
  if flock -n 9; then admission=locked; else admission=busy; fi
fi
exec node "$(dirname -- "${BASH_SOURCE[0]}")/lib/worker.mjs" "$run" "$root" "$admission"
