# End-to-End Pipeline Performance Redesign (Turso Storage Layer) — Design

**Status:** Approved (pending user review of this document)
**Depends on / extends:** `docs/superpowers/specs/2026-07-15-document-intelligence-app-design.md`, `docs/superpowers/specs/2026-07-18-mcp-folder-ingest-design.md`
**Investigation basis:** performance trace of `packages/wasm-pipeline/src/*` + `services/mcp-server/src/*` + `crates/xberg/src/core`, cross-checked against installed `onnxruntime-web@1.26.0`, `gliner@0.0.19`, `edgevec@0.9.0`, and current Turso / sqlite-vec / Transformers.js docs.

## Problem

The ingestion + query pipeline has several measured performance bottlenecks that make the
on-device document-intelligence app slower than necessary and, in one case, structurally broken:

1. **Vector index rebuilt from localStorage on every query** (`packages/wasm-pipeline/src/rag.ts:112`).
   `loadIndex` re-parses a JSON blob of all vectors and replays `insert()` for every vector on
   every `retrieve` call. This is the single biggest query-time killer and is bounded by the
   ~5MB synchronous `localStorage` cap.
2. **NER runs one chunk at a time, on CPU only** (`ner.ts:103,129`, `ingest.ts:76,90`). GLiNER's
   `inference` is called with `texts: [text]` (single element) and `executionProvider` is
   hard-coded `"wasm"` even when the device has WebGPU. `configureOrtEnv()` is re-invoked before
   every call.
3. **Embedding session is single-threaded while chunks fan out concurrently** (`embed.ts:61,130,181`).
   `ort.env.wasm.numThreads = 1` combined with `Promise.all(chunks.map(embedOne))` blocks the main
   thread with many ORT sessions and re-imports `onnxruntime-web` per chunk.
4. **xberg extraction pays default-on costs** (`crates/xberg-wasm/src/lib.rs:540` + `ingest.ts:45,50`):
   `enable_quality_processing` defaults `true` (NFC + confidence pass every call); the markdown
   chunker triggers a redundant full `render_markdown` even for Plain output; OCR is always enabled
   in `ingestFolder`; the wasm `extract_bytes` path bypasses the Rust cache; `content`/`chunks`
   getters clone on every access.
5. **Two disconnected stores**: `edgevec` (browser vectors + manual localStorage JSON metadata) and
   `better-sqlite3` (Node metadata) — no shared query language, no keyword search, no encryption of
   the index, no native persistence across reloads.

## Goals

- Redesign the full pipeline (extract → embed → NER → redact → persist → query) as isolated,
  independently-testable stages behind a single `SearchStore` abstraction.
- Replace both stores with **Turso** (`@turbodatabase/database`): native vector search
  (`F32_BLOB` + `libsql_vector_idx` + `vector_top_k`) plus **Tantivy-powered FTS**
  (`USING fts` + `fts_score` + `fts_highlight`) in one embedded, offline, encrypted, wasm-compatible
  engine.
- **Mandatory hybrid search**: every query runs vector + FTS in parallel and fuses with Reciprocal
  Rank Fusion (RRF, k=60). This maximizes recall for legal/PII documents (exact names, matter
  numbers, clause IDs that embeddings blur).
- One shared SQL schema used by both the browser (wasm/OPFS) and the Node MCP server.
- Apply the extraction/embed/NER tuning findings so each stage fits a per-stage latency budget.
- Big-bang cutover, executed **only after** the browser-wasm Turso spike + soak test pass. The
  old `rag.ts` / `store.ts` / EdgeVec / better-sqlite3 code is deleted at cutover step 5; the
  B-gate spike and soak (Section 5) run *while the old code is still present*, so the documented
  escape hatch ("Node-big-bang + browser-EdgeVec fallback") applies if the gate fails **before**
  deletion. Once deleted, rollback is a `git revert` of the cutover commit — not a runtime flag.

## Non-goals

- `vector8` / `vector1bit` quantization of embeddings (deferred — avoid silent recall regression;
  `F32_BLOB(768)` for v1, toggle later with ground-truth A/B).
- Consolidating the redaction vault (`vault.ts`) into the encrypted Turso DB (optional v1; vault.ts
  stays separate until proven safe).
- Streaming/pipelined ingestion (Approach 3 from brainstorming — premature for v1).
- Replacing the Rust extraction core's `spawn_blocking` gap (EX-6) — separate core PR, not in scope.

