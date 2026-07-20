# EdgeVec Pipeline Performance Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the on-device document pipeline (extract → embed → NER → persist → query) for speed **while keeping EdgeVec** as the browser vector engine. The prior Turso direction was abandoned after a browser-wasm spike (commit `5f43742545`) proved Turso's FTS + vector ANN are hard-gated out of every browser-wasm engine. EdgeVec `0.9.0` already provides ANN + sparse/BM25 + hybrid RRF + binary quantization natively in the browser. The real bottleneck is EdgeVec's broken `save`/`load` (PostCard `WontImplement`), which forced a JSON-localStorage + per-query `insert()` replay. We fix persistence with our own binary IndexedDB store and unlock EdgeVec's native hybrid search. **xberg extraction keeps best quality** (real perf levers used, never disabling `enable_quality_processing`).

**Architecture:** Stage-isolated pipeline behind a single `SearchStore` abstraction. The browser implementation is **EdgeVec-backed** (dense HNSW + sparse BM25 + native RRF hybrid, binary-quantized option, custom binary persistence). The Node MCP server keeps `better-sqlite3` for metadata and the existing `save_stream` mirror contract. No big-bang storage rewrite.

**Tech Stack:** `edgevec@0.9.0` (WASM vector DB: hybrid RRF, sparse BM25, BQ, metadata filter), `onnxruntime-web@1.26.0` (threaded wasm / WebGPU), `gliner@0.0.19` (batched inference), `xberg-wasm` (extraction, quality ON + WebGPU accel + cache), vitest (wasm-pipeline tests), `@playwright/test` (browser capability spike).

**Spec:** `docs/superpowers/specs/2026-07-20-edgevec-pipeline-perf-design.md` (keep-EdgeVec redesign).

---

## File Structure

**New files (wasm-pipeline):**

- `packages/wasm-pipeline/src/search/store.ts` — `SearchStore` interface + `IndexedChunk`/`RetrievedChunk` mapping (move `IndexedChunk` here from `rag.ts`).
- `packages/wasm-pipeline/src/search/edgevec.ts` — EdgeVec-backed `SearchStore` (dense + sparse insert, `hybridSearch` query, `searchBQ` toggle, capability probe).
- `packages/wasm-pipeline/src/search/persist.ts` — binary IndexedDB persistence (packed `Float32Array` blob + idMap; one session rebuild, no per-query replay).
- `packages/wasm-pipeline/src/search/hybrid.ts` — sparse/BM25 query builder (tokenize keyword → `sparse_indices`/`sparse_values`/`sparse_dim`).
- `packages/wasm-pipeline/src/search/bench.ts` — per-stage benchmark harness + soak test.
- `packages/wasm-pipeline/src/search/edgevec.test.ts` — unit/integration tests.
- `packages/wasm-pipeline/src/search/spike.test.ts` — browser capability + persistence spike.

**Modified files:**

- `packages/wasm-pipeline/src/rag.ts` — rewrite to delegate to `edgevec.ts` + `persist.ts` (keep `serializeIndex` → `save_stream` for `/api/rag/mirror`; keep exported `buildIndex`/`retrieve`/`loadIndex` signatures where imported).
- `packages/wasm-pipeline/src/ner.ts` — batched inference, scenario EP, single `configureOrtEnv`.
- `packages/wasm-pipeline/src/embed.ts` — hoist import/session, threaded wasm.
- `packages/wasm-pipeline/src/ocr.ts` + `ingest.ts` — quality ON + WebGPU accel, Rust+JS cache, OCR via strategy, token reduction.
- `packages/wasm-pipeline/src/ingest.ts` — PersistStage → `SearchStore.ingest` + one blob write at folder completion.
- `packages/wasm-pipeline/src/query.ts` — `SearchStore.query` (hybrid via `edgevec.ts`).
- `packages/wasm-pipeline/src/runtime.ts` — JS-side content-hash cache.

**Deleted / removed:**

- `@lancedb/lancedb` and `@tursodatabase/database-wasm` deps (already removed from `package.json`): not viable in browser wasm (proven).
- localStorage JSON vector persistence (replaced by `persist.ts` binary blob).

---

## Task 0: EdgeVec Capability + Persistence Spike (browser)

**Files:** Create `packages/wasm-pipeline/src/search/spike.test.ts`

This is the **hard precondition** (spec Section 5): confirm EdgeVec's hybrid/sparse/BQ run in the browser and that our binary persistence eliminates per-query rebuild. Turso is NOT a precondition (proven impossible in wasm).

