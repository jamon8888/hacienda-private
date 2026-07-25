#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <cargo-subcommand> [args...]" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found on PATH" >&2
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup not found on PATH" >&2
  exit 1
fi

if ! rustup toolchain list 2>/dev/null | grep -q '^nightly'; then
  echo "nightly toolchain missing. Run: rustup toolchain install nightly" >&2
  exit 1
fi

if ! rustup component list --toolchain nightly 2>/dev/null | grep -q '^rustc-codegen-cranelift-preview.*installed'; then
  echo "Cranelift backend missing. Run: rustup component add rustc-codegen-cranelift-preview --toolchain nightly" >&2
  exit 1
fi

exec "$(dirname "$0")/cargo-local.sh" +nightly \
  -Z codegen-backend \
  --config profile.dev.codegen-backend='"cranelift"' \
  --config profile.test.codegen-backend='"cranelift"' \
  "$@"