## Architecture (Section 1)

Each pipeline stage is an isolated unit with a typed interface; a new `SearchStore` abstraction
replaces both `rag.ts` (EdgeVec + localStorage) and `store.ts` (better-sqlite3). One shared schema
(`schema.sql`) is used by browser and Node.

```
 ingestFolder (orchestrator)
   ├─ ExtractStage   ── xberg-wasm  (quality OFF, text fast-path, OCR gated)
   ├─ EmbedStage     ── e5 ORT session (multithreaded wasm / WebGPU, cached import)
   ├─ NerStage       ── GLiNER batched, executionProvider from scenario
   ├─ RedactStage    ── buildRedaction + vault (unchanged logic)
   └─ PersistStage   ── SearchStore.ingest(items)   ──► Turso DB

 queryRag
   ├─ EmbedStage (query)
   └─ SearchStore.query(matter, vec, kw, topK)
         ├─ vector_top_k(...)        (ANN)
         ├─ fts_score(...)           (Tantivy)
         └─ RRF fuse → RetrievedChunk[]
```

**New units:**
- `packages/wasm-pipeline/src/search/store.ts` — `SearchStore` interface (`ingest`, `query`, `forget`, `load`, `open`).
- `packages/wasm-pipeline/src/search/turso.ts` — Turso implementation (browser wasm/OPFS + Node), shared `schema.sql`.
- `packages/wasm-pipeline/src/search/schema.ts` — DDL (chunks table + vector index + FTS index), single source for both targets.
- `packages/wasm-pipeline/src/search/hybrid.ts` — RRF fusion (vector + fts result merge).
- `rag.ts` deleted; `store.ts` (Node metadata) merged into the same Turso DB behind a preserved `MetadataStore` API.

**Boundaries:** `SearchStore` depends only on `@turbodatabase/database` + `IndexedChunk`/`RetrievedChunk` types. Stages don't know about storage. Query doesn't know embedding internals. Each unit unit-testable with a fake `SearchStore`.

## Storage schema & Turso wiring (Section 2)

Single schema for browser (wasm/OPFS) and Node. Replaces EdgeVec+localStorage and better-sqlite3 metadata.

```sql
CREATE TABLE chunks (
  id         INTEGER PRIMARY KEY,
  matter_id  TEXT NOT NULL,
  doc_id     TEXT,
  page       INT,
  citation   TEXT,
  text       TEXT,
  embedding  F32_BLOB(768)          -- e5-base; vector8 toggle is a later follow-up
);

CREATE INDEX chunks_vec ON chunks (libsql_vector_idx(embedding, 'metric=cosine'))
  WHERE matter_id IS NOT NULL;

CREATE INDEX chunks_fts ON chunks USING fts (text) WITH (weights='text=1.0');

-- Existing metadata tables (matters, folders, consent, ingests, redactions, audit_log)
-- moved into the SAME Turso DB, schema unchanged from store.ts.
```

**Vector binding:** the query vector is an `e5` `Float32Array`. `@turbodatabase/database` does not
auto-convert a `Float32Array` param into an `F32_BLOB` — the binding must pass the raw little-endian
bytes (e.g. `Buffer.from(float32array.buffer)`) and wrap with `vector32(?)` in SQL, OR serialize to
the `[0.1,0.2,...]` literal. The `turso.ts` implementation MUST use the explicit BLOB form
(`vector_top_k('chunks_vec', vector32(?), ?)` with a BLOB param), not rely on implicit conversion.
This is verified in the spike.

**Wiring:**
- Node: `@turbodatabase/database` opening `dataDir/app.db`. Optional native `encryption: { cipher: "aegis256", hexkey }`.
- Browser: `@turbodatabase/database` wasm build against OPFS.
- `SearchStore.open(matterId)` returns a connection scoped so all queries auto-filter `matter_id` (defense for GDPR `forget`).
- **`OPTIMIZE INDEX chunks_fts` cadence:** run **once per folder ingest completion** (after all chunks for a folder are inserted and committed), NOT per batch. Re-running Tantivy optimize after every small batch is expensive and can block concurrent queries. For the `ingestFolder` flow this means one `OPTIMIZE` at the end of `PersistStage`. A background/idle re-optimize may be added later for steady-state writes.