- [ ] **Step 1: Write the spike (runs in Playwright Chromium, loads `edgevec.js`)** asserting each required capability + the persistence fix:
  ```ts
  // executed in a browser context via page.evaluate (see harness in spike.browser.mjs style)
  import init, { EdgeVec as EV, EdgeVecConfig } from "edgevec";
  await init();
  const cfg = new EdgeVecConfig(768); cfg.metric = "cosine";
  const db = new EV(cfg);
  // dense + sparse insert with aligned ids
  db.insert(new Float32Array(768).map(() => Math.random()));
  db.insertSparse(new Uint32Array([10, 42]), new Float32Array([0.8, 1.2]), 30000);
  // hybrid search returns fused results
  const r = db.hybridSearch(new Float32Array(768).map(() => 0.1), new Uint32Array([10]), new Float32Array([0.8]), 30000,
    JSON.stringify({ dense_k: 5, sparse_k: 5, fusion: "rrf", rrf_k: 60 }));
  // BQ path available
  const bq = db.searchBQ(new Float32Array(768).map(() => 0.1), 5);
  // save/load is BROKEN — assert our persist.ts will NOT use it
  let loadBroken = false;
  try { await EV.load("x"); } catch { loadBroken = true; }
  return { hasHybrid: Array.isArray(r), hasBq: Array.isArray(bq), loadBroken };
  ```
- [ ] **Step 2: Run the spike in the browser/wasm test environment** using the Playwright harness pattern (COOP/COEP headers, serve `node_modules/edgevec/edgevec.js`). Expected: `hasHybrid === true`, `hasBq === true`, `loadBroken === true`. If `hasHybrid` is false, **stop** — fall back to dense-only `db.search` (still no Turso). If `loadBroken` is false (a future EdgeVec fixes it), we can adopt native `save`/`load` and simplify `persist.ts`.
- [ ] **Step 3: Record bundle-size measurement** EdgeVec is ~217 KB gzip (documented; verify locally). Confirm < 50 MB jsDelivr limit (trivially met).
- [ ] **Step 4: Commit the spike** (non-cutover probe; old `rag.ts` untouched):
  ```bash
  git add packages/wasm-pipeline/src/search/spike.test.ts
  git commit -m "test(spike): verify edgevec hybrid/sparse/bq in browser + confirm save/load broken"
  ```

---

## Task 1: SearchStore interface + persist.ts binary layout

**Files:** Create `packages/wasm-pipeline/src/search/store.ts`, `packages/wasm-pipeline/src/search/persist.ts`, `packages/wasm-pipeline/src/search/edgevec.test.ts` (schema/interface portion)

- [ ] **Step 1: Define `store.ts`** (move `IndexedChunk` here from `rag.ts:6`; `RetrievedChunk` from `@xberg-io/core`):
  ```ts
  import type { RetrievedChunk } from "@xberg-io/core";
  export interface IndexedChunk {
    docId: string; chunkIndex: number; text: string;
    page?: number; citation?: string; vector: Float32Array;
    sparseIndices?: Uint32Array; sparseValues?: Float32Array; // BM25 terms, optional
  }
  export interface IndexedChunkMap { [id: number]: IndexedChunk; }
  export interface QueryArgs { vector: Float32Array; keyword: string; topK: number; lowRam?: boolean; }
  export interface SearchStore {
    open(matterId: string): Promise<void>;
    ingest(items: IndexedChunk[]): Promise<void>;
    query(matterId: string, args: QueryArgs): Promise<RetrievedChunk[]>;
    persist(matterId: string): Promise<void>;       // write binary blob to IndexedDB
    load(matterId: string): Promise<boolean>;        // one session rebuild from blob
    forget(matterId: string): Promise<void>;
    close(): Promise<void>;
  }
  ```
- [ ] **Step 2: Implement `persist.ts`** per spec Section 2 — `pack(matterId, denseVecs, sparseVecs, idMap): Uint8Array` + `unpack(blob)` + `writeBlob(matterId, blob)`/`readBlob(matterId)` against `indexedDB`. No JSON, no `localStorage`. Binary layout documented in spec Section 2.
- [ ] **Step 3: Write failing test** (round-trip: pack → write → read → unpack equals input vectors; `load()` rebuilds index with zero `insert()` replay for subsequent `query()` calls).
- [ ] **Step 4: Run** `pnpm vitest run src/search/edgevec.test.ts` → PASS.
- [ ] **Step 5: Commit**:
  ```bash
  git add packages/wasm-pipeline/src/search/store.ts packages/wasm-pipeline/src/search/persist.ts packages/wasm-pipeline/src/search/edgevec.test.ts
  git commit -m "feat(search): SearchStore interface + binary IndexedDB persistence"
  ```

---

