# EdgeVec Pipeline Performance Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the on-device document pipeline (extract → embed → NER → persist → query) for speed **while keeping EdgeVec** as the browser vector engine. The prior Turso direction was abandoned after a browser-wasm spike (commit `5f43742545`) proved Turso's FTS + vector ANN are hard-gated out of every browser-wasm engine. EdgeVec `0.9.0` already provides ANN + sparse/BM25 + hybrid RRF + binary quantization natively in the browser. The real bottleneck is EdgeVec's broken **`load`** (`EdgeVec.load()` throws `Deserialization failed: This is a feature that PostCard will never implement`, spec Section «Persistence»); `save()`/`save_stream()` succeed but there is **no working load path** in 0.9.0. We fix persistence with our own binary IndexedDB store and unlock EdgeVec's native hybrid search. **xberg extraction keeps best quality** (real perf levers used, never disabling `enableQualityProcessing`).

**Current baseline (verified against source, do not misstate):** [`rag.ts`](../../src/rag.ts) (113 lines) already uses EdgeVec natively — `buildIndex` → `insertWithMetadata` + `db.save(name)`; `loadIndex` → `EdgeVec.load(name)`; `retrieve` → `loadIndex` then `db.search`. There is **no `localStorage`** anywhere in `src/` (verified: `grep -r localStorage src/` = 0 hits) and **no per-query JSON replay in the committed code**. Because `EdgeVec.load()` is broken in 0.9.0, the current `retrieve()`/`queryRag()` path **throws at runtime** on any second session — that broken native-load path (not a localStorage workaround) is what `persist.ts` replaces.

**Architecture:** Stage-isolated pipeline behind a single `SearchStore` abstraction. The browser implementation is **EdgeVec-backed** (dense HNSW + sparse BM25 + native RRF hybrid, binary-quantized option, custom binary persistence). The Node MCP server keeps `better-sqlite3` for metadata and the existing `save_stream` mirror contract. No big-bang storage rewrite.

**Tech Stack (versions pinned in `package.json`, verify before quoting):** `edgevec@^0.9.0` (WASM vector DB: hybrid RRF, sparse BM25, BQ, metadata filter), `onnxruntime-web@^1.24.2` (threaded wasm / WebGPU), `gliner@^0.0.19` (batched inference), `@xberg-io/xberg-wasm@1.0.0-rc.26` (extraction, quality ON + WebGPU accel + cache), `@xberg-io/core` (`RetrievedChunk`/`IndexedChunk` types), vitest 2.x (wasm-pipeline tests), `@playwright/test` (browser capability spike — add to devDeps if absent).

**Spec:** `docs/superpowers/specs/2026-07-20-edgevec-pipeline-perf-design.md` (keep-EdgeVec redesign).

**API ground truth (verified in installed `.d.ts` — the plan MUST match these exact shapes):**

- `db.hybridSearch(dense, sparseIdx, sparseVal, sparseDim, optionsJson): string` — **returns a raw JSON string**; options is a **JSON string**. Always `JSON.parse(...)` the result and `JSON.stringify(...)` the options (edgevec.d.ts:340).
- `db.insertSparse(indices: Uint32Array, values: Float32Array, dim: number): number` (edgevec.d.ts:409).
- `db.insertWithMetadata(vector: Float32Array, metadata_js: any): number` (edgevec.d.ts:1150).
- `db.getAllMetadata(vector_id: number): any` (edgevec.d.ts:727).
- `db.searchBQ(query, k): any` / `db.searchBQRescored(query, k, rescoreFactor): any` (edgevec.d.ts:1520/952).
- `db.save(name): Promise<void>` / `db.save_stream(chunkSize?): PersistenceIterator` **work**; `EdgeVec.load(name): Promise<EdgeVec>` is the **broken** path.
- `WasmExtractionConfig` uses **camelCase field accessors**, not `snake_case` setters: `enableQualityProcessing: boolean`, `useCache: boolean`, `cacheNamespace?: string`, `cacheTtlSecs?: bigint`, `acceleration?: WasmAccelerationConfig`, `maxConcurrentExtractions?: number`, `tokenReduction?: WasmTokenReductionOptions`, `forceOcr: boolean`, `disableOcr: boolean`, `ocrStrategy: any`, `useLayoutForMarkdown: boolean` (xberg_wasm.d.ts:1368-1467).

