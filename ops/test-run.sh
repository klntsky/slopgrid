#!/usr/bin/env bash
set -euo pipefail
umask 077
run=${1:?Missing check directory}
exec > "$run/run.log" 2>&1
trap 'code=$?; printf "%s\n" "$code" > "$run/exit.next"; mv "$run/exit.next" "$run/exit"' EXIT
printf '%s\n' "$$" > "$run/pid"
cd "$run"
shift
if (( $# )); then
  node --test "$@"
else
  node --test tests/*.test.mjs
fi