## Task 2: EdgeVec-backed SearchStore (dense + sparse + hybrid + BQ + probe)

**Files:** Create `packages/wasm-pipeline/src/search/edgevec.ts`, Modify `packages/wasm-pipeline/src/search/edgevec.test.ts`

- [ ] **Step 1: Write failing test** (ingest dense+sparse → `query` returns hybrid-fused top-K with metadata; `lowRam` uses BQ):
  ```ts
  import { EdgeVecSearchStore } from "./edgevec";
  it("ingest dense+sparse then hybrid query returns fused top-K", async () => {
    const s = new EdgeVecSearchStore();
    await s.open("m1");
    await s.ingest([
      { docId:"m1", chunkIndex:0, text:"Acme Corp signed clause 9", page:1, citation:"m1#c0",
        vector:new Float32Array(Array(768).fill(0.1)), sparseIndices:new Uint32Array([1]), sparseValues:new Float32Array([1.0]) },
      { docId:"m1", chunkIndex:1, text:"unrelated cooking recipe", page:2, citation:"m1#c1",
        vector:new Float32Array(Array(768).fill(-0.1)), sparseIndices:new Uint32Array([2]), sparseValues:new Float32Array([1.0]) },
    ]);
    const r = await s.query("m1", { vector:new Float32Array(Array(768).fill(0.1)), keyword:"Acme", topK:2 });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].text).toContain("Acme");
    await s.close();
  });
  ```
- [ ] **Step 2: Implement `edgevec.ts`** per spec Sections 1/4: `new EdgeVecClass(config)` (cosine, dim from `EMBED_DIM`); `ingest` → `insert()` dense (record id) + `insertSparse()` with same id; `query` → build sparse leg via `hybrid.ts` + `db.hybridSearch(dense, idx, val, dim, {dense_k,sparse_k,fusion:"rrf",rrf_k:60})`; `lowRam` → `db.searchBQRescored(dense, topK, 5)`; capability `probe()` on `open` (fallback dense-only if `hybridSearch`/`insertSparse` absent); attach metadata from idMap.
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/search/edgevec.ts packages/wasm-pipeline/src/search/edgevec.test.ts
  git commit -m "feat(search): EdgeVec-backed SearchStore with native hybrid RRF + BQ"
  ```

---

## Task 3: Hybrid sparse/BM25 query builder

**Files:** Create `packages/wasm-pipeline/src/search/hybrid.ts`, Modify `packages/wasm-pipeline/src/search/edgevec.test.ts`

- [ ] **Step 1: Write failing test** (`buildSparse("Acme Corp")` returns aligned `indices`/`values`/`dim` against a built vocabulary; empty query → empty sparse leg → dense-only).
- [ ] **Step 2: Implement** `buildSparse(keyword, vocab)` — tokenize (lowercase, split on non-word), map terms → ids via per-matter vocabulary (built at ingest from chunk terms), weights = tf-idf/BM25. Returns `{ indices: Uint32Array, values: Float32Array, dim: number }`. EdgeVec fuses via `hybridSearch`.
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/search/hybrid.ts packages/wasm-pipeline/src/search/edgevec.test.ts
  git commit -m "feat(search): BM25/sparse query builder for EdgeVec hybrid"
  ```

---

## Task 4: Hybrid sparse/BM25 query builder (spec Section 4)

**Files:** Create `packages/wasm-pipeline/src/search/hybrid.ts`, Modify `packages/wasm-pipeline/src/search/edgevec.test.ts`

- [ ] **Step 1: Write failing test** (`buildSparse("Acme Corp")` returns aligned `indices`/`values`/`dim`; empty query → empty sparse leg).
- [ ] **Step 2: Implement** `buildSparse(keyword, vocab)`: tokenize → term ids via per-matter vocabulary, weights = BM25/idf. Returns `{ indices, values, dim }`.
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/search/hybrid.ts packages/wasm-pipeline/src/search/edgevec.test.ts
  git commit -m "feat(search): BM25/sparse query builder for EdgeVec hybrid"
  ```

---

## Task 4 (alt): NER batching + scenario EP (spec Section 3, BN-1)

**Files:** Modify `packages/wasm-pipeline/src/ner.ts:81-141`

- [ ] **Step 1: Write failing test** (batched inference called once for N texts):
  ```ts
  import { detectPiiBatched } from "./ner";
  it("batches N texts into one inference call", async () => {
    const out = await detectPiiBatched(["John Doe lives in Paris", "Acme Corp HQ"], ["person","organization"], scenario);
    expect(out.length).toBe(2);
  });
  ```
- [ ] **Step 2: Refactor `getModel` + add `detectPiiBatched`** — KEEP `executionProvider: "wasm"` for now (GLiNER has **no EP fallback chain**; WebGPU can fail with nothing to fall back to — preserve stability). Only flip to `scenario.executionProviders[0]` after a new spike confirms GLiNER runs inference on WebGPU for this model. Call `configureOrtEnv()` only inside `getModel` (remove per-call at `ner.ts:128`). Skip texts <20 chars; re-align indices.
  ```ts
  export async function detectPiiBatched(texts, types = PII_TYPES, scenario = DEFAULT_SCENARIO): Promise<PiiEntity[][]> {
    const model = await getModel(scenario);
    const result = await model.inference({ texts, entities: [...types], flatNer: true, threshold: 0.5 });
    return result.map((ents) => ents.map((e) => ({ kind: e.label, start: e.start, end: e.end, text: e.spanText })));
  }
  ```
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/ner.ts packages/wasm-pipeline/src/ner.test.ts
  git commit -m "perf(ner): batch GLiNER inference, single env config, scenario EP opt-in"
  ```