---

## File Structure

**New files (wasm-pipeline):**

- `packages/wasm-pipeline/src/search/store.ts` — `SearchStore` interface + `IndexedChunk`/`RetrievedChunk` mapping (move `IndexedChunk` here from `rag.ts`).
- `packages/wasm-pipeline/src/search/edgevec.ts` — EdgeVec-backed `SearchStore` (dense + sparse insert, `hybridSearch` query, `searchBQ` toggle, capability probe).
- `packages/wasm-pipeline/src/search/persist.ts` — binary IndexedDB persistence (packed `Float32Array` blob + idMap; one session rebuild, no per-query replay).
- `packages/wasm-pipeline/src/search/hybrid.ts` — sparse/BM25 query builder (tokenize keyword → `sparseIndices`/`sparseValues`/`sparseDim`).
- `packages/wasm-pipeline/src/search/bench.ts` — per-stage benchmark harness + soak test.
- `packages/wasm-pipeline/src/search/edgevec.test.ts` — unit/integration tests.
- `packages/wasm-pipeline/src/search/spike.test.ts` — browser capability + persistence spike.

**Modified files (current line counts noted for orientation; re-grep before editing):**

- `packages/wasm-pipeline/src/rag.ts` (113 ln) — rewrite to delegate to `edgevec.ts` + `persist.ts` (keep `serializeIndex` → `save_stream` for `/api/rag/mirror`; keep exported `buildIndex`/`retrieve`/`loadIndex` signatures used by `ingest.ts`/`query.ts`).
- `packages/wasm-pipeline/src/ner.ts` (106 ln) — batched inference, single import; keep scenario-driven EP (already `scenario.executionProviders[0]`).
- `packages/wasm-pipeline/src/embed.ts` (185 ln) — hoist the per-call `onnxruntime-web` import inside `embedOne`; session/threading already hoisted.
- `packages/wasm-pipeline/src/ocr.ts` (20 ln) + `ingest.ts` (111 ln) — quality ON + WebGPU accel, Rust+JS cache, OCR via strategy, token reduction.
- `packages/wasm-pipeline/src/ingest.ts` — PersistStage → `SearchStore.ingest` + one blob write at folder completion.
- `packages/wasm-pipeline/src/query.ts` (11 ln) — `SearchStore.query` (hybrid via `edgevec.ts`).
- `packages/wasm-pipeline/src/runtime.ts` — JS-side content-hash cache.

**Deleted / removed:**

- `@lancedb/lancedb` and `@tursodatabase/database-wasm` deps (already removed from `package.json`): not viable in browser wasm (proven).
- Broken native `EdgeVec.load()` query path (replaced by `persist.ts` binary blob rebuild). There is no `localStorage` path to delete.

---

## Task 0: EdgeVec Capability + Persistence Spike (browser)

**Files:** Create `packages/wasm-pipeline/src/search/spike.test.ts`

This is the **hard precondition** (spec Section 5): confirm EdgeVec's hybrid/sparse/BQ run in the browser and that our binary persistence eliminates per-query rebuild. Turso is NOT a precondition (proven impossible in wasm).

