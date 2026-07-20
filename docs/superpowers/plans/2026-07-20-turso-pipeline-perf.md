# Turso Pipeline Performance Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the on-device document pipeline (extract → embed → NER → persist → query) for speed, replacing EdgeVec+localStorage and better-sqlite3 with Turso (native vector ANN + Tantivy FTS + RRF hybrid), gated on a browser-wasm capability spike.

**Architecture:** Stage-isolated pipeline behind a single `SearchStore` abstraction. A shared Turso SQL schema (`chunks` + vector index + FTS index + metadata tables) serves both the browser (wasm/OPFS) and the Node MCP server. Query runs vector + FTS legs in parallel, fused with Reciprocal Rank Fusion. Big-bang cutover happens only after the wasm spike + soak pass.

**Tech Stack:** `@tursodatabase/database` (Turso, native vector + Tantivy FTS, `experimental: ["index_method"]` for FTS), `onnxruntime-web@1.26.0` (threaded wasm / WebGPU), `gliner@0.0.19` (batched inference), `xberg-wasm` (extraction), vitest (wasm-pipeline tests), criterion (benchmark-harness).

**Spec:** `docs/superpowers/specs/2026-07-20-turso-pipeline-perf-design.md`

---

## File Structure

**New files (wasm-pipeline):**
- `packages/wasm-pipeline/src/search/schema.ts` — DDL string (single source for both targets).
- `packages/wasm-pipeline/src/search/store.ts` — `SearchStore` interface + `IndexedChunk`/`RetrievedChunk` mapping.
- `packages/wasm-pipeline/src/search/turso.ts` — Turso implementation (browser wasm + Node), capability probe.
- `packages/wasm-pipeline/src/search/hybrid.ts` — RRF fusion.
- `packages/wasm-pipeline/src/search/bench.ts` — per-stage benchmark harness.
- `packages/wasm-pipeline/src/search/turso.test.ts` — unit/integration tests.
- `packages/wasm-pipeline/src/search/spike.test.ts` — B-gate browser-wasm capability probe.

**Modified files:**
- `packages/wasm-pipeline/src/ner.ts` — batched inference, scenario EP, single `configureOrtEnv`.
- `packages/wasm-pipeline/src/embed.ts` — hoist import/session, threaded wasm.
- `packages/wasm-pipeline/src/ocr.ts` + `ingest.ts` — quality OFF, OCR gated, text-chunk fast-path.
- `packages/wasm-pipeline/src/ingest.ts` — PersistStage → `SearchStore.ingest` + `OPTIMIZE INDEX` once.
- `packages/wasm-pipeline/src/query.ts` — `SearchStore.query` (hybrid).
- `packages/wasm-pipeline/src/runtime.ts` — JS-side content-hash cache.
- `services/mcp-server/src/store.ts` — `MetadataStore` becomes thin wrapper over Turso.
- `services/mcp-server/src/mirror.ts` — accept versioned Turso DB payload (`schemaVersion`).
- `services/mcp-server/src/index.ts` — `/api/rag/mirror` contract change.

**Deleted (Task 8, after gate green):** `packages/wasm-pipeline/src/rag.ts`, EdgeVec dep, localStorage persistence, `better-sqlite3`.

---

## Task 0: B-Gate Spike — verify Turso wasm feature set in browser

**Files:**
- Create: `packages/wasm-pipeline/src/search/spike.test.ts`

This is the **hard precondition** (spec Section 5). No cutover until green.

