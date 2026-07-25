# Shared Embedding Backend — MCP Native Host + WASM Web, Candle-Based — Design

**Date:** 2026-07-22
**Status:** Draft (pending user review of this document)
**Tracks / proposes a resolution for:** GitHub issue #30 ("RAG: browser (e5-base, 768-dim)
and native host (model2vec, 256-dim) embeddings are incompatible")
**Depends on / extends:**

- `docs/superpowers/specs/2026-07-21-isomorphic-rag-core-design.md` (R5 phase list, R6 status,
  and its own "Non-goals" line explicitly excluding "embedding-model/dimension changes" — this
  spec is that excluded decision, split out on purpose rather than folded into P3's wire-format
  migration)
- `docs/superpowers/notes/2026-07-21-p2-native-rag-status.md` §3 ("Dimension in use" — the
  as-built state this spec changes)

## Problem

Confirmed directly in code, not assumed:

- Native host (`crates/xberg/src/rag_embed.rs:47-52`, `XbergEmbedder::from_preset`) defaults to
  the `"lightweight"` preset — model2vec, `EmbeddingBackend::Static`, pure Rust, no ONNX
  Runtime, **256 dimensions** (`crates/xberg/src/embeddings/mod.rs`, `EMBEDDING_PRESETS`,
  `potion-base-8m/model.safetensors`, ~7.5M params). Chosen specifically so the server never
  hard-requires bundled ORT (spec R3 of the isomorphic-rag-core design).
- Browser host (`packages/wasm-pipeline/src/constants.ts:32`, `export const EMBED_DIM = 768;`)
  runs a fully separate TypeScript pipeline (`embed.ts`, `rag.ts`) on `onnxruntime-web` +
  e5-base, **768 dimensions**. It never touches `crates/xberg-wasm`'s own embedding code.
- `xberg-rag`'s `FlatStore` hard-rejects any cross-dimension read or query —
  `crates/xberg-rag/src/flat.rs:20` (ingest) and `:29` (query), both `RagError::DimMismatch`.
  Clean hard failure, not silent wrong-ranking, but a matter indexed by one host is unusable by
  the other.
- The original v1 snapshot stored only a scalar `dim` per matter
  (`crates/xberg-rag/src/engine.rs`, `FlatStore::new(self.embedder.dim())`). Snapshot v2 adds
  the complete `EmbeddingIdentity` compatibility guard defined below, but no shared cross-host
  model or automatic re-embed path exists yet.

Two more facts, found investigating this spec, change what "fix" means here:

- **ORT-in-browser is a proven, recurring source of breakage in this exact repo.** The last five
  commits on `main` at the time of this spec include three separate `onnxruntime-web` fixes
  (self-URL rewriting under webpack, `TypeError` on embed init, GLiNER model-serving eviction).
  Any fix that keeps ORT in the browser inherits that fragility class.
- **Candle is already a trusted, production dependency in this repo, but not yet WASM-capable.**
  `crates/xberg-candle-ocr` (`candle-core`/`candle-nn`/`candle-transformers` 0.11) does pure-Rust
  transformer inference today for VLM OCR (TrOCR, PaddleOCR-VL, GLM-OCR, DeepSeek-OCR — see
  `crates/xberg/Cargo.toml:155-185`). Its own Cargo.toml comments read: "Candle-based VLM OCR
  backends - pure-Rust transformer inference, not on WASM yet" (lines 844, 878), and "candle-core
  unconditionally links platform-specific deps (cudarc on Linux, metal-kernels on macOS)" (line
  845) — almost certainly the actual blocker, not an architectural one.

## Goals

- One embedder implementation, in Rust, compiled identically for the native MCP host and the
  WASM browser host — not two pipelines that happen to agree on a number.
- No ONNX Runtime dependency on **either** host. Server-side ORT was already rejected by R3 of
  the isomorphic-rag-core spec; browser-side ORT is the proven fragility source above.
- Retrieval quality appropriate for legal review: exact citation / defined-term / party-name
  matching (lexical) as well as semantic similarity across long, dense, multilingual documents
  (dense). "Optimized for machine and WASM" is a hard constraint, not a tiebreaker — this rules
  out simply bundling the largest available transformer.
- A migration path that does not require re-parsing already-extracted documents: chunk text is
  already persisted in the snapshot; re-embedding is re-running a model over existing text.

## Non-goals (this spec)