- [ ] **Step 1: Write the spike (runs in Playwright Chromium, loads `edgevec.js`)** asserting each required capability + the persistence fix. **Note the exact return semantics: `hybridSearch`/`searchBQ` return values that must be parsed/inspected correctly — `hybridSearch` returns a JSON string.**
  ```ts
  // executed in a browser context via page.evaluate
  import init, { EdgeVec as EV, EdgeVecConfig } from "edgevec";
  await init();
  const cfg = new EdgeVecConfig(768); cfg.metric = "cosine";
  const db = new EV(cfg);
  // dense + sparse insert with aligned ids
  const denseId = db.insertWithMetadata(new Float32Array(768).map(() => Math.random()), { text: "x" });
  db.insertSparse(new Uint32Array([10, 42]), new Float32Array([0.8, 1.2]), 30000);
  // hybrid search returns a JSON STRING → must JSON.parse; options is a JSON STRING → must JSON.stringify
  const rRaw = db.hybridSearch(
    new Float32Array(768).map(() => 0.1), new Uint32Array([10]), new Float32Array([0.8]), 30000,
    JSON.stringify({ dense_k: 5, sparse_k: 5, fusion: "rrf", rrf_k: 60 }));
  const r = JSON.parse(rRaw);
  // BQ path available (returns array-like)
  const bq = db.searchBQ(new Float32Array(768).map(() => 0.1), 5);
  // load is BROKEN — prove it with a REAL save→load round-trip, not a load of a non-existent name
  let loadBroken = false;
  await db.save("spike-roundtrip");
  try { await EV.load("spike-roundtrip"); } catch (e) { loadBroken = /PostCard|Deserialization/.test(String(e)); }
  return { hasHybrid: Array.isArray(r), hasBq: Array.isArray(bq), loadBroken, denseId };
  ```
- [ ] **Step 2: Run the spike in the browser/wasm test environment** using the Playwright harness pattern (COOP/COEP headers, serve `node_modules/edgevec/edgevec.js`). Expected: `hasHybrid === true`, `hasBq === true`, `loadBroken === true`. If `hasHybrid` is false, **stop** — fall back to dense-only `db.search` (still no Turso). If `loadBroken` is false (a future EdgeVec fixes load), we can adopt native `save`/`load` and simplify `persist.ts`. **Do not** infer brokenness from loading a name that was never saved — the round-trip above saves first, so a throw genuinely indicates the load bug.
- [ ] **Step 3: Record bundle-size measurement** EdgeVec is ~217 KB gzip (documented; verify locally with `gzip -c node_modules/edgevec/edgevec_bg.wasm | wc -c`). Confirm < 50 MB jsDelivr limit (trivially met).
- [ ] **Step 4: Commit the spike** (non-cutover probe; old `rag.ts` untouched):
  ```bash
  git add packages/wasm-pipeline/src/search/spike.test.ts
  git commit -m "test(spike): verify edgevec hybrid/sparse/bq in browser + confirm load broken via round-trip"
  ```

---

## Task 1: SearchStore interface + persist.ts binary layout

**Files:** Create `packages/wasm-pipeline/src/search/store.ts`, `packages/wasm-pipeline/src/search/persist.ts`, `packages/wasm-pipeline/src/search/edgevec.test.ts` (schema/interface portion)

- [ ] **Step 1: Define `store.ts`** (move `IndexedChunk` here from `rag.ts:6-14`; `RetrievedChunk` from `@xberg-io/core`). **KEEP the existing `bbox` field** — the current `retrieve()` propagates `bbox` into `RetrievedChunk`; dropping it is a regression:
  ```ts
  import type { RetrievedChunk, BoundingBox } from "@xberg-io/core";
  export interface IndexedChunk {
    docId: string; chunkIndex: number; text: string;
    page?: number; citation?: string; bbox?: BoundingBox; vector: Float32Array;
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
- [ ] **Step 2: Implement `persist.ts`** per spec Section 2 — `pack(matterId, denseVecs, sparseVecs, idMap): Uint8Array` + `unpack(blob)` + `writeBlob(matterId, blob)`/`readBlob(matterId)` against `indexedDB`. No JSON, no `localStorage`. Binary layout documented in spec Section 2. The blob rebuilds the EdgeVec index once per `load()` via `insert*` replay **at session start only** (never per query).
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
- [ ] **Step 2: Implement `edgevec.ts`** per spec Sections 1/4:
  - `new EdgeVecClass(config)` (cosine, dim from `EMBED_DIM`).
  - `ingest` → for each item, `insertWithMetadata(vector, meta)` (record returned id), then `insertSparse(sparseIndices, sparseValues, dim)` with the **same id alignment**; keep an `IndexedChunkMap` from id → metadata (incl. `bbox` JSON as today).
  - `query` → build the sparse leg via `hybrid.ts`, then:
    ```ts
    const optionsJson = JSON.stringify({ dense_k: topK, sparse_k: topK, fusion: "rrf", rrf_k: 60 });
    const hits = JSON.parse(db.hybridSearch(dense, sparse.indices, sparse.values, sparse.dim, optionsJson));
    ```
    **`hybridSearch` returns a JSON string — always `JSON.parse`.** If `keyword` is empty, skip the sparse leg and use `db.search(dense, topK)` (dense-only).
  - `lowRam` → `db.searchBQRescored(dense, topK, 5)` (BQ path; `searchBQ`/`searchBQRescored` return array-like, no JSON.parse).
  - `probe()` on `open`: feature-detect `typeof db.hybridSearch === "function" && typeof db.insertSparse === "function"`; fall back to dense-only if absent.
  - Attach metadata from the id map (reuse the `EdgeVecMetadata` mapping already in `rag.ts:16-23`, including `bbox` parse).
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/search/edgevec.ts packages/wasm-pipeline/src/search/edgevec.test.ts
  git commit -m "feat(search): EdgeVec-backed SearchStore with native hybrid RRF + BQ"
  ```

