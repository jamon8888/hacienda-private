# Granite Resume

Date: 2026-07-24
Repo: `/home/jamin/Documents/hacienda-private`
Worktree: `/home/jamin/Documents/hacienda-private/.worktrees/gliner2-shared`
Branch: `feat/gliner2-shared`

## Goal

Finish Granite shared-embedding release verification for native + browser/WASM.

## Resume Command

Run from the worktree:

```bash
cd /home/jamin/Documents/hacienda-private/.worktrees/gliner2-shared
NODE_BIN=/home/jamin/.local/node/bin/node PNPM_JS=/home/jamin/.local/node/lib/node_modules/corepack/dist/pnpm.js XBERG_MODEL_FETCH_TIMEOUT_MS=300000 XBERG_MODEL_FETCH_RETRIES=6 scripts/verify-granite-release.sh
```

## Current Status

- Native Granite parity path now builds and runs.
- Playwright Chromium install is handled by `scripts/verify-granite-release.sh`.
- Granite artifacts now resolve through `services/mcp-server` `ModelCache` rather than the old one-off fetch script.
- Browser `/release/granite` route now resolves through the MCP server static fallback.
- WASM build is being switched from the stale published `@xberg-io/xberg-wasm` package to the local workspace package.

## Last Active Failure

Latest failure before this note:

- `crates/xberg-wasm/src/lib.rs` had the wrong trait import path.
- Fixed from `use xberg_rag::embed::Embedder;` to `use xberg_rag::Embedder;`

Next step after reboot:

1. rerun `scripts/verify-granite-release.sh`
2. inspect the next failing stage, if any

## Important Local Changes Already Made

- `scripts/verify-granite-release.sh`
  - resolves `node` / `pnpm`
  - installs Playwright Chromium
  - builds local `crates/xberg-wasm`
  - rebuilds `apps/web`
- `services/mcp-server/src/models.ts`
  - Granite artifact resolution added
  - retry/timeout logic moved into canonical model cache path
- `services/mcp-server/src/index.ts`
  - serves `/models/manifest.json`
  - static fallback fixed for `/release/granite`
- `packages/wasm-pipeline/src/model-manifest.ts`
  - browser resolves Granite artifact URLs/SHA256 from the MCP manifest
- `packages/wasm-pipeline/src/granite-embed.ts`
  - now uses manifest-resolved Granite artifacts
- `crates/xberg-candle-embed/src/lib.rs`
  - native Granite loader now tolerates multiple safetensor key layouts
- `packages/wasm-pipeline/package.json`
  - `@xberg-io/xberg-wasm` switched to `workspace:*`
- `services/mcp-server/package.json`
  - `@xberg-io/xberg-wasm` switched to `workspace:*`
- `crates/xberg-wasm/Cargo.toml`
  - added direct `xberg-rag` dependency
  - local feature set adjusted during debugging

## Known Environment Requirements

- `wasm-pack` must be installed.
- Full OCR-WASM builds may require `WASI_SDK_PATH` depending on the final `crates/xberg-wasm` feature surface.
- Node path in use:
  - `/home/jamin/.local/node/bin/node`
- pnpm JS entrypoint in use:
  - `/home/jamin/.local/node/lib/node_modules/corepack/dist/pnpm.js`

## If Codex Session Is Lost

Reopen the repo and say:

`Resume Granite release work from docs/superpowers/notes/granite-resume.md in .worktrees/gliner2-shared`
