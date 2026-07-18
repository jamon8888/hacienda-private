#!/bin/sh
# Build a Debian package for xberg-mcp from the wrapped binary.
# Prereqs: dpkg-deb (dpkg). GPG-sign per release Task 3.
set -eu

VERSION="${XBERG_VERSION:-1.0.0-rc.27}"
BIN="$PWD/xberg-mcp-linux"
[ -f "$BIN" ] || { echo "ERROR: xberg-mcp-linux not found in $PWD" >&2; exit 1; }

PKG="xberg-mcp_${VERSION}_amd64"
rm -rf "$PKG" && mkdir -p "$PKG/usr/local/bin" "$PKG/DEBIAN"

install -m 0755 "$BIN" "$PKG/usr/local/bin/xberg-mcp"

cat > "$PKG/DEBIAN/control" <<EOF
Package: xberg-mcp
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: xberg-io <dev@xberg.io>
Description: Local lawyer document-intelligence server + MCP endpoint (zero toolchain).
 Runs a fully-local document-intelligence service: privacy-preserving extraction,
 RAG, and an MCP endpoint. No Rust or system ONNX Runtime required.
EOF

dpkg-deb --build --root-owner-group "$PKG" "${PKG}.deb"
echo "Built: ${PKG}.deb"

# GPG detached signature (release Task 3):
# gpg --detach-sign --armor "${PKG}.deb"