---

## Task 3: Hybrid sparse/BM25 query builder (spec Section 4)

**Files:** Create `packages/wasm-pipeline/src/search/hybrid.ts`, Modify `packages/wasm-pipeline/src/search/edgevec.test.ts`

> _(Merged: the previous plan listed this task twice — as “Task 3” and “Task 4” with identical bodies. There is one `hybrid.ts` and one implementation task.)_

- [ ] **Step 1: Write failing test** (`buildSparse("Acme Corp", vocab)` returns aligned `indices`/`values`/`dim` against a built vocabulary; empty query → empty sparse leg → dense-only).
- [ ] **Step 2: Implement** `buildSparse(keyword, vocab)` — tokenize (lowercase, split on non-word), map terms → ids via a per-matter vocabulary (built at ingest from chunk terms), weights = tf-idf/BM25. Returns `{ indices: Uint32Array, values: Float32Array, dim: number }`. EdgeVec fuses via `hybridSearch`. Export a `buildVocabulary(chunks)` helper used by `edgevec.ts` `ingest` so query-time term ids align with insert-time ids.
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/search/hybrid.ts packages/wasm-pipeline/src/search/edgevec.test.ts
  git commit -m "feat(search): BM25/sparse query builder for EdgeVec hybrid"
  ```

---

## Task 4: NER batching + single import (spec Section 3, BN-1)

**Files:** Modify `packages/wasm-pipeline/src/ner.ts` (whole file is 106 ln; `getModel` at 50-79, `detectPii` at 81-106)

> _(Corrected: the previous plan referenced `ner.ts:81-141` and a `configureOrtEnv()` call at `ner.ts:128` — neither exists. The file is 106 lines and contains no `configureOrtEnv`. It **already** selects the EP via `scenario.executionProviders[0]` (ner.ts:66); do NOT hard-code `"wasm"` — that would regress the current scenario-driven behavior.)_

- [ ] **Step 1: Write failing test** (batched inference returns one result array per input text):
  ```ts
  import { detectPiiBatched } from "./ner";
  it("batches N texts into one inference call", async () => {
    const out = await detectPiiBatched(["John Doe lives in Paris", "Acme Corp HQ"], undefined, scenario);
    expect(out.length).toBe(2);
  });
  ```
- [ ] **Step 2: Add `detectPiiBatched`** reusing the existing `getModel(scenario)` (which already caches by `{quant, ep}` and reuses `modelPromise`). Pass the whole `texts` array to a single `model.inference({ texts, ... })` call instead of N calls. Keep the current EP selection (`scenario.executionProviders[0]`) — GLiNER’s EP fallback is already handled by passing the ordered `executionProviders`; only revisit if a browser spike shows WebGPU inference fails for this model. Skip texts <20 chars and re-align output indices to the original array.
  ```ts
  export async function detectPiiBatched(
    texts: string[], types: readonly string[] = PII_TYPES, scenario: ModelScenario = DEFAULT_SCENARIO,
  ): Promise<PiiEntity[][]> {
    const model = await getModel(scenario);
    const result = await model.inference({ texts, entities: [...types], flatNer: true, threshold: 0.5 });
    return result.map((ents) => ents.map((e) => ({ kind: e.label, start: e.start, end: e.end, text: e.spanText })));
  }
  ```
  Keep `detectPii` (single-text) as a thin wrapper over `detectPiiBatched` for callers that still pass one text.
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/ner.ts packages/wasm-pipeline/src/ner.test.ts
  git commit -m "perf(ner): batch GLiNER inference into one call, keep scenario-driven EP"
  ```