**Query API (hybrid built in):**
```ts
store.query(matterId, { vector: Float32Array, keyword: string, topK: 8 }): Promise<RetrievedChunk[]>
```
Runs vector + FTS in parallel, fuses with RRF (k=60), returns merged top-K with text/page/citation.

**Mirror contract change:** `/api/rag/mirror` (index.ts:249) currently receives EdgeVec `save_stream` bytes. New: the browser serializes the Turso DB (per-matter backup) and ships that; Node `MirrorStore` reopens it. Payload versioned as `{ format: "turso", schemaVersion: 1, db: Uint8Array }`. `MirrorStore.open` MUST reject payloads whose `schemaVersion` is incompatible (a newer browser DB must not silently break Node) — a version guard is required, not optional.

## Ingestion stages (Section 3)

**ExtractStage (xberg-wasm):**
- `cfg.set_enable_quality_processing(false)` in `defaultExtractionConfig()` (drops NFC + confidence pass).
- `chunkerType` configurable: `markdown` for heading-aware RAG, `text` fast-path on constrained devices via `scenario`.
- Gate OCR: `withTesseractOcr` only when input lacks a text layer (detect empty `doc.content`, retry with OCR) instead of always-on.
- Read `result.content` / `result.chunks` once; never call `.bytes()` after `fromBytes`; prefer `extract_batch` for multi-doc.
- JS-side `Map<contentHash, result>` cache since wasm `extract_bytes` bypasses the Rust cache.

**EmbedStage (e5 ORT):**
- Hoist `import("onnxruntime-web")` + session to module scope (cache promise).
- Multithreaded wasm: `ort.env.wasm.numThreads = scenario.numThreads` + `multiThread: true`, served via existing `/vendor/onnxruntime-web/` (requires COOP/COEP, already sent in index.ts:64).
- Keep `graphOptimizationLevel: "all"`.
- `embedChunks` stays `Promise.all` fan-out — now genuinely parallel with threaded wasm.

**NerStage (GLiNER):**
- **Batch**: collect all chunk texts → one `model.inference({ texts: chunks, entities, flatNer, threshold })`; map `result[i]` back to chunk `i`.
- `executionProvider: scenario.executionProviders[0]` (honor WebGPU; wasm fallback in chain) — currently hard-coded `"wasm"`.
- `configureOrtEnv()` once at model init, not per call.
- Skip chunks <20 chars.
- `deferPii` (idle callback) still applies on constrained devices, but now defers one batched call, not N serial ones.

**PersistStage:** `SearchStore.ingest(items)` (batched insert, single commit) then `OPTIMIZE INDEX chunks_fts` once at folder-ingest completion. Awaits before `pushMirror`.

## Query & hybrid search (Section 4)

`queryRag` (query.ts): embed query → `SearchStore.query` (hybrid) → `RetrievedChunk[]`. No EdgeVec, no localStorage rebuild.

```ts
// vector leg
const vRows = await db.select(
  `SELECT c.id, c.text, c.doc_id, c.page, c.citation
   FROM vector_top_k('chunks_vec', vector32(?), ?) vt
   JOIN chunks c ON c.id = vt.id
   WHERE c.matter_id = ?`, [vectorBlob, topK*2, matterId]);

// fts leg — matter_id lives on the base table, so JOIN and filter there
const fRows = await db.select(
  `SELECT c.id, c.text, c.doc_id, c.page, c.citation,
          fts_score(c.text, ?) AS score
   FROM chunks_fts f JOIN chunks c ON c.id = f.id
   WHERE fts_match(c.text, ?) AND c.matter_id = ?
   ORDER BY score DESC LIMIT ?`, [kw, kw, matterId, topK*2]);

// RRF fuse, k=60 → RetrievedChunk[]
```

- Both legs run in parallel (`Promise.all`); over-fetch `topK*2`, fuse, trim to `topK`.
- `fts_highlight(text, '<b>','</b>', kw)` available for web UI snippets.
- `matter_id` filter on both legs = tenant isolation + GDPR scope.

**Capability probe (B-gate insurance):** at `SearchStore.open`, probe Turso wasm features:
- if `libsql_vector_idx`/`vector_top_k` unavailable → fall back to `vector_distance_cos` linear scan.
- if `USING fts` unavailable → vector-only, no FTS leg (degrades gracefully, never crashes).

## Migration gate, verification & latency budgets (Section 5)

