#!/bin/sh
# Build a macOS .pkg + .dmg for xberg-mcp.
# Prereqs: pkgbuild, productbuild, hdiutil (Xcode CLT).
# Assumes the wrapped binary 'xberg-mcp-darwin' is in the current dir.
set -eu

VERSION="${XBERG_VERSION:-1.0.0-rc.27}"
PKG_ID="io.xberg.mcp"
INSTALL_PREFIX="/usr/local/bin"
WORK="build-pkg"
rm -rf "$WORK" && mkdir -p "$WORK/root$INSTALL_PREFIX" "$WORK/scripts"

BIN="$PWD/xberg-mcp-darwin"
[ -f "$BIN" ] || { echo "ERROR: xberg-mcp-darwin not found in $PWD" >&2; exit 1; }

install -m 0755 "$BIN" "$WORK/root$INSTALL_PREFIX/xberg-mcp"

# LaunchAgent plist: runs 'xberg-mcp serve' on user login.
cat > "$WORK/root/Library/LaunchAgents/io.xberg.mcp.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.xberg.mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/xberg-mcp</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
PLIST

pkgbuild --identifier "$PKG_ID" \
  --version "$VERSION" \
  --root "$WORK/root" \
  --install-location "/" \
  "xberg-mcp-$VERSION.pkg"

# Optional notarization (release Task 3) — uncomment and set secrets:
# xcrun notarytool submit "xberg-mcp-$VERSION.pkg" --keychain-profile "xberg" --wait
# xcrun stapler staple "xberg-mcp-$VERSION.pkg"

# Wrap in a .dmg
hdiutil create -volname "Xberg MCP" -srcfolder "xberg-mcp-$VERSION.pkg" -ov -format UDZO "xberg-mcp-$VERSION.dmg"

echo "Built: xberg-mcp-$VERSION.pkg and xberg-mcp-$VERSION.dmg"