---

## Task 5: Embed — hoist per-call ORT import (spec Section 3, BN-2)

**Files:** Modify `packages/wasm-pipeline/src/embed.ts` (185 ln)

> _(Corrected: session caching + `ort.env.wasm.numThreads = scenario.numThreads` are **already** in `getSession` (embed.ts:52-66); `graphOptimizationLevel:"all"` is already set. The remaining win is the redundant `await import("onnxruntime-web")` inside `embedOne` at **embed.ts:118**, re-imported on every chunk.)_

- [ ] **Step 1: Write failing test** asserting one session reused across chunks:
  ```ts
  import { embedChunks } from "./embed";
  it("reuses one session across chunks", async () => {
    const v = await embedChunks([{text:"a"},{text:"b"}], scenario);
    expect(v.length).toBe(2);
  });
  ```
- [ ] **Step 2: Hoist the ORT import** — add a module-scope `let ortModPromise: Promise<typeof import("onnxruntime-web")> | null` with an `getOrt()` helper; use it in both `getSession` (line 55) and `embedOne` (replace the per-call `await import("onnxruntime-web")` at line 118). Keep `numThreads`/`graphOptimizationLevel` as-is. Optionally set `ort.env.wasm.wasmPaths` to the locally-served ORT wasm dir if one is exposed by constants; skip if not present.
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/embed.ts packages/wasm-pipeline/src/embed.test.ts
  git commit -m "perf(embed): hoist onnxruntime-web import out of the per-chunk path"
  ```

---

## Task 6: Extraction config tuning — BEST QUALITY + perf (spec Section 3, EX-1/2/5)

**Files:** Modify `packages/wasm-pipeline/src/ocr.ts` (20 ln), `ingest.ts:47-54`, `runtime.ts`

**Best-quality + performance (verified against `crates/xberg-wasm/src/lib.rs` + `crates/xberg/src/text/quality_processor.rs`): do NOT disable quality — `enableQualityProcessing` (default true) only adds a `quality_score` + light normalization. Use the real perf levers instead.**

> _(Corrected: `WasmExtractionConfig` exposes **camelCase field accessors**, NOT `snake_case` setters. There is no `set_enable_quality_processing()`, `set_use_cache()`, `set_cache_namespace()`, `set_cache_ttl_secs()`, `set_max_concurrent_extractions()`, or `set_token_reduction()`. `cacheTtlSecs` is a **`bigint`**. `acceleration` and `tokenReduction` take **`WasmAccelerationConfig` / `WasmTokenReductionOptions` instances**, not plain objects — verify their constructors in `xberg_wasm.d.ts` before use. Current `defaultExtractionConfig()` returns `new m.WasmExtractionConfig()` with all-optional args.)_

- [ ] **Step 1: Write failing test** (quality kept ON, accel + cache enabled) using the real field API:
  ```ts
  import { defaultExtractionConfig } from "./ocr";
  it("extraction keeps quality on and enables acceleration + cache", async () => {
    const cfg = await defaultExtractionConfig();
    expect(cfg.enableQualityProcessing).toBe(true);   // best quality, never off
    expect(cfg.useCache).toBe(true);
    expect(cfg.acceleration).toBeDefined();            // hw accel when available
  });
  ```
- [ ] **Step 2: Apply tuning** in `ocr.ts` `defaultExtractionConfig()` (assign fields, don’t call absent setters):
  - `cfg.enableQualityProcessing = true` — keep best quality (default; never disable).
  - `cfg.useCache = true`; `cfg.cacheNamespace = "wasm-pipeline"`; `cfg.cacheTtlSecs = 3600n` (**bigint literal**) — use the Rust cache across reloads.
  - `cfg.acceleration = new m.WasmAccelerationConfig(...)` when `scenario` reports WebGPU; leave `undefined` (CPU) otherwise. **Verify the `WasmAccelerationConfig` constructor signature in `xberg_wasm.d.ts` first.**
  - `cfg.maxConcurrentExtractions = scenario.numThreads` for batch parallelism; prefer `extract_batch` in `ingest.ts` if available.
  - `cfg.tokenReduction = new m.WasmTokenReductionOptions(...)` (mode `scenario.tokenReduction ?? "balanced"`, preserve important words) — quality-safe token savings. **Verify the constructor first.**
  - Keep OCR **ON** for best quality: set `cfg.ocrStrategy` / `cfg.forceOcr` per scenario; only `cfg.disableOcr = true` when input is known text-only and the user opts out. Do NOT blanket-disable. (`withTesseractOcr` in `ocr.ts` already wires `WasmOcrConfig`.)
  - `cfg.useLayoutForMarkdown = true` for richer structured markdown.
  - `ingest.ts:51-54`: `chunkerType` from `scenario` (`markdown` normally, `text` on `lowRam||isMobile`) — currently hard-coded `"markdown"`.
  - `runtime.ts`: `Map<contentHash, WasmExtractionResult>` cache keyed on `hash(bytes)` (wasm `extract_bytes` may bypass the Rust cache).
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/ocr.ts packages/wasm-pipeline/src/ingest.ts packages/wasm-pipeline/src/runtime.ts packages/wasm-pipeline/src/ocr.test.ts
  git commit -m "perf(extract): keep quality ON + accel, Rust+JS cache, OCR via strategy, token reduction"
  ```

