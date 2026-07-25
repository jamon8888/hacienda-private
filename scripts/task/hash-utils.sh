#!/usr/bin/env bash

set -euo pipefail

hash_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum"
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    echo "shasum -a 256"
    return 0
  fi
  return 1
}

hash_tree() {
  if [ "$#" -lt 1 ]; then
    echo "usage: hash_tree <path> [path...]" >&2
    return 1
  fi
  local hasher
  hasher="$(hash_cmd)" || {
    echo "sha256 tool not found" >&2
    return 1
  }

  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN

  for path in "$@"; do
    if [ -d "$path" ]; then
      find "$path" -type f \
        ! -path '*/target/*' \
        ! -path '*/node_modules/*' \
        ! -path '*/.next/*' \
        ! -path '*/out/*' \
        ! -path '*/pkg/*' \
        -print0
    elif [ -e "$path" ]; then
      printf '%s\0' "$path"
    fi
  done | sort -z | while IFS= read -r -d '' file; do
    printf '%s\0' "$file" >>"$tmp"
    eval "$hasher \"\$file\"" | awk '{print $1}' >>"$tmp"
  done

  eval "$hasher \"\$tmp\"" | awk '{print $1}'
}
