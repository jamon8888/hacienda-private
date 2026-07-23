#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE_BIN="${NODE_BIN:-/home/jamin/.local/node/bin/node}"
PNPM_JS="${PNPM_JS:-/home/jamin/.local/node/lib/node_modules/corepack/dist/pnpm.js}"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "node binary is not executable: $NODE_BIN" >&2
  exit 1
fi

if [[ ! -f "$PNPM_JS" ]]; then
  echo "pnpm entrypoint not found: $PNPM_JS" >&2
  exit 1
fi

run_pnpm_test() {
  local package_dir="$1"
  shift
  echo "== pnpm test: $package_dir :: $* =="
  "$NODE_BIN" "$PNPM_JS" --dir "$package_dir" test -- "$@"
}

cd "$REPO_ROOT"

run_pnpm_test services/mcp-server mirror.test.ts tools.test.ts mirror.append.test.ts
run_pnpm_test packages/wasm-pipeline rag.test.ts mirror.test.ts embed.test.ts

cat <<'EOF'

Targeted shared-embedding verification passed.

Remaining manual release gates:
  1. Native/browser numerical parity against the reference Granite implementation.
  2. Browser first-load, peak-memory, and batch-indexing latency measurement.
  3. Clean-browser artifact/CDN verification for the pinned Granite files.
EOF
