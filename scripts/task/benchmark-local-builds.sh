#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if ! command -v task >/dev/null 2>&1; then
  echo "task not found on PATH" >&2
  exit 1
fi

timer() {
  if command -v /usr/bin/time >/dev/null 2>&1; then
    /usr/bin/time -f 'elapsed=%E user=%U sys=%S maxrss=%MKB' "$@"
  else
    "$@"
  fi
}

echo "== benchmark local build/test commands =="
echo "repo: $repo_root"
echo

run_case() {
  local label="$1"
  shift
  echo "-- $label --"
  if timer "$@"; then
    echo "  ✓ PASS"
  else
    local status=$?
    echo "  ✗ FAIL (exit $status)"
  fi
  echo
}

failed=0
run_case "task build" task build || failed=1
run_case "task build:web" task build:web || failed=1
run_case "task test:mcp" task test:mcp || failed=1

if [[ $failed -eq 1 ]]; then
  echo "== SUMMARY: Some cases failed =="
  exit 1
else
  echo "== SUMMARY: All cases passed =="
fi
