#!/bin/sh
# xberg-mcp one-liner installer (POSIX sh, no bashisms).
# Usage: curl -fsSL https://xberg-io.github.io/install.sh | sh
set -eu

RELEASE_BASE="${XBERG_RELEASE_BASE:-https://github.com/xberg-io/xberg/releases/latest/download}"
CHECKSUMS_URL="${RELEASE_BASE}/SHA256SUMS"

err() { echo "install.sh: $*" >&2; exit 1; }

# --- OS / arch detection ----------------------------------------------------
os=$(uname -s 2>/dev/null || echo unknown)
arch=$(uname -m 2>/dev/null || echo unknown)

case "$os" in
  Linux)  asset="xberg-mcp-linux" ;;
  Darwin) asset="xberg-mcp-darwin" ;;
  MINGW*|MSYS*|CYGWIN*|Windows*|*) asset="xberg-mcp-windows.exe" ;;
  *) err "unsupported OS: $os" ;;
esac

echo "Detected: ${os} / ${arch} -> ${asset}"

# --- download + verify ------------------------------------------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
target="$tmp/$asset"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$RELEASE_BASE/$asset" -o "$target"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$target" "$RELEASE_BASE/$asset"
else
  err "neither curl nor wget available"
fi

# Verify SHA256. Prefer the repository's SHA256SUMS file; fall back to a local map.
sum=""
if command -v curl >/dev/null 2>&1; then
  sums=$(curl -fsSL "$CHECKSUMS_URL" 2>/dev/null || true)
elif command -v wget >/dev/null 2>&1; then
  sums=$(wget -qO- "$CHECKSUMS_URL" 2>/dev/null || true)
fi

if [ -n "$sums" ]; then
  sum=$(printf '%s\n' "$sums" | awk -v a="$asset" '$2==a {print $1; exit}')
fi

if [ -z "$sum" ]; then
  # TODO_SHA256: replace with the real released hash. Verification is skipped until then.
  case "$asset" in
    xberg-mcp-linux)      sum="TODO_SHA256" ;;
    xberg-mcp-darwin)     sum="TODO_SHA256" ;;
    xberg-mcp-windows.exe) sum="TODO_SHA256" ;;
  esac
  if [ "$sum" = "TODO_SHA256" ]; then
    echo "WARNING: no checksum available (TODO_SHA256) - skipping verification. Update the release to publish SHA256SUMS."
  fi
fi

if [ "$sum" != "TODO_SHA256" ] && [ -n "$sum" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$target" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$target" | awk '{print $1}')
  else
    actual=""
  fi
  if [ -n "$actual" ] && [ "$actual" != "$sum" ]; then
    err "checksum mismatch: expected $sum got $actual"
  fi
  echo "Checksum verified."
fi

# --- install ----------------------------------------------------------------
dest_dir=""
if [ "$asset" = "xberg-mcp-windows.exe" ]; then
  dest_dir="$LOCALAPPDATA/Microsoft/WindowsApps"
else
  dest_dir="$HOME/.local/bin"
  if [ ! -d "$dest_dir" ]; then
    mkdir -p "$dest_dir" 2>/dev/null || { dest_dir="/usr/local/bin"; }
  fi
  if [ ! -w "$dest_dir" ] && [ "$dest_dir" != "/usr/local/bin" ]; then
    dest_dir="/usr/local/bin"
  fi
fi

mkdir -p "$dest_dir" 2>/dev/null || true
if [ ! -w "$dest_dir" ]; then
  if command -v sudo >/dev/null 2>&1; then
    sudo install -m 0755 "$target" "$dest_dir/$asset"
  else
    err "cannot write to $dest_dir; rerun with appropriate privileges"
  fi
else
  install -m 0755 "$target" "$dest_dir/$asset" 2>/dev/null || cp "$target" "$dest_dir/$asset"
fi

case "$dest_dir" in
  "$HOME/.local/bin") echo "Installed to $dest_dir. Ensure it is on your PATH (add: export PATH=\"\$HOME/.local/bin:\$PATH\")." ;;
  *) echo "Installed to $dest_dir." ;;
esac

echo "Run 'xberg-mcp serve' to open the UI, or 'xberg-mcp mcp' for Claude Desktop."