**Hard precondition (B-gate):** before deleting EdgeVec/localStorage/better-sqlite3, a spike must
confirm in the **browser wasm** build: `libsql_vector_idx` + `vector_top_k` + `USING fts` all execute.
Until green, old code stays (no big-bang). The runtime capability probe is safety net for partial builds.

**Migration steps (big-bang, after gate green):**
1. Add `@turbodatabase/database` dep; write `search/schema.sql` + `search/turso.ts` + `search/store.ts` + `search/hybrid.ts`.
2. Repoint `ingest.ts` PersistStage → `SearchStore.ingest`; `query.ts` → `SearchStore.query`.
3. Merge `store.ts` metadata tables into the Turso DB; `MetadataStore` becomes a thin wrapper (API preserved for `index.ts` routes).
4. Change `/api/rag/mirror` contract: browser ships serialized Turso DB, Node `MirrorStore` reopens it (versioned payload).
5. Delete `rag.ts`, EdgeVec dep, localStorage persistence, better-sqlite3.

**Verification (harness + soak + light device matrix):**
- Extend `tools/benchmark-harness` (Rust/criterion) + add `packages/wasm-pipeline/src/search/bench.ts` timing each stage on fixed fixtures.
- Soak test: ingest N folders (~50 chunks each), query M times → reproduces old rebuild/clobber failures, proves gone.
- Light matrix: low-end Android, mid laptop, desktop GPU — validates scenario selection (WebGPU vs wasm).

**Per-stage latency budgets (v1 targets, mid laptop / desktop GPU; tighten after harness):**
| Stage | Budget (p95) | Notes |
|---|---|---|
| Extract (20pg doc) | <800ms | quality OFF, OCR gated |
| Embed (50 chunks) | <400ms | threaded wasm / webgpu |
| NER (50 chunks) | <600ms (spike-measured) | batched, GPU if avail; budget confirmed by B-gate spike, not asserted |
| Persist (50 chunks) | <200ms | batched insert + 1 OPTIMIZE |
| Query (hybrid, <10k chunks) | <100ms | ANN + FTS parallel + RRF |
| Cold reload (reopen matter) | <50ms | open DB, no rebuild |

Budgets are acceptance criteria — harness fails CI on regression.

## Risks, testing & open items (Section 6)

**Risks:**
- **Wasm Turso build completeness** (highest) — vector index + Tantivy FTS in-browser unproven. Mitigated by B-gate spike + runtime probe. *Escape hatch: if spike fails, revert to Node-big-bang + browser-EdgeVec fallback.*
- **`vector8` quantization** — deferred from v1 to avoid silent recall regression.
- **Bundle size** — Turso wasm + Tantivy + vector must stay < jsDelivr 50MB (tree-sitter EX-7 constraint). Measured in the spike.
- **Mirror contract break** — `/api/rag/mirror` changes from EdgeVec bytes to Turso DB blob; old mirrors incompatible. Mitigated by versioned payload.
- **FTS transaction visibility** — Turso FTS only visible after `COMMIT`; `ingest` must commit before `OPTIMIZE INDEX` + query.
- **Encryption consolidation** — native `aegis256` DB encryption optional v1; vault.ts stays separate.

**Testing:**
- Unit: `SearchStore` fake backend; `hybrid.ts` RRF correctness; `ner.ts` batch mapping; `embed.ts` session caching.
- Integration: wasm-pipeline end-to-end on pandoc ground-truth fixtures (`.ai-rulez/ground-truth-generation.md`).
- Soak: ingest N folders, query M times, assert no degradation vs cold.
- Compat: old `MetadataStore` API routes in `index.ts` still pass (wrapper preserved).

**Open items (resolve during implementation):**
- Exact Turso package: `@turbodatabase/database` vs `@libsql/client` for Node (recommend `@turbodatabase/database` for native vector + encryption).
- **DB-per-matter vs single-DB-with-matter_id — RESOLVED: single DB, `matter_id` filter.** This keeps the mirror payload simple (one app DB backup), makes `SearchStore.open(matterId)` a scoped connection over the shared DB, and aligns tenant isolation with the `WHERE matter_id = ?` filter already in every query. The vector + FTS indexes are partial (`WHERE matter_id IS NOT NULL`) so graph/segment size stays bounded per matter.
- Whether to encrypt the browser DB at rest (privacy win, small perf cost).
