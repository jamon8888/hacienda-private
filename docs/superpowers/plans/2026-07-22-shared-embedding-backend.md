# Shared embedding backend implementation plan

## Status

The Rust backend and host wiring are implemented on the GLiNER2 branch. The
remaining release gates are now limited to runtime validation and publication:
numerical parity, browser latency/memory measurement, and artifact/CDN
publication. The Node MCP host no longer pretends to offer live vector
retrieval; it fails closed and points callers at the native Rust MCP host until
the dedicated vector-store adapter exists.

## Completed

- [x] Add `xberg-candle-embed` with the pinned Granite ModernBERT model,
  identity metadata, CLS pooling, normalization, and byte/file loading.
- [x] Compile the embedder for native Rust and `wasm32-unknown-unknown`.
- [x] Adapt native RAG, CLI, and native MCP to the shared embedder.
- [x] Expose byte loading through `xberg-wasm` and use it from a browser Worker.
- [x] Remove the browser ONNX/e5 embedding path and pin verified model artifacts.
- [x] Raise the RAG vector dimension to Granite's 384 and include identity in
  mirror bundles.
- [x] Keep GLiNER2 PII Guardrails (`fastino/GLiNER2-Guardrails-PII-Multi`) as
  the NER model; it is independent from the embedding model.

## Release gates

- [ ] Run a fixed-input numerical parity test against the reference Granite
  implementation on native and browser/WASM runtimes.
- [ ] Measure first-load, memory, and batch-indexing latency on a representative
  EU-language legal corpus; set explicit acceptance thresholds.
- [ ] Publish the three pinned artifacts and verify manifest/CDN downloads in a
  clean browser build.
- [x] Replace `services/mcp-server`'s placeholder `MirrorStore.retrieve` with
  the shared vector-store adapter, or document the native Rust MCP as the only
  vector retrieval path until that adapter lands.
- [x] Add browser snapshot re-open/query tests using the v2 identity guard and
  update all mirror fixtures.

## Release command

Run the remaining Granite release verification from a normal shell, not the
restricted Codex sandbox. Ensure `node`, `pnpm`, and `cargo` are on `PATH`, or
set `NODE_BIN`, `PNPM_BIN`, and `CARGO_BIN` explicitly:

```bash
cd /home/jamin/Documents/hacienda-private/.worktrees/gliner2-shared
scripts/verify-granite-release.sh
```

That command downloads the three pinned Granite artifacts from the manifest,
via `services/mcp-server`'s `ModelCache`, and the WASM client resolves the same
artifact URLs + SHA256 pins from `/models/manifest.json`. It then generates the
native Rust embedding report with
`crates/xberg-candle-embed/examples/granite_release_dump.rs`, and runs
`apps/web/e2e/granite-release.spec.ts` in Chromium against the real
`/models/granite/...` server paths. It enforces:

- exact identity equality
- native/browser vector delta `<= 1e-4`
- first-load `<= 480000 ms`
- batch embedding `<= 20000 ms`
- peak JS heap `<= 1250000000 bytes`
- local `/models/granite/...` delivery only, with no `huggingface.co` or CDN
  URLs in the browser resource list
