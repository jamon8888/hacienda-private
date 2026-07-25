# Plan 6 — Release & CI

> Planning-only document. No build/CI commands are executed here. This is the distribution plan for
> the lightweight Node.js MCP server (`services/mcp-server`), the `@xberg-io/xberg-wasm` engine (Plan 2),
> and the Next.js web UI (Plan 3). It is the release and CI layer that makes those artifacts
> shippable to end users who never touch a Rust toolchain or run `cargo`.

## Goal

Ship the fully-local lawyer doc-intel app so end users install and run it with **zero toolchain** —
no cargo, no Rust, no system ONNX Runtime, no `pnpm build` of the engine. The app is fully local:
one Node.js service serves the browser UI + `@xberg-io/xberg-wasm` assets + pinned models + the MCP server.
The browser runs the entire engine on-device. ORT-Web / GLiNER.js run inside the browser (no system
ORT); `@xberg-io/xberg-wasm` is a prebuilt wasm package (no wasm compile for the user).

## Context

Users are lawyers, not developers — they cannot be expected to compile Rust, install a C++ ONNX
Runtime, or build WASM. The architecture is therefore built for **prebuilt distribution from day
one**:

- **The Node service is cross-OS via Node.js.** A single TypeScript service (`services/mcp-server`)
  runs on Windows / Linux / macOS with the user's Node runtime (or wrapped via `pkg`/`bun`/`nexe`
  into a standalone executable). No Rust, no cargo, no per-target native compile.
- **WASM + models are OS-independent.** `@xberg-io/xberg-wasm` is published as an npm package (one portable
  wasm32 build). Embeddings/PII models (e5 ONNX, gliner-pii ONNX) are format-stable blobs pinned by
  SHA256, downloaded from `the pinned model repos` and served by the Node service (`/models/*`). The browser
  loads ORT-Web + GLiNER.js from npm.
- The web UI (Plan 3, Next.js 14.2.5) compiles to static assets served by the Node service.

Consequently there is **no 6-target Rust matrix**. The only per-OS work is packaging the Node service
(+ optional wrapped binary) and installers/signing.

## Approach / Tasks

All CI lives under `.github/workflows/`. Release tooling (installers, one-liner script, package
manifests) lives under `services/mcp-server/release/` in the monorepo. Version is sourced from the
single root `package.json` `version` (mirrored by `apps/web/package.json` and
`packages/*/package.json`), kept in lockstep with the `@xberg-io/xberg-wasm` version — see **Versioning**.

### Task 1 — CI: build web UI + bundle Node service

- `.github/workflows/build.yml` — `build` job (single, no OS matrix needed for the service itself):
  - `pnpm install` at repo root.
  - `pnpm --filter web build` (Next.js 14.2.5 static export → `apps/web/out`).
  - `pnpm --filter mcp-server build` (tsup → `services/mcp-server/dist`, ESM).
  - Copy `apps/web/out` into `services/mcp-server/public/` so the service serves the UI at `/`.
  - Copy the installed `@xberg-io/xberg-wasm` pkg into `services/mcp-server/public/wasm/` (vendored, not
    fetched at runtime).

### Task 2 — Optional: wrap Node service into standalone executables (3 OSes)

- `.github/workflows/build.yml` — `wrap` job (matrix `os: windows-latest, ubuntu-latest,
  macos-latest`), using `pkg` (or `bun build --compile` / `nexe`) to produce `xberg-mcp` (or
  `xberg-mcp.exe`) from `services/mcp-server/dist/index.js` + the `public/` assets + the Node
  runtime. This yields a double-clickable binary without the user installing Node.
- Output: `xberg-mcp-windows.exe`, `xberg-mcp-darwin`, `xberg-mcp-linux`. (Optional — the plain
  `node dist/index.js serve` path also ships.)

### Task 3 — Code signing

- **Windows — Authenticode**: GitHub secret `WINDOWS_CODESIGN_P12` + `WINDOWS_CODESIGN_PASSWORD`
  over the wrapped `.exe` (Task 2) and any `.msi` (Task 7).
- **macOS — Notarization**: secrets `APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`, `APPLE_NOTARY_KEY`,
  `APPLE_NOTARY_KEY_ID`, `APPLE_TEAM_ID`. `codesign --options runtime --timestamp` then
  `xcrun notarytool submit` + `xcrun stapler staple` on the wrapped binary / `.pkg` / `.dmg`.
- **Linux — GPG**: secret `LINUX_GPG_KEY` detached-signs artefacts; public key in release notes.

### Task 4 — Artifacts → GitHub Releases

- `.github/workflows/release.yml` (tag-triggered, `v*.*.*`):
  - Collects the wrapped binaries (Task 2) + web/wasm assets + installers (Task 7) + model manifest.
  - Publishes a GitHub Release with assets:
    - `xberg-mcp-windows.exe`, `xberg-mcp-darwin`, `xberg-mcp-linux`
    - Installers: `xberg-mcp-windows.msi`, `xberg-mcp-macos.pkg` + `.dmg`, `xberg-mcp-linux.deb/.rpm/AppImage`
    - `models-manifest.json` (SHA256 pins for e5 + gliner-pii + tokenizer)
    - Optional `xberg-mcp-offline.zip` (pre-populated model cache for air-gapped lawyers)
  - Release body auto-generated from `CHANGELOG.md` + commit range; includes the GPG public key and
    SHA256 of every asset.

### Task 5 — One-liner installer + package managers

