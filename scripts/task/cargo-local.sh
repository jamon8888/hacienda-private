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

real_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/xberg"
local_cargo_home="${XBERG_LOCAL_CARGO_HOME:-$cache_root/cargo-home-no-wrapper}"
mkdir -p "$local_cargo_home"

link_if_missing() {
  local src="$1"
  local dst="$2"
  if [ -e "$src" ] && [ ! -e "$dst" ]; then
    ln -s "$src" "$dst"
  fi
}

link_if_missing "$real_cargo_home/bin" "$local_cargo_home/bin"
link_if_missing "$real_cargo_home/registry" "$local_cargo_home/registry"
link_if_missing "$real_cargo_home/git" "$local_cargo_home/git"
link_if_missing "$real_cargo_home/.crates.toml" "$local_cargo_home/.crates.toml"
link_if_missing "$real_cargo_home/.crates2.json" "$local_cargo_home/.crates2.json"

cat >"$local_cargo_home/config.toml" <<'EOF'
[build]
rustc-wrapper = ""
EOF

unset CARGO_INCREMENTAL
unset CARGO_BUILD_INCREMENTAL
export CARGO_HOME="$local_cargo_home"
export RUSTC_WRAPPER=""

exec cargo "$@"