---

## Task 7: Wire ingest + query to SearchStore (spec Sections 1/4)

**Files:** Modify `packages/wasm-pipeline/src/rag.ts`, `ingest.ts:41-111`, `query.ts:7-11`

> _(Corrected signatures — current `ingestFolder(matter, folder, file, options)` where `options: { passphrase, scopeToken, maxCharacters?, language? }`, and `queryRag(matter, query, topK = 8)`. Threading a `SearchStore` through means **extending these signatures**, e.g. adding an optional `store` to `IngestOptions` and a `store?` param to `queryRag`. Default to a shared `EdgeVecSearchStore` singleton when not provided so existing callers keep working.)_

- [ ] **Step 1: Write integration test** (end-to-end on a fixture, matching the real+extended signatures):
  ```ts
  import { ingestFolder } from "./ingest";
  import { queryRag } from "./query";
  import { EdgeVecSearchStore } from "./search/edgevec";
  it("ingest then query returns relevant chunk via hybrid", async () => {
    const store = new EdgeVecSearchStore();
    const res = await ingestFolder(matter, folder, file, { passphrase, scopeToken, store });
    expect(res.accepted).toBeGreaterThan(0);
    const hits = await queryRag(matter, "Acme Corp", 4, store);
    expect(hits.some(h => h.text.includes("Acme"))).toBe(true);
  });
  ```
- [ ] **Step 2: Repoint** —
  - `rag.ts`: rewrite `buildIndex`/`loadIndex`/`retrieve` to delegate to `EdgeVecSearchStore` + `persist.ts` (keep signatures used by `ingest.ts`/`query.ts`; **keep `serializeIndex` → `save_stream` for `/api/rag/mirror`** — that path is unaffected by the load bug).
  - `ingest.ts`: after the redaction loop (currently `buildIndex` at line 104), call `store.ingest(items)` then `store.persist(matter.id)` (one IndexedDB blob write at folder completion). Keep the mirror push (`serializeIndex` → `serializeMirrorToBytes` → `pushMirror`).
  - `query.ts`: replace `retrieve(matter.id, vec, topK)` (line 10) with `store.query(matter.id, { vector: vec, keyword: query, topK })`.
