#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${1:-}"
source "$REPO_ROOT/scripts/task/hash-utils.sh"
CARGO_LOCAL_SH="$REPO_ROOT/scripts/task/cargo-local.sh"

have() {
  command -v "$1" >/dev/null 2>&1
}

resolve_node() {
  if [[ -n "${NODE_BIN:-}" ]]; then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi
  if have node; then
    command -v node
    return 0
  fi
  return 1
}

resolve_pnpm_bin() {
  if [[ -n "${PNPM_BIN:-}" ]]; then
    printf '%s\n' "$PNPM_BIN"
    return 0
  fi
  if have pnpm; then
    command -v pnpm
    return 0
  fi
  return 1
}

run_pnpm() {
  local node_bin="$1"
  shift
  if pnpm_bin="$(resolve_pnpm_bin)"; then
    "$pnpm_bin" "$@"
    return 0
  fi
  local pnpm_js="${PNPM_JS:-}"
  if [[ -z "$pnpm_js" || ! -f "$pnpm_js" ]]; then
    echo "pnpm not found; set PNPM_BIN, add pnpm to PATH, or set PNPM_JS" >&2
    return 1
  fi
  "$node_bin" "$pnpm_js" "$@"
}

cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/xberg"
web_cache_dir="${XBERG_WEB_CACHE_DIR:-$cache_root/web-artifacts}"
mkdir -p "$web_cache_dir"

hash_changed() {
  local marker="$1"
  shift
  local current
  current="$(hash_tree "$@")"
  if [[ ! -f "$marker" ]]; then
    printf '%s\n' "$current" >"$marker"
    return 0
  fi
  local previous
  previous="$(cat "$marker")"
  if [[ "$current" != "$previous" ]]; then
    printf '%s\n' "$current" >"$marker"
    return 0
  fi
  return 1
}

build_wasm_fast() {
  local node_bin="$1"
  local marker="$web_cache_dir/wasm.sha256"
  if [[ "${FORCE_WEB_REBUILD:-0}" == "1" ]] || hash_changed "$marker" \
    "$REPO_ROOT/crates/xberg-wasm" \
    "$REPO_ROOT/crates/xberg" \
    "$REPO_ROOT/crates/xberg-tesseract" \
    "$REPO_ROOT/crates/xberg-gliner" \
    "$REPO_ROOT/crates/xberg-candle-embed" \
    "$REPO_ROOT/Cargo.toml" \
    "$REPO_ROOT/Cargo.lock" \
    "$REPO_ROOT/.cargo/config.toml"; then
    echo "== build xberg-wasm =="
    (
      unset CARGO_INCREMENTAL
      unset CARGO_BUILD_INCREMENTAL
      export RUSTC_WRAPPER=
      export CARGO_PROFILE_DEV_INCREMENTAL=false
      export CARGO_PROFILE_RELEASE_INCREMENTAL=false
      export CARGO_ENCODED_RUSTFLAGS=
      bash "$CARGO_LOCAL_SH" metadata --format-version=1 >/dev/null
      # Use a single-token wrapper path to avoid multi-token CARGO issues
      export CARGO_WRAPPER="$CARGO_LOCAL_SH"
      run_pnpm "$node_bin" --dir "$REPO_ROOT/crates/xberg-wasm" run build:wasm:web
    )
    "$node_bin" "$REPO_ROOT/crates/xberg-wasm/scripts/fix-wasi-imports.mjs"
  else
    echo "== reuse xberg-wasm =="
  fi
}

build_web_fast() {
  local node_bin="$1"
  local marker="$web_cache_dir/web.sha256"
  if [[ "${FORCE_WEB_REBUILD:-0}" == "1" ]] || hash_changed "$marker" \
    "$REPO_ROOT/apps/web" \
    "$REPO_ROOT/packages/wasm-pipeline" \
    "$REPO_ROOT/services/mcp-server/src" \
    "$REPO_ROOT/services/mcp-server/models" \
    "$REPO_ROOT/crates/xberg-wasm/pkg/web"; then
    echo "== build apps/web static export =="
    NEXT_TELEMETRY_DISABLED=1 run_pnpm "$node_bin" --dir "$REPO_ROOT/apps/web" build
  else
    echo "== reuse apps/web static export =="
  fi
}

ensure_playwright() {
  local node_bin="$1"
  local browser_dir="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  if find "$browser_dir" -maxdepth 2 \( -name 'chrome-headless-shell' -o -name 'chrome-headless-shell.exe' -o -name 'chromium' \) -print -quit 2>/dev/null | grep -q .; then
    echo "== reuse Playwright browsers =="
  else
    echo "== install Playwright Chromium =="
    run_pnpm "$node_bin" --dir "$REPO_ROOT/apps/web" exec playwright install chromium
  fi
}

doctor() {
  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/xberg"
  local local_cargo_home="${XBERG_LOCAL_CARGO_HOME:-$cache_root/cargo-home-no-wrapper}"
  echo "web_cache_dir: $web_cache_dir"
  echo "cargo_local_sh: $CARGO_LOCAL_SH"
  echo "cargo_local_home: $local_cargo_home"
  echo "web_out: $REPO_ROOT/apps/web/out"
  if [[ -e "$REPO_ROOT/apps/web/out/index.html" ]]; then
    stat "$REPO_ROOT/apps/web/out/index.html" 2>/dev/null || true
  else
    echo "missing"
  fi
  echo "wasm_pkg: $REPO_ROOT/crates/xberg-wasm/pkg/web/xberg_wasm.js"
  if [[ -e "$REPO_ROOT/crates/xberg-wasm/pkg/web/xberg_wasm.js" ]]; then
    stat "$REPO_ROOT/crates/xberg-wasm/pkg/web/xberg_wasm.js" 2>/dev/null || true
  else
    echo "missing"
  fi
  for marker in "$web_cache_dir/wasm.sha256" "$web_cache_dir/web.sha256"; do
    printf 'marker %s: ' "$marker"
    if [[ -f "$marker" ]]; then
      cat "$marker"
    else
      echo "missing"
    fi
  done
}

main() {
  local node_bin
  node_bin="$(resolve_node)" || {
    echo "node not found; set NODE_BIN or add node to PATH" >&2
    exit 1
  }
  case "$mode" in
    wasm)
      build_wasm_fast "$node_bin"
      ;;
    web)
      build_web_fast "$node_bin"
      ;;
    all)
      build_wasm_fast "$node_bin"
      build_web_fast "$node_bin"
      ;;
    playwright)
      ensure_playwright "$node_bin"
      ;;
    doctor)
      doctor
      ;;
    *)
      echo "usage: $0 [wasm|web|all|playwright|doctor]" >&2
      exit 1
      ;;
  esac
}

main
