# P2 native RAG status (2026-07-21)

Written at the close of Phase 2 (Tasks 1-7 on `feat/isomorphic-rag-core`, commits `ee978324e0`
through `2019c97735`). Covers what P3 and P2b start from.

## 1. What is live now

Two entry points, both wired to `RagEngine::{index_documents, query, import_legacy}` in
`crates/xberg-rag/src/engine.rs`:

- **`xberg-cli` `rag` subcommand** (`crates/xberg-cli/src/main.rs`, `RagAction` enum, lines
  389-451), three actions:
  - `xberg rag index --matter <id> --input <path> [--mirrors-dir <dir>] [--embedder preset|mock] [--preset lightweight] [--chunk-size 512]`
    — chunks, embeds, and indexes every text file under `--input`.
  - `xberg rag query --matter <id> --text "<query>" [--top-k 8] [--mirrors-dir <dir>] [--embedder preset|mock] [--preset lightweight] [--format text|json]`
    — live similarity search against the matter's actual vectors.
  - `xberg rag import-legacy --matter <id> [--mirrors-dir <dir>] [--embedder preset|mock] [--preset lightweight]`
    — rebuilds a native snapshot from a legacy JSON `MirrorBundle` (`bundle.json`).
  - `--mirrors-dir` defaults to `$XBERG_DATA_DIR/mirrors`, else `~/.xberg/mirrors`.
  - `--embedder mock` exists for tests only; `preset` (the default) uses a real
    `XbergEmbedder` and never touches the network in CI (see below).

- **MCP `rag_query` tool** (`crates/xberg/src/mcp/rag.rs`) — default **OFF**. Enabled only when
  `XBERG_RAG_ENABLED` is `1`, `true`, or `TRUE` (`is_enabled()`, rag.rs:20-25); the route is
  gated at runtime via `ToolRouter::with_disabled` rather than a cargo feature, because rmcp
  2.2.0's `tool_router` macro emits routes without propagating `#[cfg]` (a gated `#[tool]`
  method fails to compile). To try it:

  ```bash
  XBERG_RAG_ENABLED=1 xberg mcp
  ```

  then call `rag_query` with `{ "matter_id": "...", "query": "...", "top_k": 8 }` over the MCP
  stdio/http transport. The embedding preset used server-side is controlled by
  `XBERG_RAG_PRESET` (default `lightweight`, `preset_name()` at rag.rs:32-34).

Targeted builds and automated tests ran during the review-fix pass (see "Verification status"
below), but the real-model CLI/MCP commands above were not executed end-to-end.

## 2. Backend in use

`FlatStore` (`crates/xberg-rag/src/flat.rs`) — exact brute-force cosine similarity, O(n) over
the matter's indexed chunks, with non-finite stored and query vectors rejected before ranking.
It is explicitly documented in its own doc comment as "the correctness oracle for P2's HNSW
backend," i.e. it was always meant to be superseded, not tuned.

**No latency measurement exists yet.** The verification pass tested correctness but did not run
a representative benchmark. Do not treat the absence of a number here as "fast enough" — it is
simply unmeasured. Before P2b (the HNSW swap) can claim an improvement, it needs a baseline:
pick the largest real or synthetic matter available, record `FlatStore` query latency and its
exact chunk count first, on an actual `cargo build --workspace`-verified binary, then compare
the HNSW backend against that same matter.

## 3. Dimension in use

