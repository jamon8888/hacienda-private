#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REAL_HOME="${REAL_HOME:-/home/jamin}"
REPO_ROOT="${CODEX_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
CODEX_BIN="${CODEX_BIN:-/snap/codex/34/bin/codex}"
CODEX_MODE="${CODEX_REAL_MODE:-danger}"

append_path_if_dir() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    PATH="$dir:$PATH"
  fi
}

export REAL_HOME
export SNAP_REAL_HOME="${SNAP_REAL_HOME:-$REAL_HOME}"
export GIT_EXEC_PATH="${GIT_EXEC_PATH:-/usr/lib/git-core}"

append_path_if_dir "$REAL_HOME/.local/node/bin"
append_path_if_dir "$REAL_HOME/.local/bin"
append_path_if_dir "$REAL_HOME/.cargo/bin"
append_path_if_dir "$REAL_HOME/.npm-global/bin"
append_path_if_dir "$REAL_HOME/.local/share/pnpm"
append_path_if_dir "$GIT_EXEC_PATH"
append_path_if_dir "/usr/bin"
append_path_if_dir "/bin"
append_path_if_dir "/snap/bin"

export PATH

if [[ ! -x "$CODEX_BIN" ]]; then
  echo "codex binary not found at $CODEX_BIN" >&2
  exit 1
fi

if [[ ! -d "$REPO_ROOT" ]]; then
  echo "repo root not found at $REPO_ROOT" >&2
  exit 1
fi

case "$CODEX_MODE" in
  danger)
    MODE_ARGS=(--dangerously-bypass-approvals-and-sandbox)
    ;;
  full-auto)
    MODE_ARGS=(--full-auto)
    ;;
  workspace-write)
    MODE_ARGS=(--sandbox workspace-write --ask-for-approval on-request)
    ;;
  *)
    echo "unsupported CODEX_REAL_MODE: $CODEX_MODE" >&2
    echo "expected one of: danger, full-auto, workspace-write" >&2
    exit 1
    ;;
esac

echo "toolchain check"
for tool in git node gh poly cargo; do
  tool_path="$(command -v "$tool" 2>/dev/null || true)"
  if [[ -n "$tool_path" ]]; then
    echo "  $tool: $tool_path"
  else
    echo "  $tool: missing"
  fi
done

echo "git exec-path: $(git --exec-path 2>/dev/null || echo missing)"
if command -v node >/dev/null 2>&1; then
  echo "node version: $(node --version 2>/dev/null || echo unavailable)"
fi
if command -v gh >/dev/null 2>&1; then
  echo "gh auth: $(gh auth status >/dev/null 2>&1 && echo ok || echo unavailable)"
fi
if command -v poly >/dev/null 2>&1; then
  echo "poly version: $(poly --version 2>/dev/null || echo unavailable)"
fi
if command -v cargo >/dev/null 2>&1; then
  echo "cargo version: $(cargo --version 2>/dev/null || echo unavailable)"
fi

cd "$REPO_ROOT"
exec "$CODEX_BIN" --cd "$REPO_ROOT" --no-alt-screen "${MODE_ARGS[@]}" "$@"
