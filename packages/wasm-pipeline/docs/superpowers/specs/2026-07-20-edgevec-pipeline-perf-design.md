# EdgeVec Pipeline Performance Redesign (Keep-EdgeVec) — Design

**Status:** Approved (rewritten — direction changed after B-gate spike proved Turso FTS/ANN impossible in browser wasm)

**Depends on / extends:** `docs/superpowers/specs/2026-07-15-document-intelligence-app-design.md`, `docs/superpowers/specs/2026-07-18-mcp-folder-ingest-design.md`

**Investigation basis:** performance trace of `packages/wasm-pipeline/src/*` + `services/mcp-server/src/*` + `crates/xberg/src/core`, cross-checked against installed `onnxruntime-web@1.26.0`, `gliner@0.0.19`, and **`edgevec@0.9.0`** (README + `edgevec.js` export surface + live browser spike). Also read `crates/xberg-wasm/src/lib.rs` and `crates/xberg/src/text/quality_processor.rs` to design extraction tuning that preserves best quality.

## Decision record (why we keep EdgeVec, not Turso)

A browser-wasm capability spike (`docs/superpowers/spike-turso-browser-2026-07-20.md`, commit `5f43742545`) proved that **Turso's FTS and vector ANN index methods are hard-gated out of every browser-wasm engine**: `USING fts` → `unknown module name 'fts'`, `libsql_vector_idx` → `invalid expression in CREATE INDEX`. Source-confirmed in `core/index_method/mod.rs:15` (`fts` is `#[cfg(all(feature = "fts", not(target_family = "wasm")))]`); Tantivy (0.26) cannot compile to wasm. A second investigation confirmed LanceDB is Node-NAPI-only (no browser-wasm package) with the same Tantivy-blocked FTS.

**EdgeVec `0.9.0` is purpose-built for exactly what we need, and runs natively in the browser** (217 KB gzip, SIMD, no server). Its feature set (from README + verified `edgevec.js` exports):

| Capability | EdgeVec 0.9.0 API | Notes |
|---|---|---|
| ANN vector search | `db.search(query, k)` / `db.searchBQ(query, k)` | HNSW + FlatIndex; BQ = 32x memory, 95% recall with rescore |
| **Hybrid search (RRF)** | `db.hybridSearch(dense, sparseIdx, sparseVal, sparseDim, opts)` / `db.searchHybrid(query, opts)` | Dense HNSW + sparse BM25, RRF `k=60` or linear fusion |
| **Sparse / BM25** | `db.insertSparse(indices, values, dim)` / `db.sparseCount()` | CSR inverted-index keyword retrieval |
| Binary quantization | `db.searchBQ(query, k)` / `db.searchBQRescored(query, k, r)` | 32x memory reduction |
| Metadata filtering | `db.searchWithFilter(query, expr, k)` | SQL-like `=, >, <, AND, OR, NOT, ANY` |
| Memory pressure | `db.getMemoryPressure()` / `db.compact()` / `db.canInsert()` | WASM heap monitoring |
| Soft delete | `db.softDelete(id)` / `db.needsCompaction()` | O(1) tombstone |
| Persistence | `db.save(name)` / `EdgeVec.load(name)` | **BROKEN in 0.9.0 — see below** |
| Byte export | `db.save_stream(chunk)` → `next_chunk()` iterator | works; write-only (no matching load) |

### The real root cause (not EdgeVec itself)

`packages/wasm-pipeline/src/rag.ts` already documents (and we re-confirmed live in Chromium) that `db.save()`/`EdgeVec.load()` **throw on every reload**:

```
"corrupted data: Deserialization failed: This is a feature that PostCard will never implement"
```

`save()` succeeds and `save_stream()` exports 6273 bytes for 2 vectors, but there is **no working load path** in 0.9.0 (the byte export is write-only, intended only for shipping to the Node mirror). The prior pipeline worked around this by persisting raw vectors as **JSON in localStorage** and **replaying `insert()` over every vector on every `retrieve()` call** (`rag.ts:112` → `loadIndex`). That is the single biggest query-time killer — not EdgeVec's design.

**Fix strategy:** keep EdgeVec for what it's excellent at (in-memory ANN + hybrid RRF + BQ), and replace the broken `save`/`load` + JSON-localStorage workaround with a **compact binary persistence layer** that rebuilds the index **once per session** (not per query) from an `IndexedDB`-stored `Float32Array` blob, with a memory of assigned ids so metadata stays aligned.