---

## Task 5: Embed threading + cached import (spec Section 3, BN-2)

**Files:** Modify `packages/wasm-pipeline/src/embed.ts:47-78,130`

- [ ] **Step 1: Write failing test** asserting session reused across chunks:
  ```ts
  import { embedChunks } from "./embed";
  it("reuses one session across chunks", async () => {
    const v = await embedChunks([{text:"a"},{text:"b"}], scenario);
    expect(v.length).toBe(2);
  });
  ```
- [ ] **Step 2: Hoist import + threaded wasm** — module-scope `ortModPromise`; in `getSession` set `ort.env.wasm.numThreads = scenario.numThreads; ort.env.wasm.wasmPaths = ONNXRUNTIME_WEB_WASM_PATHS;` before `InferenceSession.create` (keep `graphOptimizationLevel:"all"`). Remove the `await import("onnxruntime-web")` inside `embedOne`. Re-evaluate the current `numThreads = 1` + "never construct a Worker" comment: threading is now worthwhile because embedding is batched.
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/embed.ts packages/wasm-pipeline/src/embed.test.ts
  git commit -m "perf(embed): cache ort import+session, enable multithreaded wasm"
  ```

---

## Task 6: Extraction config tuning — BEST QUALITY + perf (spec Section 3, EX-1/2/5)

**Files:** Modify `packages/wasm-pipeline/src/ocr.ts`, `ingest.ts:44-51`, `runtime.ts`

**Best-quality + performance (verified against `crates/xberg-wasm/src/lib.rs` + `crates/xberg/src/text/quality_processor.rs`): do NOT disable quality — `enable_quality_processing` (default true) only adds a `quality_score` + light normalization; turning it off loses quality for ~1ms/100KB. Use the real perf levers instead.**

- [ ] **Step 1: Write failing test** (quality kept ON, WebGPU accel + cache enabled):
  ```ts
  import { defaultExtractionConfig } from "./ocr";
  it("extraction keeps quality on and enables acceleration + cache", async () => {
    const cfg = await defaultExtractionConfig();
    expect(cfg.enable_quality_processing()).toBe(true);   // best quality, never off
    expect(cfg.acceleration()?.provider).toBe("webgpu");  // hw accel when available
    expect(cfg.use_cache()).toBe(true);
  });
  ```
- [ ] **Step 2: Apply tuning** — `ocr.ts` `defaultExtractionConfig()`:
  - `cfg.set_enable_quality_processing(true)` — keep best quality (it's the default; never disable).
  - `cfg.set_use_cache(true)` + `cfg.set_cache_namespace("wasm-pipeline")` + `cfg.set_cache_ttl_secs(3600)` — use the Rust cache across reloads.
  - `cfg.set_acceleration({ provider: "webgpu", deviceId: 0 })` when `scenario` reports WebGPU; CPU-only fallback when unavailable.
  - `cfg.set_max_concurrent_extractions(scenario.numThreads)` for batch parallelism; prefer `extract_batch` in `ingest.ts`.
  - `cfg.set_token_reduction({ mode: scenario.tokenReduction ?? "balanced", preserve_important_words: true })` — quality-safe token savings.
  - Keep OCR **ON** for best quality: set `ocr_strategy` / `force_ocr` per scenario; only `disable_ocr` when input is known text-only and user opts out. Do NOT blanket-disable.
  - `cfg.set_use_layout_for_markdown(true)` for richer structured markdown.
  - `ingest.ts`: `chunkerType` from `scenario` (`markdown` normally, `text` on `lowRam||isMobile`).
  - `runtime.ts`: `Map<contentHash, WasmExtractionResult>` cache keyed on `hash(bytes)` (wasm `extract_bytes` may bypass the Rust cache).
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/ocr.ts packages/wasm-pipeline/src/ingest.ts packages/wasm-pipeline/src/runtime.ts packages/wasm-pipeline/src/ocr.test.ts
  git commit -m "perf(extract): keep quality ON + WebGPU accel, Rust+JS cache, OCR via strategy, token reduction"
  ```