- Sparse (SPLADE) and late-interaction (ColBERT) retrieval modes end-to-end — `crates/xberg`
  already carries `sparse-embeddings`/`late-interaction` feature flags (ORT-backed today); this
  spec only notes where a future dense+sparse+multi-vector unification (e.g. BGE-M3's three
  output heads) would slot in, it does not implement it.
- HNSW / P2b backend swap (`docs/superpowers/notes/2026-07-21-p2-native-rag-status.md` §5) —
  orthogonal, and gated on its own unresolved `edgevec` spike.
- Cross-encoder reranking (`reranker`/`reranker-presets` features) — noted as a natural follow-on
  once the shared dense backend lands, not designed here.

## Decisions

**D1 — Backend: candle, not ONNX Runtime, on both hosts.**
`candle-transformers` 0.11 ships `bert`, `modernbert`, and `xlm_roberta` as first-class modules
(confirmed against the crate's own module index, not inferred). This covers the architectures
behind the repo's existing best-quality ONNX presets (`gte-modernbert-base`, `arctic-embed-m-v2.0`
are BERT-family) and behind the recommended model in D2 (BGE-M3, XLM-RoBERTa-large backbone).
HuggingFace's own reference deployment,
[Candle-BERT-Semantic-Similarity-Wasm](https://huggingface.co/spaces/radames/Candle-BERT-Semantic-Similarity-Wasm),
demonstrates real BERT embeddings running client-side via WASM — this is shipped, not
speculative.

**D2 — Model: BGE-M3 (dense head only for this spec's scope), quantized int8, identical weights
on both hosts.**
Rationale specific to a legal, multilingual (French-language evidence in this session) context:

- Fine-tuned BGE-M3 outperforms off-the-shelf alternatives on COLIEE 2025 legal-retrieval
  benchmarks.
- Explicitly documented as deployed for indexing full-length commercial contracts in English,
  French, German, and Spanish.
- 8,192-token context — the `lightweight` preset's chunking is tuned for 512 tokens; legal
  documents (contracts, briefs) routinely need more.
- Backbone is XLM-RoBERTa-large, which `candle-transformers::models::xlm_roberta` supports
  natively — no missing-architecture blocker.

Caveat carried forward honestly: BGE-M3's dense/sparse/multi-vector outputs are three linear
heads on top of the XLM-RoBERTa encoder. `candle-transformers::models::xlm_roberta` provides the
encoder; the heads are not implemented in the crate and must be written (a small amount of
`candle_nn::Linear` code, not a research problem). This spec's scope is **dense head only** — see
Non-goals.

**D3 — Strict identity, not per-host tuning.**
The MCP native host must not run a "fuller" or differently-quantized variant than the browser.
Both hosts serve the exact same immutable `EmbeddingIdentity`: `artifact_digest` (content
digest of the exact weights), `tokenizer_revision` (digest of the tokenizer/config artifacts
plus the effective maximum sequence length), `pooling` (encoded as
`<strategy>;normalize=<bool>`), `instruction` (the exact prefixes encoded as
`documents=<prefix>;queries=<prefix>`), `quantization`, `dimension`, and `pipeline_version`
(the fixed preprocessing-semantics version). Compatibility requires exact equality across
every field; model names and dimensions alone are insufficient. This is the direct fix for the
problem statement: choosing "the best model per host" independently is what produced the
current incompatibility, and repeating that pattern with better models still reproduces the
bug.

**D4 — BM25 lexical hybrid, independent of the dense-model decision.**
No lexical scoring exists today — `crates/xberg` has YAKE/RAKE keyword extraction
(`keywords-yake`/`keywords-rake`) but no BM25. Legal text's exact-match needs (statute
citations, case numbers, defined terms, party names) are precisely where dense-only retrieval —
even BGE-M3 — underperforms lexical scoring. Pure Rust, no model weights, trivially WASM-safe,
composes with D1-D3 via score fusion (reciprocal rank fusion) over the same chunk set
`xberg-rag` already stores. Independent of, and should not block on, the dense-model migration.

## Approach

### Section 1 — Close the WASM gap in candle first

`xberg-candle-ocr`'s `wasm32` blocker (unconditional `cudarc`/`metal-kernels` linkage) must be
resolved before any embedding work lands. This repo already has the pattern for it: `candle-cuda`,
`candle-metal`, `candle-mkl`, `candle-accelerate` are separate, optional feature pass-throughs
(`crates/xberg/Cargo.toml:179-184`). The fix is cfg-gating those dependencies out of the
`wasm32-unknown-unknown` build the same way, then verifying `candle-core`'s CPU backend actually
compiles clean for that target. This is shared infrastructure — it benefits VLM OCR-on-WASM too,
not just embeddings.

### Section 2 — New embedder crate/module

A new `xberg-candle-embed` (or a module inside `xberg-candle-ocr`, TBD at implementation time)
implementing `xberg_rag::Embedder` (the same trait `XbergEmbedder` in `rag_embed.rs` implements
today), backed by `candle_transformers::models::xlm_roberta` + a hand-written dense projection
head, loading BGE-M3's published dense-head weights, quantized to int8 via candle's quantization
support. Same crate compiles for native and `wasm32` — that identity is the entire point of D1.

### Section 3 — Wiring

- Native: `XbergEmbedder::from_preset` gains (or is replaced by, pending naming) a path that
  constructs the candle-backed embedder instead of `model2vec_rs`. `RagEngine` is already generic
  over `Embedder` (`crates/xberg-rag/src/engine.rs`) — no engine-level change needed.
- Browser: `xberg-wasm` exposes the same embedder via wasm-bindgen, replacing
  `packages/wasm-pipeline/src/embed.ts`'s `onnxruntime-web` call. `wasm-pipeline`'s `rag.ts`
  calls into it instead of the TS/ORT path.
- Migration safety net: persist the complete `EmbeddingIdentity` in every `FlatStore` snapshot,
  not just the raw `dim` it has today. Loading, appending to, or querying with a foreign identity
  must surface an actionable re-embedding error; it must never compare or combine the vectors.
  Re-embedding is cheap because chunk text is already persisted; it is not a re-extraction.

### Section 4 — BM25 (D4, independent track)

Add a pure-Rust BM25 scorer over the same persisted chunk text, fused with the dense candle score
via reciprocal rank fusion. No dependency on Sections 1-3 landing first; can ship earlier if
useful as an interim quality improvement.

## Open risks / mitigations (gates)

- **R1 — WASM build gap is unverified, not just unimplemented.** Section 1 assumes cfg-gating
  `cudarc`/`metal-kernels` is sufficient to get `candle-core` compiling for `wasm32`; this has not
  been spiked. **Gate:** a compile-only spike (mirroring the existing `edgevec` spike pattern in
  the isomorphic-rag-core spec) before committing engineering time to Sections 2-3.
- **R2 — BGE-M3 dense-head weights are not a candle-native artifact.** They ship as
  safetensors/PyTorch for the HF `transformers`/`sentence-transformers` ecosystem; loading them
  into a hand-written candle `xlm_roberta` + linear-head graph needs a conversion/verification
  step (numerical parity check against the reference PyTorch output on a fixed input set) before
  it can be trusted for legal use.
- **R3 — WASM payload budget.** BGE-M3 (XLM-RoBERTa-large backbone) is far larger than
  `potion-base-8m`'s 7.5M params — likely several hundred MB even quantized. No budget has been
  set. **Gate:** define an acceptable browser fetch/parse budget (informed by `xberg-wasm/lib.rs`
  already sitting at ~983 KB per the isomorphic-rag-core spec's R2) before committing to BGE-M3
  over a smaller candle-compatible alternative (e.g. `arctic-embed-m-v2.0`'s `bert`/`modernbert`
  architecture, already in `EMBEDDING_PRESETS`, likely a smaller port with less quality upside).
- **R4 — In-browser latency, CPU-only.** Real transformer inference, even quantized, is slower
  per chunk than model2vec's static lookup. WebGPU is not universally available. **Gate:** measure
  indexing-time latency for a representative long legal document before shipping, not after.
- **R5 — D3's strict-identity rule blocks independent per-host upgrades.** Any future model swap
  must ship to both hosts atomically, or the original bug recurs. This is a process constraint on
  future work, not a one-time gate — call it out explicitly in whatever tracks D1-D3's
  implementation.

## Out of scope (explicit)

- Sparse/late-interaction heads of BGE-M3 (Non-goals).
- Reranking (Non-goals).
- HNSW/P2b backend swap (Non-goals, separate open spike).
- Any change to `FlatStore`'s cosine-similarity search algorithm itself — only what feeds it.