- [ ] **Step 1: Write the spike test that asserts each required capability**
```ts
import { connect } from "@tursodatabase/database";

describe("B-gate: turso wasm capabilities", () => {
  it("creates vector index + vector_top_k", async () => {
    const db = await connect(":memory:", { experimental: ["index_method"] });
    await db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, e F32_BLOB(4))");
    await db.exec("CREATE INDEX ti ON t(libsql_vector_idx(e,'metric=cosine'))");
    await db.exec("INSERT INTO t VALUES (1, vector32('[1,0,0,0]'))");
    const rows = await db.select(
      "SELECT id FROM vector_top_k('ti', vector32('[1,0,0,0]'), 1) vt JOIN t ON t.id=vt.id");
    expect((rows as any[]).length).toBe(1);
    await db.close();
  });

  it("creates FTS index + fts_score", async () => {
    const db = await connect(":memory:", { experimental: ["index_method"] });
    await db.exec("CREATE TABLE d(id INTEGER PRIMARY KEY, text TEXT)");
    await db.exec("CREATE INDEX di ON d USING fts (text)");
    await db.exec("INSERT INTO d VALUES (1, 'client Acme Corp clause 9')");
    const rows = await db.select(
      "SELECT id, fts_score(text,?) AS s FROM di WHERE fts_match(text,?)", ["Acme", "Acme"]);
    expect((rows as any[]).length).toBe(1);
    await db.close();
  });
});
```

- [ ] **Step 2: Run the spike in the browser/wasm test environment**
Run: `cd packages/wasm-pipeline && pnpm vitest run src/search/spike.test.ts`
Expected: Both tests PASS in the wasm/OPFS build. If they FAIL, **stop** — document the missing feature and fall back to Node-big-bang + browser-EdgeVec (spec escape hatch). Do NOT proceed to Tasks 1–8.

- [ ] **Step 3: Record bundle-size measurement**
Run the wasm build and measure total size of `@tursodatabase/database` + Tantivy + vector.
Expected: < 50MB (jsDelivr limit, spec EX-7). If over, investigate tree-shaking or defer FTS in wasm.

- [ ] **Step 4: Commit the spike (as a non-cutover probe, old code untouched)**
```bash
git add packages/wasm-pipeline/src/search/spike.test.ts
git commit -m "test(spike): verify turso vector+fts capabilities in browser wasm (B-gate)"
```

---

## Task 1: SearchStore interface + schema

**Files:**
- Create: `packages/wasm-pipeline/src/search/store.ts`
- Create: `packages/wasm-pipeline/src/search/schema.ts`
- Create: `packages/wasm-pipeline/src/search/turso.test.ts` (schema portion)

- [ ] **Step 1: Write `schema.ts` (verified against Task 0)**
```ts
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  id         INTEGER PRIMARY KEY,
  matter_id  TEXT NOT NULL,
  doc_id     TEXT,
  page       INT,
  citation   TEXT,
  text       TEXT,
  embedding  F32_BLOB(768)
);
CREATE INDEX IF NOT EXISTS chunks_vec ON chunks (libsql_vector_idx(embedding, 'metric=cosine')) WHERE matter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chunks_fts ON chunks USING fts (text) WITH (weights='text=1.0');
`;
// NOTE: metadata tables (matters, folders, consent, ingests, redactions, audit_log)
// from services/mcp-server/src/store.ts are added in Task 6.
```

- [ ] **Step 2: Write the `SearchStore` interface**

NOTE: `IndexedChunk` is defined locally in `packages/wasm-pipeline/src/rag.ts:6` (fields: `docId`, `chunkIndex`, `text`, `page?`, `citation?`, `vector: Float32Array`). It is NOT in `@xberg-io/core`. `RetrievedChunk` IS exported by `@xberg-io/core`. Move `IndexedChunk` into `store.ts` and have `rag.ts`/`ingest.ts` import it from there. (Task 9 deletes `rag.ts`, so do NOT leave a re-export behind — update `ingest.ts` import path to `./search/store` in Task 7 when wiring.) Keep field names exactly as the local interface.
```ts
import type { RetrievedChunk } from "@xberg-io/core";

export interface IndexedChunk {
  docId: string;
  chunkIndex: number;
  text: string;
  page?: number;
  citation?: string;
  vector: Float32Array;
}

export interface QueryArgs {
  vector: Float32Array;
  keyword: string;
  topK: number;
}

