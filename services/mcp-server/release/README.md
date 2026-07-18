# Xberg MCP — Release & Distribution

Local lawyer document-intelligence server + MCP endpoint. **Zero toolchain**: no Rust,
no `cargo`, no system ONNX Runtime. The browser runs the entire engine on-device; this
Node service serves the UI, the `@xberg-io/xberg-wasm` assets, and the pinned models.

## Quick start

```sh
# Wrapped binary (no Node required):
xberg-mcp serve          # opens the bundled UI at http://localhost:8787
xberg-mcp mcp            # stdio MCP endpoint for Claude Desktop

# Or plain Node:
node dist/index.js serve
node dist/index.js mcp
```

The UI is served at **<http://localhost:8787**>. For Claude Desktop, copy
[`claude_desktop_config.json`](./claude_desktop_config.json) into your
`~/Library/Application Support/Claude/` (macOS) / `%APPDATA%\Claude\` (Windows) /
`~/.config/Claude/` (Linux) config dir, then restart Claude Desktop.

## Install one-liner

```sh
# macOS / Linux
curl -fsSL https://xberg-io.github.io/install.sh | sh

# Windows (PowerShell)
irm https://xberg-io.github.io/install.ps1 | iex
```

The installer detects OS/arch, downloads the matching `xberg-mcp-*` asset, verifies its
SHA256 against the release `SHA256SUMS`, and installs to `~/.local/bin` (or
`/usr/local/bin`). At first release `SHA256SUMS` is the source of truth; a `TODO_SHA256`
placeholder is used until published.

## Package managers

| Manager | Command |
| ------- | ------- |
| Homebrew (tap) | `brew install xberg-io/tap/xberg-mcp` |
| winget | `winget install xberg-io.XbergMcp` |
| scoop | `scoop install xberg-mcp` |

Manifests: [`homebrew/xberg-mcp.rb`](./homebrew/xberg-mcp.rb),
[`winget/xberg-io.XbergMcp.yaml`](./winget/xberg-io.XbergMcp.yaml),
[`scoop/xberg-mcp.json`](./scoop/xberg-mcp.json).

## Offline bundle (air-gapped)

`make-offline-bundle.mjs` produces `offline/xberg-mcp-offline.zip`, pre-populated with
every pinned model. Extract it into `~/.xberg/models/` on a machine with no network.

## Model pinning (operator procedure)

Models are SHA256-pinned in [`../models/manifest.json`](../models/manifest.json) — the
server **refuses to serve** any model whose hash is the `TODO_PIN_SHA256` placeholder
(fails closed). To pin real hashes (requires network access once):

```sh
node scripts/pin-models.mjs
```

This downloads each model, computes its SHA256, and rewrites the manifest in place
(idempotent — already-pinned entries are skipped). CI runs
`scripts/check-pins.mjs` as a release precondition; it exits non-zero if any placeholder
remains.

## Scripts

| Script | Purpose |
| ------ | ------- |
| `scripts/pin-models.mjs` | Download + SHA256-pin models into the manifest |
| `scripts/make-offline-bundle.mjs` | Build `xberg-mcp-offline.zip` |
| `scripts/check-pins.mjs` | Guard: exit 1 if any `TODO_PIN_SHA256` remains |

## Installers (authoring scripts)

| OS | Script | Output |
| -- | ------ | ------ |
| Windows | [`windows/xberg-mcp.wxs`](./windows/xberg-mcp.wxs) | `.msi` (candle/light) |
| macOS | [`macos/build-pkg.sh`](./macos/build-pkg.sh) | `.pkg` + `.dmg` |
| Linux | [`linux/build-deb.sh`](./linux/build-deb.sh), [`build-rpm.sh`](./linux/build-rpm.sh), [`build-appimage.sh`](./linux/build-appimage.sh) | `.deb` / `.rpm` / `AppImage` |

Signing (Authenticode / notarization / GPG) is wired as commented steps in each script
per release Task 3.

## Versioning

Single source of truth: root `package.json` `version` (`1.0.0-rc.27`). Binaries,
manifests, and installers are stamped from it by the release workflow.
