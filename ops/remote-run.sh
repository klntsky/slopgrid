#!/usr/bin/env bash
set -euo pipefail
umask 077
run=${1:?Missing run directory}
root=${2:?Missing deployment root}
exec > "$run/run.log" 2>&1
trap 'code=$?; printf "%s\n" "$code" > "$run/exit.next"; mv "$run/exit.next" "$run/exit"' EXIT
printf '%s\n' "$$" > "$run/pid"
target=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).target)' "$run/request.json")
if test "$target" != validate; then
  exec 9> "$root/deployment.lock"
  flock -n 9 || { echo 'Another deployment is running; retry when it completes.'; exit 75; }
fi
node "$(dirname -- "${BASH_SOURCE[0]}")/lib/pipeline.mjs" "$run/request.json"
