#!/bin/sh
# Build an AppImage for xberg-mcp from the wrapped binary.
# Prereqs: appimagetool (https://appimage.org). GPG-sign per release Task 3.
set -eu

VERSION="${XBERG_VERSION:-1.0.0-rc.27}"
BIN="$PWD/xberg-mcp-linux"
[ -f "$BIN" ] || { echo "ERROR: xberg-mcp-linux not found in $PWD" >&2; exit 1; }

APP="AppDir"
rm -rf "$APP" && mkdir -p "$APP/usr/bin"

install -m 0755 "$BIN" "$APP/usr/bin/xberg-mcp"

cat > "$APP/AppRun" <<'RUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/xberg-mcp" serve "$@"
RUN
chmod +x "$APP/AppRun"

cat > "$APP/xberg-mcp.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Xberg MCP
Exec=xberg-mcp serve
Icon=xberg-mcp
Categories=Utility;
EOF

cat > "$APP/xberg-mcp.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#1f6feb"/></svg>
SVG

if command -v appimagetool >/dev/null 2>&1; then
  appimagetool "$APP" "xberg-mcp-$VERSION.AppImage"
  echo "Built: xberg-mcp-$VERSION.AppImage"
else
  echo "ERROR: appimagetool not found. Install from https://appimage.org" >&2
  exit 1
fi

# GPG sign (release Task 3):
# gpg --detach-sign --armor "xberg-mcp-$VERSION.AppImage"
