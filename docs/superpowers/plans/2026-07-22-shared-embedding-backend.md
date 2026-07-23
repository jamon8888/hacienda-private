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