- `services/mcp-server/release/install.sh` — POSIX `sh`:
  - Detects OS/arch (`uname -s`/`uname -m`), maps to the asset from Task 4, downloads (verifies
    SHA256), extracts to `~/.local/bin` (or `/usr/local/bin`), adds to PATH.
  - Windows `install.ps1` (PowerShell) for `winget`/manual paths.
  - Served at `https://xberg-io.github.io/install.sh`.
- Package manifests:
  - **Homebrew tap** `xberg-io/tap/xberg-mcp` (Cask pulling the macOS asset + SHA256).
  - **winget** `xberg-io.XbergMcp.yaml` (`InstallerType: exe`, SHA256).
  - **scoop** `xberg-mcp.json` bucket manifest.

### Task 6 — Installers per OS

- **Windows**: WiX `xberg-mcp.wxs` → `.msi` (PATH, Start Menu shortcut, silent `xberg-mcp serve` on
  login optional). Signed per Task 3.
- **macOS**: `pkgbuild` + `productbuild` → `.pkg` (installs to `/usr/local/bin`, LaunchAgent plist);
  wrap in `.dmg`. Notarized per Task 3.
- **Linux**: `.deb` (cargo-deb-style / `dpkg-deb`), `.rpm` (`rpmbuild`), **AppImage** (AppDir with
  the wrapped binary + `public/` assets; `AppRun` launches `xberg-mcp serve`). GPG-signed per Task 3.

### Task 7 — Models: lazy (default) + offline bundle

- **Default (lazy)**: on first run the Node service downloads e5 ONNX, gliner-pii ONNX, and the
  tokenizer from `the pinned model repos`, each verified against `models-manifest.json` (SHA256). Failure → abort
  with a clear suggestion (no path leak). Served to the browser at `/models/*`.
- **Offline asset**: `release.yml` also produces `xberg-mcp-offline.zip` that pre-populates the data
  dir (`~/.xberg/models/`) with all pinned models. Documented in release notes.
- The browser uses ORT-Web + GLiNER.js from npm (no separate model host needed beyond `/models/*`).

### Task 8 — Claude Desktop / MCP entry

- Document that the shipped service is the MCP server: `node dist/index.js mcp` (or the wrapped
  `xberg-mcp mcp`). Provide a copy-paste `claude_desktop_config.json`:

  ```json
  { "mcpServers": { "xberg": { "command": "xberg-mcp", "args": ["mcp"] } } }
  ```

- Note: because there is no Rust and no system ORT, the MCP entry works on a clean machine with only
  the wrapped binary (or Node) on PATH.

### Task 9 — Versioning (single source)

- Version source of truth: root `package.json` `version` (= `@xberg-io/xberg-wasm` version). `apps/web`,
  `packages/*`, and the wrapped binary are stamped with the same string by `release.yml`. Tag format
  `vX.Y.Z` triggers `release.yml`. Changelog generated from conventional commits into `CHANGELOG.md`.

## Depends on

- **Plan 1** — Node service serves UI + wasm + `/models/*` + MCP (`services/mcp-server`).
- **Plan 2** — `packages/wasm-pipeline` + `@xberg-io/xberg-wasm` (prebuilt npm, no wasm compile for user).
- **Plan 3** — `apps/web` Next.js static build served by the service.

## Verification

- **CI green** on `build.yml` + `release.yml` for a `v*` tag.
- **Clean-VM smoke test** (no cargo, no Rust, no system ORT): download the matching asset on a fresh
  Windows/Linux/macOS VM → `xberg-mcp serve` opens the bundled UI → `xberg-mcp mcp` reachable by
  Claude Desktop.
- **Models auto-download**: first run fetches pinned models, SHA256-verified; offline asset boots
  with zero network.
- **Signed artefacts pass OS gates**: Windows SmartScreen (Authenticode); macOS Gatekeeper (notarized
  - stapled); Linux GPG signatures verify.
- **One-liner installer** resolves correct asset per OS/arch and installs to PATH; `brew install
  xberg-io/tap/xberg-mcp`, `winget install xberg-io.XbergMcp`, `scoop install xberg-mcp` succeed.

## Risks / Non-goals

**Non-goals**

- Requiring end users to build from source (no `cargo install`, no `pnpm build` of the engine).
- Shipping a system-ORT-dependent component. ORT-Web runs inside the browser; the Node service has no
  ORT.
- Per-OS WASM builds (`@xberg-io/xberg-wasm` is one portable npm package).

**Risks & mitigations**

- **Signing cert management** — store Authenticode + Apple certs in GitHub encrypted secrets; rotate
  via runbook; never log private keys.
- **macOS notarization latency** — run notarization as a parallel post-build step, poll with timeout.
- **Large model download** — e5/gliner-pii ONNX are sizable; mitigate with the offline bundle,
  resumable downloads, and caching in the browser (IndexedDB) + Node data dir.
- **Node version drift** — pin an Engine policy (e.g. Node 20 LTS) for the plain `node` path; the
  wrapped binary embeds its own runtime so drift can't break it.
- **Version drift** — single-source versioning enforced by `release.yml` precondition that fails the
  build if `package.json` versions differ.

## 2026-07-23 GLiNER2 release amendment

The official GLiNER2 privacy checkpoint must not be silently added to the
default installer or offline bundle.

- [ ] Publish exact model/tokenizer/config byte sizes, hashes, license,
  immutable revision, and seven-language support metadata.
- [ ] Make GLiNER2 an optional lazy component with resumable download and
  disk/cache/memory preflight.
- [ ] Produce a browser-specific F16 or quantized artifact before considering
  default browser enablement.
- [ ] Cache the real model only in dedicated native/WASM parity jobs; retain
  invalid-byte and binding smoke coverage in ordinary CI.
