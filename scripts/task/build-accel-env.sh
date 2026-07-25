#!/usr/bin/env bash

set -euo pipefail

mode="${1:-env}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

have() {
  command -v "$1" >/dev/null 2>&1
}

print_env() {
  local rustflags="${RUSTFLAGS:-}"
  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/xberg"

  echo "export CARGO_BUILD_JOBS=\${CARGO_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
  echo "export CARGO_TARGET_DIR=\"${cache_root}/target-shared\""
  echo "export SCCACHE_BASEDIRS=\"${repo_root}\""

  if have sccache; then
    echo "unset CARGO_INCREMENTAL"
    echo "# sccache detected at $(command -v sccache), but local fast tasks disable it"
    echo "# because the current ~/.cargo/config.toml wrapper setup is still incompatible here."
  else
    echo "export CARGO_INCREMENTAL=1"
    echo "# sccache not found; install it to cache Rust compiler outputs"
  fi

  if have mold; then
    if [ -n "$rustflags" ]; then
      echo "export RUSTFLAGS=\"${rustflags} -C link-arg=-fuse-ld=mold\""
    else
      echo "export RUSTFLAGS=\"-C link-arg=-fuse-ld=mold\""
    fi
  else
    echo "# mold not found; install it to speed Linux linking"
  fi
}

print_doctor() {
  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/xberg"
  local target_dir="${CARGO_TARGET_DIR:-$cache_root/target-shared}"
  local local_cargo_home="${XBERG_LOCAL_CARGO_HOME:-$cache_root/cargo-home-no-wrapper}"

  printf "sccache: "
  if have sccache; then
    command -v sccache
  else
    echo "missing"
  fi

  printf "mold: "
  if have mold; then
    command -v mold
  else
    echo "missing"
  fi

  printf "rustc: "
  if have rustc; then
    rustc --version
  else
    echo "missing"
  fi

  printf "cargo: "
  if have cargo; then
    cargo --version
  else
    echo "missing"
  fi

  printf "pnpm: "
  if have pnpm; then
    pnpm --version
  else
    echo "missing"
  fi

  printf "logical_cpus: "
  getconf _NPROCESSORS_ONLN 2>/dev/null || echo "unknown"

  printf "shared_target_dir: %s\n" "$target_dir"
  printf "local_cargo_home: %s\n" "$local_cargo_home"

  printf "nightly_toolchain: "
  if have rustup; then
    rustup toolchain list 2>/dev/null | sed -n '/nightly/p' | head -n 1 || true
  else
    echo "rustup missing"
  fi

  printf "cranelift_component: "
  if have rustup; then
    if rustup component list --toolchain nightly 2>/dev/null | grep -q '^rustc-codegen-cranelift-preview.*installed'; then
      echo "installed"
    else
      echo "missing"
    fi
  else
    echo "rustup missing"
  fi

  printf "zram_swap: "
  if [ -r /proc/swaps ] && grep -q '/dev/zram' /proc/swaps; then
    echo "enabled"
  else
    echo "disabled"
  fi

  if have zramctl; then
    echo
    zramctl 2>/dev/null || true
  fi

  if have sccache; then
    printf "sccache_basedirs: %s\n" "${SCCACHE_BASEDIRS:-unset}"
    echo
    sccache --show-stats 2>/dev/null || true
  fi
}

case "$mode" in
  env)
    print_env
    ;;
  doctor)
    print_doctor
    ;;
  zram-doctor)
    if [ -r /proc/swaps ] && grep -q '/dev/zram' /proc/swaps; then
      echo "zram is enabled"
      if have zramctl; then
        zramctl 2>/dev/null || true
      fi
    else
      echo "zram is disabled"
      echo "Ubuntu: sudo apt-get install -y zram-tools && sudo systemctl enable --now zramswap.service"
    fi
    ;;
  *)
    echo "usage: $0 [env|doctor|zram-doctor]" >&2
    exit 1
    ;;
esac