- [ ] **Step 3: Run test → PASS. Commit.**
  ```bash
  git add packages/wasm-pipeline/src/rag.ts packages/wasm-pipeline/src/ingest.ts packages/wasm-pipeline/src/query.ts packages/wasm-pipeline/src/ingest.test.ts
  git commit -m "feat(pipeline): wire ingest+query to EdgeVec SearchStore hybrid"
  ```

---

## Task 8: Node MCP server unchanged (mirror contract preserved)

**Files:** `services/mcp-server/src/store.ts`, `mirror.ts`, `index.ts` — **NO CHANGE required.** The browser keeps `serializeIndex` → `save_stream` for `/api/rag/mirror`; Node `MirrorStore` reopens the EdgeVec byte stream as before (`save_stream` works; only browser-side `load` was broken). `better-sqlite3` stays for Node metadata. This task is a verification gate, not a change.

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
- [ ] **Step 2: Soak test** — ingest N=20 folders (~50 chunks each), query M=100 times; assert query p95 stays <100ms and does **not degrade vs the first query** (proves persistence rebuilds once per session, not per query — the failure mode of the old broken-load path).
- [ ] **Step 3: Run harness + soak** `pnpm vitest run src/search/bench.ts` → all budgets met; soak shows flat query latency.
- [ ] **Step 4: Commit.**
  ```bash
  git add packages/wasm-pipeline/src/search/bench.ts
  git commit -m "test(perf): stage benchmark harness + soak test against latency budgets"
  ```

---

## Verification Summary

- **Task 0 spike** is the hard gate — confirms EdgeVec hybrid/sparse/BQ run in-browser (parsing `hybridSearch`’s JSON string correctly) and that `load` is broken via a real save→load round-trip, so `persist.ts` is justified. Turso is explicitly NOT a precondition (proven impossible in wasm).
- Each task is TDD: failing test → implement → pass → commit.
- Final acceptance: `pnpm test` (wasm-pipeline + mcp-server) PASS + bench budgets met + soak flat.
- Rollback if needed: `git revert` any task commit; the old `rag.ts` path is replaced incrementally inside `rag.ts`, so reverting Task 7 restores prior behavior (note: prior `retrieve()` was already broken at runtime due to `EdgeVec.load()`, so “restore” means restore to the pre-fix state, not a working query path).

## Changelog vs previous revision of this plan

- **Fixed hard-gate bug:** `hybridSearch` returns a **JSON string**; spike now `JSON.parse`s it (old `Array.isArray(rawString)` was always false → false-negative gate).
- **Fixed load-broken test:** now a real `save("name")` → `load("name")` round-trip matching on `PostCard`/`Deserialization`, instead of loading a never-saved name (which always throws).
- **Corrected baseline description:** no `localStorage` and no per-query JSON replay exist in the committed code; the broken path is native `EdgeVec.load()`. Removed false “JSON-localStorage” framing throughout.
- **Corrected NER task:** real file is 106 ln with no `configureOrtEnv`; EP is already scenario-driven — removed the instruction to hard-code `"wasm"`.
- **Corrected embed task:** session/threading already hoisted; the only remaining fix is the per-call ORT import at `embed.ts:118`.
- **Corrected extraction task:** `WasmExtractionConfig` uses camelCase **fields** (`enableQualityProcessing`, `useCache`, `cacheNamespace`, `cacheTtlSecs: bigint`, `acceleration`, `tokenReduction`, `forceOcr`, `disableOcr`, `useLayoutForMarkdown`), not `snake_case` setters; `cacheTtlSecs` is a bigint; accel/tokenReduction take Wasm* config instances.
- **De-duplicated tasks:** old plan had Task 3 and Task 4 as identical `hybrid.ts` tasks plus a colliding second “Task 4”. Now one `hybrid.ts` task (Task 3) and clean numbering 0–9.
- **Kept `bbox`** on `IndexedChunk` (old rewrite dropped it, regressing citation bounding boxes).
- **Corrected Task 7 signatures** to match real `ingestFolder`/`queryRag` and made `store` an explicit extension.
- **Corrected versions:** `onnxruntime-web@^1.24.2` (not 1.26.0), `@xberg-io/xberg-wasm@1.0.0-rc.26` (not “xberg-wasm”).