export interface SearchStore {
  open(matterId: string): Promise<void>;
  ingest(items: IndexedChunk[]): Promise<void>;
  query(matterId: string, args: QueryArgs): Promise<RetrievedChunk[]>;
  forget(matterId: string): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 3: Write failing test for interface shape**
```ts
import { SCHEMA } from "./schema";
it("schema defines chunks + 2 indexes", () => {
  expect(SCHEMA).toContain("F32_BLOB(768)");
  expect(SCHEMA).toContain("libsql_vector_idx");
  expect(SCHEMA).toContain("USING fts");
});
```

- [ ] **Step 4: Run test**
Run: `cd packages/wasm-pipeline && pnpm vitest run src/search/turso.test.ts`
Expected: PASS (schema is a string check; interface is type-only).

- [ ] **Step 5: Commit**
```bash
git add packages/wasm-pipeline/src/search/store.ts packages/wasm-pipeline/src/search/schema.ts packages/wasm-pipeline/src/search/turso.test.ts
git commit -m "feat(search): add SearchStore interface + shared Turso schema"
```

---

## Task 2: Turso implementation (browser wasm + Node) with capability probe

**Files:**
- Create: `packages/wasm-pipeline/src/search/turso.ts`
- Modify: `packages/wasm-pipeline/src/search/turso.test.ts`

- [ ] **Step 1: Write the failing test (ingest + hybrid query on a memory DB)**
```ts
import { TursoSearchStore } from "./turso";
it("ingest then hybrid query returns fused top-K", async () => {
  const s = new TursoSearchStore();
  await s.open("m1");
  await s.ingest([
    { docId: "m1", chunkIndex: 0, text: "Acme Corp signed clause 9", page: 1, citation: "m1#c0", vector: new Float32Array(Array(768).fill(0.1)) },
    { docId: "m1", chunkIndex: 1, text: "unrelated cooking recipe", page: 2, citation: "m1#c1", vector: new Float32Array(Array(768).fill(-0.1)) },
  ]);
  const r = await s.query("m1", { vector: new Float32Array(Array(768).fill(0.1)), keyword: "Acme", topK: 2 });
  expect(r.length).toBeGreaterThan(0);
  expect(r[0].text).toContain("Acme");
  await s.close();
});
```

- [ ] **Step 2: Run to verify fail**
Run: `pnpm vitest run src/search/turso.test.ts` → FAIL (`TursoSearchStore` not defined).

- [ ] **Step 3: Implement `turso.ts`**
Key points from spec: `connect(path, { experimental: ["index_method"], encryption? })`; vector param as BLOB bytes wrapped in `vector32(?)`; parallel vector + FTS legs; RRF fuse (k=60); capability probe on `open`.
```ts
import { connect, type Database } from "@tursodatabase/database";
import { SCHEMA } from "./schema";
import { rrfFuse } from "./hybrid";
import type { RetrievedChunk } from "@xberg-io/core";
import type { IndexedChunk, QueryArgs, SearchStore } from "./store";

function vecBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export class TursoSearchStore implements SearchStore {
  private db!: Database;
  private matterId = "";
  private caps = { vectorIndex: true, fts: true };

  async open(matterId: string): Promise<void> {
    this.matterId = matterId;
    this.db = await connect(":memory:", { experimental: ["index_method"] });
    await this.db.exec(SCHEMA);
    this.caps = await this.probe();
  }

  private async probe(): Promise<{ vectorIndex: boolean; fts: boolean }> {
    const caps = { vectorIndex: true, fts: true };
    try { await this.db.exec("CREATE TABLE _p(id INTEGER PRIMARY KEY, e F32_BLOB(4)); CREATE INDEX _pi ON _p(libsql_vector_idx(e,'metric=cosine'))"); }
    catch { caps.vectorIndex = false; }
    try { await this.db.exec("CREATE TABLE _f(id INTEGER PRIMARY KEY, t TEXT); CREATE INDEX _fi ON _f USING fts(t)"); }
    catch { caps.fts = false; }
    await this.db.exec("DROP TABLE IF EXISTS _p; DROP TABLE IF EXISTS _f;");
    return caps;
  }

  async ingest(items: IndexedChunk[]): Promise<void> {
    const tx = this.db.transaction((rows: IndexedChunk[]) => {
      const ins = this.db.prepare(
        "INSERT INTO chunks (matter_id, doc_id, page, citation, text, embedding) VALUES (?,?,?,?,?, vector32(?))");
      for (const it of rows) ins.run(this.matterId, it.docId, it.page ?? null, it.citation ?? null, it.text, vecBlob(it.vector));
    });
    tx(items);
    // FTS (Tantivy) is only visible after COMMIT; the transaction must finish before
    // OPTIMIZE INDEX and before any query. `tx(items)` commits on return in @tursodatabase/database.
    await this.db.exec("OPTIMIZE INDEX chunks_fts"); // once per ingest (Task 5 refines cadence)
  }

  async query(matterId: string, args: QueryArgs): Promise<RetrievedChunk[]> {
    const legs: Promise<any[]>[] = [];
    if (this.caps.vectorIndex) {
      legs.push(this.db.select(
        "SELECT c.text, c.doc_id docId, c.page, c.citation, distance FROM vector_top_k('chunks_vec', vector32(?), ?) vt JOIN chunks c ON c.id=vt.id WHERE c.matter_id=?",
        [vecBlob(args.vector), args.topK * 2, matterId]));
    }
    if (this.caps.fts) {
      legs.push(this.db.select(
        "SELECT c.text, c.doc_id docId, c.page, c.citation, fts_score(c.text,?) AS score FROM chunks_fts f JOIN chunks c ON c.id=f.id WHERE fts_match(c.text,?) AND c.matter_id=? ORDER BY score DESC LIMIT ?",
        [args.keyword, args.keyword, matterId, args.topK * 2]));
    }
    const [v, f] = await Promise.all(legs);
    return rrfFuse(v ?? [], f ?? [], args.topK, this.matterId) as RetrievedChunk[];
  }

  async forget(matterId: string): Promise<void> {
    await this.db.run("DELETE FROM chunks WHERE matter_id=?", [matterId]);
  }
  async close(): Promise<void> { await this.db.close(); }
}
```

- [ ] **Step 4: Run test**
Run: `pnpm vitest run src/search/turso.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/wasm-pipeline/src/search/turso.ts packages/wasm-pipeline/src/search/turso.test.ts
git commit -m "feat(search): Turso-backed SearchStore with vector+fts hybrid + capability probe"
```

---

## Task 3: RRF fusion

**Files:**
- Create: `packages/wasm-pipeline/src/search/hybrid.ts`
- Create/Modify: `packages/wasm-pipeline/src/search/turso.test.ts`

- [ ] **Step 1: Write failing test**
```ts
import { rrfFuse } from "./hybrid";
it("RRF ranks a chunk present in both legs higher", () => {
  const v = [{ text: "A", docId: "m", page: 1, citation: "c0", distance: 0.1 }];
  const f = [{ text: "A", docId: "m", page: 1, citation: "c0", score: 5 }];
  const out = rrfFuse(v, f, 2, "m");
  expect(out[0].text).toBe("A");
});
```

- [ ] **Step 2: Implement**
```ts
const K = 60;
export function rrfFuse(vectorRows: any[], ftsRows: any[], topK: number, matterId: string): any[] {
  const scores = new Map<string, { row: any; score: number }>();
  const bump = (rows: any[], key: (r: any) => string) => {
    rows.forEach((r, i) => {
      const k = key(r);
      const cur = scores.get(k) ?? { row: r, score: 0 };
      cur.score += 1 / (K + i + 1);
      scores.set(k, cur);
    });
  };
  bump(vectorRows, (r) => r.citation ?? r.text);
  bump(ftsRows, (r) => r.citation ?? r.text);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => ({ ...s.row, matter_id: matterId }));
}
```

- [ ] **Step 3: Run test → PASS. Commit.**
```bash
git add packages/wasm-pipeline/src/search/hybrid.ts packages/wasm-pipeline/src/search/turso.test.ts
git commit -m "feat(search): RRF fusion for vector+fts hybrid"
```

---

## Task 4: NER batching + scenario EP (spec Section 3, BN-1)

**Files:**
- Modify: `packages/wasm-pipeline/src/ner.ts:81-141`

- [ ] **Step 1: Write failing test (batched inference called once for N texts)**
```ts
import { detectPiiBatched } from "./ner";
it("batches N texts into one inference call", async () => {
  const out = await detectPiiBatched(["John Doe lives in Paris", "Acme Corp HQ"], ["person","organization"], scenario);
  expect(out.length).toBe(2);
});
```

- [ ] **Step 2: Refactor `getModel` + add `detectPiiBatched`**
- KEEP `executionProvider: "wasm"` for now. The existing code (ner.ts:82-104) deliberately hard-codes `"wasm"` because GLiNER has **no EP fallback chain** and WebGPU can fail at execution time with nothing to fall back to. Do NOT blindly switch to `scenario.executionProviders[0]`. Instead, ADD a spike-measured opt-in: only use `"webgpu"` if the B-gate spike (Task 0) additionally confirms GLiNER runs inference successfully on WebGPU for this model; otherwise stay `"wasm"`. If the spike shows WebGPU works, flip the default and document the evidence. This preserves the NER stability guarantee.
- Call `configureOrtEnv()` only inside `getModel` (remove the per-call call at ner.ts:128).
- Add:
```ts
export async function detectPiiBatched(
  texts: string[],
  types: readonly string[] = PII_TYPES,
  scenario: ModelScenario = DEFAULT_SCENARIO,
): Promise<PiiEntity[][]> {
  const model = await getModel(scenario);
  const result = await model.inference({ texts, entities: [...types], flatNer: true, threshold: 0.5 });
  return result.map((ents) => ents.map((e) => ({ kind: e.label, start: e.start, end: e.end, text: e.spanText })));
}
```
- Skip texts <20 chars before batching; re-align indices after.

- [ ] **Step 3: Run test → PASS. Commit.**
```bash
git add packages/wasm-pipeline/src/ner.ts packages/wasm-pipeline/src/ner.test.ts
git commit -m "perf(ner): batch GLiNER inference, honor WebGPU EP, single env config"
```

---

## Task 5: Embed threading + cached import (spec Section 3, BN-2)

**Files:**
- Modify: `packages/wasm-pipeline/src/embed.ts:47-78,130`

- [ ] **Step 1: Write failing test asserting session reused across chunks**
```ts
import { embedChunks } from "./embed";
it("reuses one session across chunks", async () => {
  const v = await embedChunks([{text:"a"},{text:"b"}], scenario);
  expect(v.length).toBe(2);
});
```

- [ ] **Step 2: Hoist import + threaded wasm**
- At module scope: `let ortModPromise: Promise<any> | null = null;` resolved once.
- In `getSession`: set `ort.env.wasm.numThreads = scenario.numThreads; ort.env.wasm.wasmPaths = ONNXRUNTIME_WEB_WASM_PATHS;` before `InferenceSession.create` (keep `graphOptimizationLevel: "all"`).
- Remove the `await import("onnxruntime-web")` inside `embedOne` (embed.ts:130); use the hoisted module.

- [ ] **Step 3: Run test → PASS. Commit.**
```bash
git add packages/wasm-pipeline/src/embed.ts packages/wasm-pipeline/src/embed.test.ts
git commit -m "perf(embed): cache ort import+session, enable multithreaded wasm"
```

---

## Task 6: Extraction config tuning (spec Section 3, EX-1/2/5)

**Files:**
- Modify: `packages/wasm-pipeline/src/ocr.ts`, `ingest.ts:44-51`, `runtime.ts`

- [ ] **Step 1: Write failing test (quality disabled by default, OCR gated)**
```ts
import { defaultExtractionConfig } from "./ocr";
it("extraction config disables quality processing", async () => {
  const cfg = await defaultExtractionConfig();
  expect(cfg.enable_quality_processing()).toBe(false);
});
```

- [ ] **Step 2: Apply tuning**
- `ocr.ts:17-19`: after `new WasmExtractionConfig()`, call `cfg.set_enable_quality_processing(false)`.
- `ocr.ts`: make OCR conditional — add `withTesseractOcr` only when `options.forceOcr` or first extract yields empty `doc.content`. Keep signature backward-compatible (default off).
- `ingest.ts:50`: `chunkerType` from `scenario` — `markdown` normally, `text` when `lowRam || isMobile`.
- `runtime.ts`: add `Map<contentHash, WasmExtractionResult>` cache; key on `hash(bytes)`. (Alternative `cache_namespace` on Rust config evaluated but JS map is simpler here.)

- [ ] **Step 3: Run test → PASS. Commit.**
```bash
git add packages/wasm-pipeline/src/ocr.ts packages/wasm-pipeline/src/ingest.ts packages/wasm-pipeline/src/runtime.ts packages/wasm-pipeline/src/ocr.test.ts
git commit -m "perf(extract): quality off, OCR gated, text-chunk fast-path, JS content cache"
```

---

## Task 7: Wire ingest + query to SearchStore (spec Sections 1/4)

**Files:**
- Modify: `packages/wasm-pipeline/src/ingest.ts:88-104`, `query.ts`

- [ ] **Step 1: Write integration test (end-to-end on a fixture)**
```ts
import { ingestFolder } from "./ingest";
import { queryRag } from "./query";
it("ingest then query returns relevant chunk", async () => {
  const store = new TursoSearchStore();
  // inject store via options
  const res = await ingestFolder(matter, folder, file, { passphrase, scopeToken, store });
  expect(res.accepted).toBeGreaterThan(0);
  const hits = await queryRag(matter, "Acme Corp", 4, store);
  expect(hits.some(h => h.text.includes("Acme"))).toBe(true);
});
```

- [ ] **Step 2: Repoint**
- `ingest.ts`: `PersistStage` → `options.store.ingest(items)` then one `OPTIMIZE INDEX chunks_fts` at folder completion (not per batch). Remove `buildIndex`/`serializeIndex`/`localStorage` usage.
- `query.ts`: replace `retrieve(matter.id, vec, topK)` with `store.query(matter.id, { vector: vec, keyword: query, topK })`.

- [ ] **Step 3: Run test → PASS. Commit.**
```bash
git add packages/wasm-pipeline/src/ingest.ts packages/wasm-pipeline/src/query.ts packages/wasm-pipeline/src/ingest.test.ts
git commit -m "feat(pipeline): wire ingest+query to SearchStore hybrid"
```

---

## Task 8: Node MCP store + mirror contract (spec Sections 2/5)

**Files:**
- Modify: `services/mcp-server/src/store.ts`, `mirror.ts`, `index.ts:249-256`

**Only after Task 0 spike is green (big-bang gate).**

- [ ] **Step 1: Create `services/mcp-server/tests/store.test.ts` with failing test (MetadataStore over Turso, mirror reopens DB)**
```ts
import { MetadataStore } from "./store";
import { MirrorStore } from "./mirror";
it("mirror accepts versioned turso payload and reopens", async () => {
  const m = new MirrorStore(dir);
  await m.saveMirror("m1", { format: "turso", schemaVersion: 1, db: dbBytes });
  const status = m.status("m1");
  expect(status).toBeDefined();
});
```

- [ ] **Step 2: Implement**
- `store.ts`: `MetadataStore` wraps a `@tursodatabase/database` connection; run existing `SCHEMA` (matters/folders/consent/ingests/redactions/audit_log) + `search/schema.ts`. Preserve all method signatures used by `index.ts`.
- `mirror.ts`: `saveMirror` accepts `{ format, schemaVersion, db }`; `open` rejects `schemaVersion !== 1`.
- `index.ts:249`: read body as the versioned payload; pass to `mirror.saveMirror`.

- [ ] **Step 3: Run test → PASS. Commit.**
```bash
git add services/mcp-server/src/store.ts services/mcp-server/src/mirror.ts services/mcp-server/src/index.ts services/mcp-server/tests/store.test.ts
git commit -m "feat(mcp): MetadataStore + mirror over Turso, versioned payload"
```

---

## Task 9: Delete old stores (big-bang cutover, spec Section 5 step 5)

**Precondition:** Task 0 spike PASS + Tasks 1–8 merged + soak test (Task 10) PASS.

- [ ] **Step 1: Remove `rag.ts` and EdgeVec usage**
```bash
git rm packages/wasm-pipeline/src/rag.ts
```
- Remove `edgevec` from `packages/wasm-pipeline/package.json` deps.
- Delete localStorage persistence code paths (already replaced in Task 7).

- [ ] **Step 2: Remove `better-sqlite3` from mcp-server**
- Confirm `MetadataStore` no longer imports `better-sqlite3` (Task 8).
- Remove `better-sqlite3` dep from `services/mcp-server/package.json`.

- [ ] **Step 3: Run full wasm-pipeline + mcp-server test suites**
Run: `cd packages/wasm-pipeline && pnpm test` and `cd services/mcp-server && pnpm test`
Expected: PASS (no references to deleted modules).

- [ ] **Step 4: Commit cutover**
```bash
git add -A
git commit -m "refactor: cutover to Turso — remove EdgeVec+localStorage and better-sqlite3"
```

---

## Task 10: Benchmark harness + soak test (spec Section 5)

**Files:**
- Create: `packages/wasm-pipeline/src/search/bench.ts`
- Modify: `tools/benchmark-harness` (extend for TS stage timing)

- [ ] **Step 1: Write bench that times each stage on a fixed fixture**
```ts
export async function benchPipeline(file: File, opts: IngestOptions) {
  const t0 = performance.now();
  const doc = await extractDocument(file, cfg); const tExtract = performance.now() - t0;
  const t1 = performance.now();
  const v = await embedChunks(chunks); const tEmbed = performance.now() - t1;
  const t2 = performance.now();
  const pii = await detectPiiBatched(texts, types, scenario); const tNer = performance.now() - t2;
  const t3 = performance.now();
  await store.ingest(items); const tPersist = performance.now() - t3;
  const t4 = performance.now();
  await store.query(matter, { vector: q, keyword: "x", topK: 8 }); const tQuery = performance.now() - t4;
  return { tExtract, tEmbed, tNer, tPersist, tQuery };
}
```
Assert each against the budgets: Extract <800ms, Embed <400ms, NER <600ms (spike-measured), Persist <200ms, Query <100ms.

- [ ] **Step 2: Write soak test (reproduces old rebuild bug)**
Ingest N=20 folders (~50 chunks each), then query M=100 times; assert query p95 stays <100ms and does not degrade vs the first query (proves no per-query localStorage rebuild).

- [ ] **Step 3: Run harness + soak**
Run: `cd packages/wasm-pipeline && pnpm vitest run src/search/bench.ts`
Expected: all budgets met; soak shows flat query latency.

- [ ] **Step 4: Commit**
```bash
git add packages/wasm-pipeline/src/search/bench.ts tools/benchmark-harness
git commit -m "test(perf): add stage benchmark harness + soak test against latency budgets"
```

---

## Verification Summary

- **B-gate (Task 0)** is the hard gate — nothing past it ships without a green wasm spike.
- Each task is TDD: failing test → implement → pass → commit.
- Final acceptance: `pnpm test` (wasm-pipeline + mcp-server) PASS + bench budgets met + soak flat.
- Rollback if needed: `git revert` the Task 9 cutover commit (old code is gone only after that commit).