- **Native host (server / CLI / MCP) default:** the `lightweight` preset — model2vec, pure
  Rust, `EmbeddingBackend::Static`, **256 dimensions** (`crates/xberg/src/embeddings/mod.rs`,
  the `EMBEDDING_PRESETS` table, preset `"lightweight"`: `dimensions: 256`, `model_file:
  "potion-base-8m/model.safetensors"`). Chosen specifically so the server never hard-requires a
  bundled ONNX Runtime (spec's R3 mitigation, restated in `crates/xberg/src/mcp/rag.rs:27-34`).
- **Browser host:** e5-base, **768 dimensions** (`packages/wasm-pipeline/src/constants.ts`,
  `export const EMBED_DIM = 768;`, documented there as "Embedding dimensionality of
  multilingual-e5-base").

These are two different embedding spaces at two different dimensionalities. **Cross-host top-K
equivalence is NOT achievable today** — a chunk vector produced by the browser's e5-base
pipeline and one produced by the native `lightweight` preset are not comparable, and nothing in
P2 attempted to make them comparable. This was a known, accepted limitation going into this
phase (not a regression introduced by it), and reconciling the two — either by moving the
browser onto the same model family/dimension as the native host, or by defining an explicit
migration/re-embedding step — is P3's job (wire-format migration), not P2b's. Tracked as GitHub
issue #30. The reconciliation design (candle-based shared backend, BGE-M3, strict per-host
identity) is now written up separately:
`docs/superpowers/specs/2026-07-22-shared-embedding-backend-design.md`.

## 4. Node host status

`services/mcp-server` remains the deployed host. Its RAG implementation is still browser-owned,
but its mirror path builder now rejects empty and dot-segment matter ids for parity with the Rust
host:

```bash
git diff main -- services/mcp-server/src/mirror.ts services/mcp-server/tests/mirror.test.ts
```

The Rust-native `rag_query` tool built in Task 7 still lives only in `crates/xberg`
(the `xberg-cli`/`xberg` MCP host); the browser/Node host referenced by spec R6 remains a later
host-migration phase.

## 5. P2b entry conditions

The HNSW backend swap is architecturally confined to one new `SearchStore` implementation
(`crates/xberg-rag/src/store.rs` defines the trait: `new`, `ingest`, `search`, `len`,
`is_empty`, `snapshot`, `load`) plus one construction site inside `RagEngine`
(`crates/xberg-rag/src/engine.rs`, the two `FlatStore::new(self.embedder.dim())` call sites,
lines 51 and 170). This was already true when P1 was planned and nothing in P2 changed that
shape.

**It cannot start yet.** P1 Task 5 — the `edgevec`-native compile-gate spike ("prove `edgevec`
0.9.0 compiles native + wasm32", `crates/xberg-rag/examples/edgevec_smoke.rs` +
`docs/superpowers/notes/2026-07-21-edgevec-native-spike.md`) — was **never executed** in this
branch. It was skipped by an earlier session decision, for two reasons found at the time, not
guessed at now:

1. The plan's original R1 premise about the crates.io-published `edgevec` 0.9.0 was
   independently found to be stale.
2. A worse problem surfaced: `edgevec` carries an **unconditional** `wasm-bindgen` dependency,
   which is a problem for a crate meant to compile cleanly on a native, non-wasm server target
   without dragging in a browser-target dependency chain.

`crates/xberg-rag/Cargo.toml` still carries `edgevec = { workspace = true, optional = true }`
behind the `hnsw` feature as a compile-gate placeholder only (comment: "Compile-gate only in
P1, proves edgevec builds for native + wasm"); the smoke example and spike note were never
produced. **P2b must not start until that spike actually runs** (or the team explicitly
re-scopes P2b onto a different HNSW crate) — the `SearchStore` trait shape is ready, but whether
`edgevec` is a viable dependency at all is still an open, unverified question.

## 6. Verification status

The review-fix pass compiled and exercised the affected surfaces:

- `cargo test -p xberg-rag --features testing`: 33 tests pass.
- `cargo clippy -p xberg-rag --features testing -- -D warnings`: passes.
- `cargo check -p xberg-rag --target wasm32-unknown-unknown`: passes.
- Focused MCP RAG, serialization, and route-gate suites: 10 tests pass with
  `mcp,static-embeddings`.
- Node mirror tests: 14 pass; focused TypeScript compilation passes.
- Web search-gate tests: 7 pass; WASM embedding-session tests: 4 pass.
- GitHub's web/MCP bundle and standalone-wrapper jobs pass on Linux, macOS, and Windows.

The full CLI integration target cannot build in the local environment because `libheif-sys`
requires system `libheif >= 1.21`. The repository-wide `poly` gate also remains red because the
baseline branch contains more than 170 files that the current formatter would rewrite; the same
failure reproduces on `main` and is not introduced by this RAG change.