## Problem (refined)

1. **Vector index rebuilt from JSON in localStorage on every query** (`rag.ts:112`). `loadIndex` re-parses a JSON blob of all vectors and replays `insert()` for every vector on every `retrieve`. Bounded by ~5MB synchronous `localStorage` cap; O(N) per query.
2. **No hybrid / keyword search.** `query.ts` does pure dense `db.search` — exact names, matter numbers, clause IDs (which embeddings blur) are never matched via BM25. EdgeVec's native `hybridSearch`/`insertSparse` are unused.
3. **NER runs one chunk at a time, on CPU only** (`ner.ts:103,129`, `ingest.ts:76,90`). GLiNER `inference` called with `texts:[text]` (single), `executionProvider` hard-coded `"wasm"` even with WebGPU. `configureOrtEnv()` re-invoked before every call.
4. **Embedding session single-threaded while chunks fan out** (`embed.ts:61,130,181`). `ort.env.wasm.numThreads = 1` + `Promise.all(chunks.map(embedOne))` blocks main thread with many ORT sessions; `onnxruntime-web` re-imported per chunk.
5. **xberg extraction leaves real perf levers unused — but must NOT sacrifice quality.** After reading `crates/xberg-wasm/src/lib.rs` and `crates/xberg/src/text/quality_processor.rs`: `enable_quality_processing` (default **true**) only adds a `quality_score` metadata field + light text normalization; disabling it *loses* quality for ~1ms/100KB — a net loss, not a win. The real perf levers are: `use_cache` + `cache_namespace`/`cache_ttl_secs` (Rust cache, default on), `acceleration: { provider: "webgpu" }` (hardware-accelerated ML/OCR), `max_concurrent_extractions` (batch parallelism), `token_reduction` (token savings, `preserve_important_words` default true — quality-safe), and an OCR *strategy* (keep OCR on for best quality, tune via `ocr_strategy`/`force_ocr`, don't blanket-disable). The wasm `extract_bytes` path may bypass the Rust cache, so a JS-side `Map<contentHash, result>` cache is still warranted.
6. **Two disconnected stores**: `edgevec` (browser vectors + manual localStorage JSON metadata) and `better-sqlite3` (Node metadata) — no shared query language, no keyword search, no cross-reload persistence of the index.

## Goals

- Keep **EdgeVec** as the in-browser vector + hybrid engine. Do **not** migrate to Turso/LanceDB (proven impossible in browser wasm).
- **Fix persistence**: replace JSON-localStorage + per-query `insert()` replay with a once-per-session binary rebuild from `IndexedDB`-stored `Float32Array` blobs (using `save_stream` bytes or a packed `Float32Array` export we control). Eliminate per-query rebuild.
- **Enable native hybrid RRF**: build a sparse/BM25 index (`insertSparse`) alongside dense vectors and query with `hybridSearch`/`searchHybrid` (RRF k=60). Maximizes recall for legal/PII documents (exact names, matter numbers, clause IDs).
- **Use binary quantization** (`searchBQ`/`searchBQRescored`) for memory headroom on large matters; keep F32 for correctness-critical small matters via a scenario toggle.
- **Keep best xberg quality**: `enable_quality_processing` stays ON; use WebGPU accel, Rust + JS cache, OCR via strategy, quality-safe token reduction — never disable quality for speed.
- Apply embed/NER/extraction tuning so each stage fits a per-stage latency budget.
- One shared `SearchStore` abstraction (interface preserved) so the Node MCP server keeps using `better-sqlite3` for metadata while the browser uses EdgeVec — no big-bang storage rewrite.

## Non-goals

- Migrating browser storage to Turso/LanceDB (proven impossible in browser wasm; Node MCP server may still adopt Turso natively for server-side ANN, but that is out of scope for this client perf work).
- Fixing EdgeVec's upstream `save`/`load` PostCard bug (no fix available in 0.9.0; we bypass it with our own binary store).
- `vector8`/`vector1bit` quantization of embeddings inside EdgeVec (deferred; `searchBQ` already gives 32x memory at the storage layer).
- Streaming/pipelined ingestion (premature for v1).
- Consolidating the redaction vault (`vault.ts`) into the search store (vault stays separate).

## Architecture (Section 1)

Each pipeline stage is an isolated, independently-testable unit behind a single `SearchStore` abstraction. The browser implementation is **EdgeVec-backed**; the Node implementation stays `better-sqlite3` (metadata) + EdgeVec bytes mirror as today.

```
ingestFolder (orchestrator)
  ├─ ExtractStage  ── xberg-wasm  (quality ON: quality_processing=true, WebGPU accel, Rust+JS cache, OCR via strategy)
  ├─ EmbedStage    ── e5 ORT session (multithreaded wasm / WebGPU, cached import)
  ├─ NerStage      ── GLiNER batched, executionProvider from scenario
  ├─ RedactStage   ── buildRedaction + vault (unchanged logic)
  └─ PersistStage  ── SearchStore.ingest(items) ──► EdgeVec (dense + sparse) + IndexedDB blob

queryRag
  ├─ EmbedStage (query)
  └─ SearchStore.query(matter, vec, kw, topK)
        ├─ EdgeVec.hybridSearch(dense, sparseBM25, RRF k=60)   (ANN + keyword fused)
        └─ (optional) searchBQ for memory-constrained matters
```

**New / changed units:**

- `packages/wasm-pipeline/src/search/store.ts` — `SearchStore` interface (`open`, `ingest`, `query`, `forget`, `persist`, `load`), `IndexedChunk`/`RetrievedChunk` mapping. `IndexedChunk` moves here from `rag.ts` (no `vector: Float32Array` change).
- `packages/wasm-pipeline/src/search/edgevec.ts` — EdgeVec-backed `SearchStore` implementation: dense insert + sparse (`insertSparse`) insert, `hybridSearch` query, `searchBQ` toggle.
- `packages/wasm-pipeline/src/search/persist.ts` — **binary IndexedDB store**: packs `Float32Array[]` + assigned ids + dense/sparse split into a single `Uint8Array` blob; rebuilds the EdgeVec index **once per session** on `load()`. No JSON, no per-query replay.
- `packages/wasm-pipeline/src/search/hybrid.ts` — BM25/sparse query builder: tokenizes the keyword query into `sparse_indices`/`sparse_values` (vocabulary = chunk-term inverted index built at ingest), calls EdgeVec `hybridSearch`. RRF handled inside EdgeVec; this module only prepares the sparse leg + merges with metadata.
- `rag.ts` is **rewritten in place** (not deleted) to delegate to `edgevec.ts` + `persist.ts`. `serializeIndex` (the old `save_stream` mirror export) is preserved for `/api/rag/mirror`.

**Boundaries:** `SearchStore` depends only on `edgevec` + `IndexedChunk`/`RetrievedChunk`. Stages don't know about storage. Query doesn't know embedding internals. Each unit unit-testable with a fake `SearchStore`.

## Storage & persistence (Section 2) — the fix

EdgeVec's `save`/`load` is broken (PostCard `WontImplement`). We persist **ourselves** in a way that survives reload and avoids per-query cost.

**Binary layout (single `Uint8Array` in IndexedDB, keyed by `matterId`):**

```
[ magic 4B ][ version u32 ][ dim u32 ][ nVectors u32 ]
[ dense: nVectors × dim × f32 ]            // packed Float32
[ nSparse u32 ]
[ per sparse: id u32 ][ nTerms u32 ][ terms: nTerms × (idx u32, weight f32) ] ]
[ idMap: nVectors × { edgevecId u32, docIdLen u32, docId bytes, chunkIndex u32, page i32, citationLen u32, citation bytes } ]
```

- **Ingest:** build dense vectors + sparse (BM25) term lists; `insert()` each dense (record assigned id) and `insertSparse()` each sparse with the **same id** (EdgeVec aligns sparse/dense by id in `hybridSearch`); write the packed blob to IndexedDB once at folder-ingest completion (not per chunk).
- **Load (per session, once):** read blob from IndexedDB; if present, `insert()`/`insertSparse()` in id order (reproduces EdgeVec's deterministic id assignment — same approach as today, but **once per session, not per query**, and from a packed `Float32Array` instead of JSON.parse of a stringified array-of-arrays). If absent, fall back to rebuild from `IndexedChunk[]` (fresh ingest).
- **Memory:** the blob is `nVectors * dim * 4` bytes (e.g. 50 chunks × 768 × 4 ≈ 150 KB) — far smaller than the 5 MB localStorage cap and trivially under IndexedDB limits. No JSON serialization of arrays-of-arrays.
- **Per-query path:** `query()` calls `hybridSearch` on the already-resident index. **Zero rebuild, zero localStorage parse.** This removes the dominant latency in the old design.
- **Forget (GDPR):** delete the IndexedDB blob for `matterId` + `softDelete`/clear the in-memory index entries (rebuild on next load omits them).

**Why not use `save_stream` bytes directly?** `save_stream()` exports a valid byte stream but there is no `load-from-bytes` API in 0.9.0 (confirmed: `save`/`load` only accept an IndexedDB `name`, and `load` is broken). A self-describing packed blob we control is the robust path and also feeds `/api/rag/mirror` (serialize the same blob to ship to Node).

## Ingestion stages (Section 3)

**ExtractStage (xberg-wasm) — best quality, real perf levers (verified against `crates/xberg-wasm/src/lib.rs` + `quality_processor.rs`):**

- **Keep `enable_quality_processing = true`** (default). It only adds `quality_score` + light text normalization; disabling it loses quality for ~1ms/100KB. Never turn it off.
- **Enable the Rust cache + add a JS-side cache:** `cfg.set_use_cache(true)` (default) and set `cache_namespace`/`cache_ttl_secs` so repeated extractions of the same bytes hit cache. Add a JS-side `Map<contentHash, result>` cache because the wasm `extract_bytes` path may bypass the Rust cache.
- **WebGPU acceleration:** set `cfg.set_acceleration({ provider: "webgpu", deviceId: 0 })` when `scenario` reports WebGPU — hardware-accelerated ML/OCR with no quality loss. Fall back to CPU only when WebGPU is unavailable.
- **Parallelism:** set `max_concurrent_extractions` (batch parallelism) and prefer `extract_batch` for multi-doc ingestion.
- **Token reduction (quality-safe):** `token_reduction = { mode: <aggression>, preserve_important_words: true }` — reduces token cost without dropping key terms.
- **OCR ON for best quality:** keep OCR enabled; tune via `ocr_strategy` / `force_ocr` / `force_ocr_pages` rather than blanket-disable. Only `disable_ocr` when the input is known text-only and the user opts out.
- **Layout-aware markdown:** `use_layout_for_markdown = true` for richer structured markdown output.
- Read `result.content` / `result.chunks` once; never call `.bytes()` after `fromBytes`.

**EmbedStage (e5 ORT):**

- Hoist `import("onnxruntime-web")` + session to module scope (cache promise).
- Multithreaded wasm: `ort.env.wasm.numThreads = scenario.numThreads` + `multiThread: true`, served via `/vendor/onnxruntime-web/` (COOP/COEP already sent in `index.ts:64`). Re-evaluate the current `numThreads = 1` + "never construct a Worker" comment against the new batched embedding — batching makes threading worthwhile now.
- Keep `graphOptimizationLevel: "all"`.

**NerStage (GLiNER):**

- **Batch**: collect all chunk texts → one `model.inference({ texts: chunks, entities, flatNer, threshold })`; map `result[i]` back to chunk `i`.
- `executionProvider`: stay `"wasm"` unless a new spike confirms GLiNER runs inference successfully on WebGPU for this model (GLiNER has **no EP fallback chain**, so a failed WebGPU attempt has nothing to fall back to — preserve the stability guarantee). If the spike shows WebGPU works, flip the default and document evidence.
- `configureOrtEnv()` once at model init, not per call.
- Skip chunks <20 chars; align indices after.
- `deferPii` (idle callback) still defers one batched call, not N serial ones.

**PersistStage:** `SearchStore.ingest(items)` builds dense + sparse indexes, then writes the packed IndexedDB blob **once** at folder-ingest completion (before `pushMirror`).

## Query & hybrid search (Section 4)

`queryRag` (`query.ts`): embed query → `SearchStore.query(matter, vec, keyword, topK)` → `RetrievedChunk[]`. No EdgeVec-raw, no localStorage rebuild.

```ts
// inside EdgeVecSearchStore.query — uses EdgeVec native hybrid RRF
const dense = vec;                                  // Float32Array(768)
const { indices, values, dim } = this.buildSparse(keyword); // BM25 term list
const raw = this.db.hybridSearch(
  dense, indices, values, dim,
  JSON.stringify({ dense_k: topK * 2, sparse_k: topK * 2, fusion: "rrf", rrf_k: 60 }),
);
// map hits (id, score, dense_rank, sparse_rank) → RetrievedChunk via idMap
```

- `buildSparse(keyword)`: tokenize + look up term indices in the per-matter vocabulary built at ingest; weights = BM25/idf. This produces the `sparse_indices`/`sparse_values`/`sparse_dim` EdgeVec expects.
- EdgeVec returns fused RRF results; we attach metadata from the idMap.
- **Memory-constrained matters** (`scenario.lowRam`): use `db.searchBQRescored(dense, topK, 5)` (32x memory, ~95% recall) instead of full `hybridSearch`; sparse BM25 still available via `searchHybrid` when needed.
- `matterId` isolation: the idMap + blob are per-`matterId`; `forget` deletes the blob.

**Capability probe:** at `SearchStore.open`, probe EdgeVec features:

- if `hybridSearch`/`insertSparse` unavailable → fall back to dense-only `db.search`.
- if `searchBQ` unavailable → F32 dense.
  (EdgeVec 0.9.0 has all of these; probe is insurance for future/older versions.)

## Verification & latency budgets (Section 5)

**Hard precondition (replaces the now-moot Turso B-gate):** a spike confirms in the **browser** that `edgevec@0.9.0` `hybridSearch` + `insertSparse` + `searchBQ` execute and that our binary `persist.ts` **rebuilds once per session and serves queries with zero per-query `insert()` replay** (measured: query latency flat across N queries, no localStorage parse). Turso is explicitly **not** a precondition (proven impossible in wasm).

**Migration:** incremental — `rag.ts` is rewritten to delegate; no big-bang deletion. EdgeVec + localStorage-JSON code paths are replaced inside `rag.ts`/`persist.ts`. `better-sqlite3` stays in the Node MCP server.

**Verification (harness + soak):**

- `packages/wasm-pipeline/src/search/bench.ts` times each stage on fixed fixtures.
- Soak test: ingest N folders (~50 chunks each), query M times → proves per-query rebuild is gone (flat query p95, no degradation vs first query).
- Light matrix: low-end Android, mid laptop, desktop GPU — validates scenario selection (WebGPU vs wasm, BQ vs F32).

**Per-stage latency budgets (v1 targets, mid laptop / desktop GPU; tighten after harness):**

| Stage | Budget (p95) | Notes |
|---|---|---|
| Extract (20pg doc) | <800ms | quality ON (quality_processing=true), WebGPU accel, Rust+JS cache, OCR via strategy |
| Embed (50 chunks) | <400ms | threaded wasm / webgpu |
| NER (50 chunks) | <600ms (spike-measured) | batched, GPU if avail |
| Persist (50 chunks) | <200ms + 1 blob write | dense + sparse + IndexedDB pack |
| Query (hybrid, <10k chunks) | <100ms | native RRF, **no rebuild** |
| Cold reload (reopen matter) | <150ms | one session rebuild from blob, not per query |

Budgets are acceptance criteria — harness fails CI on regression.

## Risks, testing & open items (Section 6)

**Risks:**

- **EdgeVec `save`/`load` broken** (confirmed) → mitigated by our own binary `persist.ts` (no reliance on upstream load). Highest-confidence path since we control the format.
- **`hybridSearch` id alignment** between dense `insert()` and `insertSparse()` — must insert in the same id order; verified in the spike.
- **Bundle size** — EdgeVec is 217 KB gzip (vs Turso's 10.5 MB / LanceDB Node-only); no jsDelivr concern.
- **`better-sqlite3` remains in Node MCP server** — unchanged; only the browser store changes. No mirror contract break (we keep `serializeIndex` → `save_stream` for Node).
- **WebGPU for GLiNER** — gated behind a spike; defaults to wasm for stability.

**Testing:**

- Unit: fake `SearchStore`; `persist.ts` round-trip (pack → load → query equal to in-memory); `hybrid.ts` sparse builder; `ner.ts` batch mapping; `embed.ts` session caching.
- Integration: wasm-pipeline end-to-end on pandoc ground-truth fixtures (`.ai-rulez/ground-truth-generation.md`).
- Soak: ingest N folders, query M times, assert flat query latency (proves no per-query rebuild).
- Compat: `/api/rag/mirror` still receives `save_stream` bytes (unchanged contract).

**Open items (resolve during implementation):**

- Exact BM25/idf weighting for the sparse leg (start with simple tf-idf over chunk vocabulary, tune against legal fixtures).
- Whether to default memory-constrained matters to `searchBQ` (recommend: yes when `scenario.lowRam`).
- Whether to encrypt the IndexedDB blob at rest (privacy win, small perf cost) — out of scope v1.
