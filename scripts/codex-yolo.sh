#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHIM_DIR="$REPO_ROOT/.codex/bin"

# Codex is installed through snap on this machine, but the Rust/Node toolchains
# we actually want it to use live under the real user home.
REAL_HOME="${REAL_HOME:-/home/jamin}"
export SNAP_REAL_HOME="${SNAP_REAL_HOME:-$REAL_HOME}"

append_path_if_dir() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    PATH="$dir:$PATH"
  fi
}

command_path() {
  local name="$1"
  local candidate=""
  if candidate="$(command -v "$name" 2>/dev/null)"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

write_shim() {
  local name="$1"
  local target="$2"
  mkdir -p "$SHIM_DIR"
  cat >"$SHIM_DIR/$name" <<EOF
#!/usr/bin/env bash
exec "$target" "\$@"
EOF
  chmod +x "$SHIM_DIR/$name"
}

append_path_if_dir "$REAL_HOME/.cargo/bin"
append_path_if_dir "$REAL_HOME/.local/node/bin"
append_path_if_dir "$REAL_HOME/.local/share/pnpm"
append_path_if_dir "$REAL_HOME/.npm-global/bin"
append_path_if_dir "$REAL_HOME/.local/bin"
append_path_if_dir "$REAL_HOME/.volta/bin"
append_path_if_dir "$REAL_HOME/.fnm"
append_path_if_dir "/snap/bin"

for nvm_bin_dir in "$REAL_HOME"/.nvm/versions/node/*/bin; do
  append_path_if_dir "$nvm_bin_dir"
done

if ! command -v node >/dev/null 2>&1; then
  if nodejs_path="$(command_path nodejs)"; then
    write_shim node "$nodejs_path"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if corepack_path="$(command_path corepack)"; then
    mkdir -p "$SHIM_DIR"
    cat >"$SHIM_DIR/pnpm" <<EOF
#!/usr/bin/env bash
exec "$corepack_path" pnpm "\$@"
EOF
    chmod +x "$SHIM_DIR/pnpm"
  fi
fi

append_path_if_dir "$SHIM_DIR"
export PATH

CODEX_BIN="${CODEX_BIN:-/snap/codex/34/bin/codex}"

if [[ ! -x "$CODEX_BIN" ]]; then
  echo "codex binary not found at $CODEX_BIN" >&2
  exit 1
fi

MODE="${CODEX_YOLO_MODE:-full-auto}"

COMMON_ARGS=(
  --cd "$REPO_ROOT"
  --no-alt-screen
)

case "$MODE" in
  full-auto)
    MODE_ARGS=(--full-auto)
    ;;
  workspace-write)
    MODE_ARGS=(--sandbox workspace-write --ask-for-approval on-request)
    ;;
  danger)
    MODE_ARGS=(--dangerously-bypass-approvals-and-sandbox)
    ;;
  *)
    echo "unsupported CODEX_YOLO_MODE: $MODE" >&2
    echo "expected one of: full-auto, workspace-write, danger" >&2
    exit 1
    ;;
esac

cat <<EOF
Launching Codex
  repo:   $REPO_ROOT
  mode:   $MODE
  cargo:  $(command -v cargo || echo missing)
  node:   $(command -v node || echo missing)
  pnpm:   $(command -v pnpm || echo missing)
EOF

exec "$CODEX_BIN" "${COMMON_ARGS[@]}" "${MODE_ARGS[@]}" "$@"
