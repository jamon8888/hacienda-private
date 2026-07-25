#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE_BIN="${NODE_BIN:-}"
PNPM_BIN="${PNPM_BIN:-}"
PNPM_JS="${PNPM_JS:-/home/jamin/.local/node/lib/node_modules/corepack/dist/pnpm.js}"
CARGO_BIN="${CARGO_BIN:-}"
CORPUS_PATH="${CORPUS_PATH:-$REPO_ROOT/apps/web/app/release/granite/corpus.json}"
TMP_DIR="${TMPDIR:-/tmp}"
WORK_DIR="$(mktemp -d "$TMP_DIR/granite-release-XXXXXX")"
ARTIFACT_DIR="$WORK_DIR/artifacts"
NATIVE_REPORT="$WORK_DIR/native-report.json"
BROWSER_REPORT="$WORK_DIR/browser-report.json"
GRANITE_CACHE_SOURCE_DEFAULT="/tmp/xberg-e2e-model-cache/granite/granite-embedding-97m-multilingual-r2"
GRANITE_ARTIFACT_SOURCE_DIR="${GRANITE_ARTIFACT_SOURCE_DIR:-}"
FORCE_GRANITE_REBUILD="${FORCE_GRANITE_REBUILD:-0}"

cleanup() {
  if [[ -z "${KEEP_GRANITE_RELEASE_TMP:-}" ]]; then
    rm -rf "$WORK_DIR"
  else
    echo "preserved release artifacts in $WORK_DIR"
  fi
}
trap cleanup EXIT

resolve_bin() {
  local current="$1"
  local fallback="$2"
  if [[ -n "$current" ]]; then
    printf '%s\n' "$current"
    return 0
  fi
  if command -v "$fallback" >/dev/null 2>&1; then
    command -v "$fallback"
    return 0
  fi
  return 1
}

run_pnpm() {
  if [[ -n "$PNPM_BIN" ]]; then
    "$PNPM_BIN" "$@"
  else
    "$NODE_BIN" "$PNPM_JS" "$@"
  fi
}

newer_than() {
  local marker="$1"
  shift
  if [[ ! -e "$marker" ]]; then
    return 0
  fi
  find "$@" -type f -newer "$marker" -print -quit 2>/dev/null | grep -q .
}

if ! NODE_BIN="$(resolve_bin "$NODE_BIN" node)"; then
  echo "node binary not found; set NODE_BIN or add node to PATH" >&2
  exit 1
fi

if ! PNPM_BIN="$(resolve_bin "$PNPM_BIN" pnpm)"; then
  if [[ ! -f "$PNPM_JS" ]]; then
    echo "pnpm binary not found; set PNPM_BIN, add pnpm to PATH, or set PNPM_JS" >&2
    exit 1
  fi
fi

if ! CARGO_BIN="$(resolve_bin "$CARGO_BIN" cargo)"; then
  echo "cargo binary not found; set CARGO_BIN or add cargo to PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ -z "$GRANITE_ARTIFACT_SOURCE_DIR" && -d "$GRANITE_CACHE_SOURCE_DEFAULT" ]]; then
  GRANITE_ARTIFACT_SOURCE_DIR="$GRANITE_CACHE_SOURCE_DEFAULT"
fi

WASM_MARKER="$REPO_ROOT/crates/xberg-wasm/pkg/web/xberg_wasm.js"
WEB_MARKER="$REPO_ROOT/apps/web/out/release/granite.html"

if [[ "$FORCE_GRANITE_REBUILD" == "1" ]] || newer_than "$WASM_MARKER" \
  "$REPO_ROOT/crates/xberg-wasm" \
  "$REPO_ROOT/crates/xberg-candle-embed" \
  "$REPO_ROOT/crates/xberg-gliner" \
  "$REPO_ROOT/crates/xberg/src/rag_embed.rs" \
  "$REPO_ROOT/crates/xberg/Cargo.toml"; then
  echo "== build local xberg-wasm package =="
  run_pnpm --dir crates/xberg-wasm run build:wasm:web
  "$NODE_BIN" crates/xberg-wasm/scripts/fix-wasi-imports.mjs
else
  echo "== reuse local xberg-wasm package =="
fi

if [[ "$FORCE_GRANITE_REBUILD" == "1" ]] || newer_than "$WEB_MARKER" \
  "$REPO_ROOT/apps/web" \
  "$REPO_ROOT/packages/wasm-pipeline" \
  "$REPO_ROOT/services/mcp-server/src" \
  "$REPO_ROOT/services/mcp-server/models" \
  "$REPO_ROOT/crates/xberg-wasm/pkg/web"; then
  echo "== build web static export =="
  run_pnpm --dir apps/web build
else
  echo "== reuse web static export =="
fi

echo "== ensure Granite artifacts via manifest-backed model cache =="
if [[ -n "$GRANITE_ARTIFACT_SOURCE_DIR" ]]; then
  mkdir -p "$ARTIFACT_DIR"
  cp "$GRANITE_ARTIFACT_SOURCE_DIR"/model.safetensors "$ARTIFACT_DIR"/model.safetensors
  cp "$GRANITE_ARTIFACT_SOURCE_DIR"/tokenizer.json "$ARTIFACT_DIR"/tokenizer.json
  cp "$GRANITE_ARTIFACT_SOURCE_DIR"/config.json "$ARTIFACT_DIR"/config.json
else
  if [[ -n "$PNPM_BIN" ]]; then
    "$PNPM_BIN" --dir services/mcp-server exec tsx release/scripts/ensure-granite-artifacts.mts "$ARTIFACT_DIR"
  else
    "$NODE_BIN" "$PNPM_JS" --dir services/mcp-server exec tsx release/scripts/ensure-granite-artifacts.mts "$ARTIFACT_DIR"
  fi
fi

echo "== native Granite report =="
"$CARGO_BIN" run -p xberg-candle-embed --example granite_release_dump -- "$CORPUS_PATH" "$ARTIFACT_DIR" >"$NATIVE_REPORT"

echo "== ensure Playwright Chromium =="
run_pnpm --dir apps/web exec playwright install chromium

echo "== browser Granite release check =="
if [[ -n "$PNPM_BIN" ]]; then
  GRANITE_NATIVE_REPORT="$NATIVE_REPORT" \
  GRANITE_BROWSER_REPORT="$BROWSER_REPORT" \
  "$PNPM_BIN" --dir apps/web exec playwright test e2e/granite-release.spec.ts
else
  GRANITE_NATIVE_REPORT="$NATIVE_REPORT" \
  GRANITE_BROWSER_REPORT="$BROWSER_REPORT" \
  "$NODE_BIN" "$PNPM_JS" --dir apps/web exec playwright test e2e/granite-release.spec.ts
fi

echo
echo "Granite release gates passed."
echo "Native report:  $NATIVE_REPORT"
echo "Browser report: $BROWSER_REPORT"
