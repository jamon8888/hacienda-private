#!/bin/sh
# Build an RPM package for xberg-mcp from the wrapped binary.
# Prereqs: rpmbuild. GPG-sign per release Task 3.
set -eu

VERSION="${XBERG_VERSION:-1.0.0-rc.27}"
BIN="$PWD/xberg-mcp-linux"
[ -f "$BIN" ] || { echo "ERROR: xberg-mcp-linux not found in $PWD" >&2; exit 1; }

TOP="$(mktemp -d)"
trap 'rm -rf "$TOP"' EXIT
mkdir -p "$TOP/BUILD" "$TOP/RPMS" "$TOP/SOURCES" "$TOP/SPECS"

install -m 0755 "$BIN" "$TOP/SOURCES/xberg-mcp"

cat > "$TOP/SPECS/xberg-mcp.spec" <<EOF
Name:           xberg-mcp
Version:        $VERSION
Release:        1
Summary:        Local lawyer document-intelligence server + MCP endpoint
License:        MIT
URL:            https://github.com/xberg-io/xberg
BuildArch:      x86_64

%description
Fully-local document-intelligence service: privacy-preserving extraction, RAG,
and an MCP endpoint. No Rust or system ONNX Runtime required.

%install
mkdir -p %{buildroot}/usr/local/bin
install -m 0755 %{_sourcedir}/xberg-mcp %{buildroot}/usr/local/bin/xberg-mcp

%files
/usr/local/bin/xberg-mcp

%changelog
* Thu Jul 15 2026 xberg-io <dev@xberg.io> - $VERSION-1
- Release build
EOF

rpmbuild --define "_topdir $TOP" -bb "$TOP/SPECS/xberg-mcp.spec"
find "$TOP/RPMS" -name '*.rpm' -exec cp {} . \;
echo "Built RPM(s) in current dir."

# GPG sign (release Task 3):
# rpm --addsign xberg-mcp-*.rpm