---

## Task 7: Wire ingest + query to SearchStore (spec Sections 1/4)

**Files:** Modify `packages/wasm-pipeline/src/rag.ts`, `ingest.ts:88-104`, `query.ts`

- [ ] **Step 1: Write integration test** (end-to-end on a fixture):
  ```ts
  import { ingestFolder } from "./ingest";
  import { queryRag } from "./query";
  it("ingest then query returns relevant chunk via hybrid", async () => {
    const store = new EdgeVecSearchStore();
    const res = await ingestFolder(matter, folder, file, { passphrase, scopeToken, store });
    expect(res.accepted).toBeGreaterThan(0);
    const hits = await queryRag(matter, "Acme Corp", 4, store);
    expect(hits.some(h => h.text.includes("Acme"))).toBe(true);
  });
  ```
- [ ] **Step 2: Repoint** — `rag.ts`: rewrite `buildIndex`/`loadIndex`/`retrieve` to delegate to `EdgeVecSearchStore` + `persist.ts` (keep signatures used by `ingest.ts`/`query.ts`; keep `serializeIndex` → `save_stream` for `/api/rag/mirror`). `ingest.ts`: PersistStage → `store.ingest(items)` then `store.persist(matterId)` (one IndexedDB blob write at folder completion). `query.ts`: replace `retrieve(matter.id, vec, topK)` with `store.query(matter.id, { vector: vec, keyword: query, topK })`.
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/rag.ts packages/wasm-pipeline/src/ingest.ts packages/wasm-pipeline/src/query.ts packages/wasm-pipeline/src/ingest.test.ts
  git commit -m "feat(pipeline): wire ingest+query to EdgeVec SearchStore hybrid"
  ```

---

## Task 8: Node MCP server unchanged (mirror contract preserved)

**Files:** `services/mcp-server/src/store.ts`, `mirror.ts`, `index.ts:249` — **NO CHANGE required.** The browser keeps `serializeIndex` → `save_stream` for `/api/rag/mirror`; Node `MirrorStore` reopens the EdgeVec byte stream as before. `better-sqlite3` stays for Node metadata. This task is a verification gate, not a change.

- [ ] **Step 1: Add `services/mcp-server/tests/mirror.test.ts`** asserting the existing mirror contract still works after the browser change (browser ships `save_stream` bytes; Node reopens). Run `pnpm test` in `services/mcp-server`.
- [ ] **Step 2: Commit** (tests only):
  ```bash
  git add services/mcp-server/tests/mirror.test.ts
  git commit -m "test(mcp): assert mirror contract unchanged after EdgeVec persistence fix"
  ```

---

## Task 9: Benchmark harness + soak test (spec Section 5)

**Files:** Create `packages/wasm-pipeline/src/search/bench.ts`; extend as needed.

- [ ] **Step 1: Write `benchPipeline`** timing each stage on a fixed fixture; assert budgets: Extract <800ms, Embed <400ms, NER <600ms (spike-measured), Persist <200ms + 1 blob write, Query <100ms.
- [ ] **Step 2: Soak test** — ingest N=20 folders (~50 chunks each), query M=100 times; assert query p95 stays <100ms and does **not degrade vs the first query** (proves no per-query localStorage rebuild / `insert()` replay).
- [ ] **Step 3: Run harness + soak** `pnpm vitest run src/search/bench.ts` → all budgets met; soak shows flat query latency.
- [ ] **Step 4: Commit.**
  ```bash
  git add packages/wasm-pipeline/src/search/bench.ts
  git commit -m "test(perf): stage benchmark harness + soak test against latency budgets"
  ```

---

## Verification Summary

- **Task 0 spike** is the hard gate — confirms EdgeVec hybrid/sparse/BQ run in-browser and that `persist.ts` removes the per-query rebuild. Turso is explicitly NOT a precondition (proven impossible in wasm).
- Each task is TDD: failing test → implement → pass → commit.
- Final acceptance: `pnpm test` (wasm-pipeline + mcp-server) PASS + bench budgets met + soak flat.
- Rollback if needed: `git revert` any task commit; old `rag.ts` localStorage path is replaced incrementally inside `rag.ts`, so reverting Task 7 restores prior behavior.
