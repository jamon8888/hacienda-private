---
title: "Document Intelligence App — Plan 2: packages/wasm-pipeline"
date: 2026-07-15
status: ready
depends_on: [2026-07-15-doc-intel-scaffold-core]
phase: 2
summary: >
  Browser-side `packages/wasm-pipeline` that consumes `@xberg-io/xberg-wasm` (extract + Tesseract
  OCR + chunk) AND runs the full on-device engine — e5 embeddings via `onnxruntime-web`, GLiNER
  PII via `GLiNER.js` / `gliner`, RAG via `edgevec`, and in-house reversible redaction (pattern from
  `curtain-privacy`) — using the SAME SHA256-pinned `xberg-io` models the Node service serves. The
  entire privacy-sensitive pipeline (extract → OCR → chunk → embed → PII → RAG → redaction) runs
  on-device; only a mirrored EdgeVec index + light metadata POST to the Node service
  (`/rag/mirror`) for offline MCP. xberg excludes ORT from wasm (verified), so NER/embeddings use
  browser-native runtimes, not xberg; there is no native server.
---

## Plan 2 — packages/wasm-pipeline (browser-side engine: xberg-wasm + browser-native runtimes)

**Depends on:** Plan 1 (`2026-07-15-doc-intel-scaffold-core`) — provides the localhost API
contracts (`http://localhost:8787`), the `packages/core` shared TS types (`AuthScopes`,
`Matter`, `Folder`, `PiiEntity`, `RetrievedChunk`), the `@xberg-io/xberg-wasm` asset location, and a
**model-serving endpoint** (the Node service serves the pinned e5 ONNX + gliner-pii ONNX from its
local cache so the browser never hits Hugging Face directly). Plan 3 (`apps/web`) consumes this
package.

---

### Goal

Produce a framework-agnostic, ESM TypeScript library `packages/wasm-pipeline` that runs the
**entire privacy-sensitive pipeline on the user's device**:

1. **Extraction / OCR / chunking** via `@xberg-io/xberg-wasm` (xberg, prebuilt wasm32).
2. **Embeddings (e5, 768d)** via `onnxruntime-web` using the same `multilingual-e5-base` ONNX
   the Node service serves — so vectors stay in one space (browser index + Node mirror).
3. **PII / NER (GLiNER)** via `GLiNER.js` / `gliner` using the same `gliner-pii`
   ONNX the Node service serves — so PII tags are consistent.
4. **RAG** via `edgevec` (WASM HNSW + sparse/BM25 + hybrid RRF), persisted to IndexedDB/OPFS.
5. **Redaction** via `curtain-privacy` (reversible tokens, originals in a local AES-GCM vault).

It then mirrors the serialized EdgeVec index + light metadata to the Node service
(`POST /rag/mirror`) so `rag_query` works when the browser is closed.

> **Why external libs for NER/embeddings/RAG:** xberg's `wasm-target` excludes `ner-onnx` (GLiNER)
> and `embeddings` (e5) — both pull ONNX Runtime, which is **undeclared for `wasm32`**
> (`crates/xberg/Cargo.toml:398,237,232`; `ort` absent in the wasm32 dep block). So GLiNER/e5
> cannot run in xberg-wasm. We use browser-native ORT-Web + GLiNER.js with the **same pinned
> models**, keeping one vector space and consistent PII. There is **no native server** in this
> architecture — the Node service only mirrors the browser's index for offline MCP.

---

### Context

Compute model (verified against xberg source + upstream reality):

- **Browser (this package):** `@xberg-io/xberg-wasm` for `extract` / `extract_batch`, Tesseract OCR
  (`ocr-wasm`, compiled into the wasm binary), and xberg's citation-preserving chunking. Plus
  **browser ML**: e5 embeddings (`onnxruntime-web`, ONNX model served locally by the Node service),
  GLiNER PII (`GLiNER.js`/`gliner`, ONNX model served locally by the Node service),
  edgevec RAG (in-browser vector index), and in-house redaction (browser key vault).
- **Node service (`services/mcp-server`):** serves the UI + pinned models; holds light metadata
  (matters/folders/consent) + AES-GCM key vault; receives the **EdgeVec mirror** (`POST /rag/mirror`)
  and loads it so `rag_query` works offline. It runs **no engine** — no xberg, no ORT, no RAG.

Model pinning: the Node service downloads + SHA256-pins `Xenova/multilingual-e5-base`
(`multilingual-e5-base` ONNX) and `onnx-community/gliner_small-v2.1` (`gliner-pii` ONNX) at first run and
**serves them to the browser from its local cache** (`GET /models/e5.onnx`,
`GET /models/gliner-pii.onnx`). The browser never contacts Hugging Face → local-first + pinned.

Shared contracts this package must honor (from `packages/core`):

- `AuthScopes = "read" | "ingest" | "redact" | "admin"`
- `Matter { id, name }`, `Folder { id, matter_id, name }`
- `PiiEntity { kind, start, end, text, ciphertext? }` (ciphertext = browser AES-GCM vault output)
- `RetrievedChunk { doc_id, chunk_index, text, page?, bbox?, score, citation }`
- API base `http://localhost:8787`; MCP tools `rag_query`, `list_pii`, `rehydrate_chunk`,
  `ingest_folder`, `redact`.

> All code is TypeScript, ESM, `strict` + `noUncheckedIndexedAccess`, no `any`, no non-null
> assertions, `import type` for types. Build with `tsup` emitting ESM.

---

### Approach / Tasks (concrete files under `packages/wasm-pipeline/`)

#### Task 1 — Scaffold `packages/wasm-pipeline/package.json`

- [ ] **Step 1:** Write `package.json` (ESM, pinned deps).

```json
{
  "name": "@xberg-io/wasm-pipeline",
  "version": "<pin to xberg version>",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@xberg-io/xberg-wasm": "<pin to xberg version>",
    "@xberg-io/core": "workspace:*",
    "onnxruntime-web": "^1.24.2",
    "gliner": "^0.0.19",
    "edgevec": "^0.9.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2:** `tsconfig.json` extends the root base; `tsup.config.ts` externalizes
  `@xberg-io/xberg-wasm`, `@xberg-io/core`, `onnxruntime-web`, `gliner`, `edgevec` (host-provided /
  loaded from the Node service model cache).
- [ ] **Step 3:** `pnpm install` at repo root; commit scaffold.
  `git commit -m "feat(wasm-pipeline): scaffold xberg-wasm + ORT-Web + GLiNER.js wrapper"`

---

#### Task 2 — `src/index.ts`: load wasm + public `extractDocument`

- [ ] **Step 1:** Write `src/index.ts` — wasm init + top-level extract entry.

```ts
import type { ExtractionConfig } from "@xberg-io/core";

let wasmMod: typeof import("@xberg-io/xberg-wasm") | null = null;

export async function initWasm(): Promise<void> {
  wasmMod = await import("@xberg-io/xberg-wasm");
  await wasmMod.default();
}

export async function extractDocument(
  file: File,
  config: ExtractionConfig,
): Promise<ExtractionResult> {
  if (!wasmMod) await initWasm();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return wasmMod!.extract(bytes, config);
}
```

- [ ] **Step 2:** Re-export `extractBatch`, `ocr`, `chunk`, `embed`, `ner`, `ingest`, `query`.
- [ ] **Step 3:** Commit.

---

#### Task 3 — `src/ocr.ts`: Tesseract OCR (xberg-wasm, wasm-safe)

- [ ] **Step 1:** Write `src/ocr.ts`. In-browser OCR uses the Tesseract backend compiled into
  `xberg-wasm` (`ocr-wasm`). candle OCR (TrOCR/PaddleOCR-VL) is native-only and **out of scope for
  v1** — there is no native server in this architecture.

```ts
import type { ExtractionConfig } from "@xberg-io/core";

export type WasmOcrStrategy = "tesseract";

export function withTesseractOcr(
  base: ExtractionConfig,
  strategy: WasmOcrStrategy = "tesseract",
): ExtractionConfig {
  return { ...base, ocr: { enabled: true, backend: strategy } };
}
```

- [ ] **Step 2:** Note Tesseract language data ships inside the WASM binary (xberg-managed).
  For poor scans, the native server upgrades to candle PaddleOCR-VL (agent/quality path).
- [ ] **Step 3:** Commit.

---

#### Task 4 — `src/chunk.ts`: xberg chunking (citation-preserving)

- [ ] **Step 1:** Write `src/chunk.ts` — call xberg's chunker; each `Chunk` carries `page?`/`bbox?`.

```ts
import type { Chunk, ExtractionResult, ChunkingConfig } from "@xberg-io/core";

export function chunkExtraction(doc: ExtractionResult, cfg: ChunkingConfig): Chunk[] {
  return doc.chunk(doc.text, cfg);
}
```

- [ ] **Step 2:** Commit.

---

#### Task 5 — `src/embed.ts`: e5 embeddings via `onnxruntime-web`

- [ ] **Step 1:** Write `src/embed.ts`. Loads the **same** `multilingual-e5-base` ONNX the
  Node service serves (`/models/e5.onnx`, pinned). Returns 768d vectors compatible with the
  browser EdgeVec index + the Node mirror. WebGPU if available, WASM-CPU fallback.

```ts
import type { Chunk } from "@xberg-io/core";

const API_BASE = "http://localhost:8787";

export async function embedChunks(chunks: Chunk[]): Promise<number[][]> {
  const ort = await import("onnxruntime-web");
  const resp = await fetch(`${API_BASE}/models/e5.onnx`);
  const buf = await resp.arrayBuffer();
  const session = await ort.InferenceSession.create(buf, {
    executionProviders: ["webgpu", "wasm"],
  });
  // tokenize via xberg tokenizer config served at /models/e5.tokenizer.json
  // run session; mean-pool; L2-normalize → 768d vector per chunk
  return chunks.map((c) => embedOne(session, c.text)); // pseudo; implement pooling
}
```

- [ ] **Step 2:** Document that this is the **primary** embeddings path now. Vectors MUST match
  the Node mirror's e5 space (same model + same pooling/normalization as the Node-served ONNX).
- [ ] **Step 3:** Commit.

---

#### Task 6 — `src/ner.ts`: GLiNER PII via `gliner` (GLiNER.js)

- [ ] **Step 1:** Write `src/ner.ts`. Loads the **same** `gliner-pii` ONNX the Node service serves,
  served locally by the Node service (`/models/gliner-pii.onnx`, pinned). Returns `PiiEntity[]`.

```ts
import type { PiiEntity } from "@xberg-io/core";

const API_BASE = "http://localhost:8787";
const PII_TYPES = ["person", "organization", "location", "email", "phone", "date", "ssn", "financial"];

export async function detectPii(text: string): Promise<PiiEntity[]> {
  const { GLiNER } = await import("gliner");
  const model = new GLiNER({
    tokenizerPath: "onnx-community/gliner_small-v2",
    onnxSettings: { modelPath: `${API_BASE}/models/gliner-pii.onnx`, executionProviders: ["webgpu", "cpu"] },
  });
  await model.initialize();
  const ents = await model.inference({ texts: [text], entities: PII_TYPES });
  return ents.map((e) => ({ kind: e.label, start: e.start, end: e.end, text: e.text }));
}
```

- [ ] **Step 2:** Map GLiNER label set to the app's `PiiEntity.kind` vocabulary; note the
  server fills `ciphertext` (reversible token) after ingest.
- [ ] **Step 3:** Commit.

---

#### Task 7 — `src/rag.ts`: in-browser RAG via `edgevec`

- [ ] **Step 1:** Write `src/rag.ts` — build + persist an `edgevec` index (`import init, { EdgeVec } from "edgevec"`)
  from the browser-computed e5 vectors + chunk text + citations. `edgevec` provides dense HNSW + sparse/BM25 + hybrid
  RRF natively, so no separate FTS lib (FlexSearch/MiniSearch) is needed. Persist to
  IndexedDB/OPFS keyed by `matter_id`.

```ts
import init, { EdgeVec } from "edgevec";
import type { Chunk, RetrievedChunk } from "@xberg-io/core";

export async function buildIndex(matterId: string, chunks: Chunk[], vectors: number[][]): Promise<void> {
  const idx = await EdgeVec.create({ vectors, hybrid: true }); // HNSW + sparse + RRF
  // add chunks (text, page, bbox, citation) + vectors; persist to IndexedDB
  await idx.persist(`edgevec:${matterId}`);
}

export async function retrieve(matterId: string, queryVec: number[], topK: number): Promise<RetrievedChunk[]> {
  const idx = await EdgeVec.load(`edgevec:${matterId}`);
  return idx.search(queryVec, { topK, hybrid: true }); // returns doc_id, chunk_index, text, page?, bbox?, score, citation
}
```

- [ ] **Step 2:** Document that RAG now runs **entirely in the browser** (no `xberg::chunking::rag` — the
  internal ORT-dependent RAG module — and no server retrieval). Vectors are e5-compatible so the Node mirror
  stays in the same space.
- [ ] **Step 3:** Commit.

---

#### Task 7b — `src/redact.ts`: in-browser reversible redaction (in-house, pattern from `curtain-privacy`)

- [ ] **Step 1:** Write `src/redact.ts` — apply in-house reversible tokenization (span → `{{CATEGORY_n}}`) to PII
  spans; encrypt originals into the browser AES-GCM key vault (WebCrypto). Redacted text holds
  tokens only.

```ts
export async function redactDocument(text: string, pii: PiiEntity[]): Promise<{ redacted: string; cipher: Uint8Array }> {
  const mapping = tokenizePii(text, pii);                            // span → {{CATEGORY_n}}
  const redacted = applyTokens(text, mapping);
  const cipher = await vault.seal(JSON.stringify(mapping));         // AES-GCM
  return { redacted, cipher };
}
```

- [ ] **Step 2:** Originals survive only as vault ciphertext (browser + mirrored-to-Node); a leaked
  redacted doc reveals nothing. `rehydrate` reverses via `vault.open`.
- [ ] **Step 3:** Commit.

---

#### Task 8 — `src/mirror.ts`: persist index locally + mirror to Node

- [ ] **Step 1:** Write `src/mirror.ts` — after building the EdgeVec index, serialize it and POST to
  the Node service `POST /rag/mirror` (matter-scoped) so `rag_query` works when the browser is closed.
  Also push light metadata (matter/folder/consent) and the encrypted curtain vault.

```ts
export async function pushMirror(matter: Matter, indexBlob: Blob, cipher: Uint8Array, scopeToken: string): Promise<void> {
  const fd = new FormData();
  fd.append("matter_id", matter.id);
  fd.append("index", indexBlob);
  fd.append("curtain_vault", new Blob([cipher]));
  const res = await fetch(`${API_BASE}/rag/mirror`, {
    method: "POST", headers: { authorization: `Bearer ${scopeToken}` }, body: fd,
  });
  if (!res.ok) throw new Error(`mirror failed: ${res.status}`);
}
```

- [ ] **Step 2:** The browser remains the source of truth; the mirror is a read-only replica for
  offline MCP. Re-push on every ingest/redact change.
- [ ] **Step 3:** Commit.

---

#### Task 9 — `src/ingest.ts`: full on-device pipeline

- [ ] **Step 1:** Write `src/ingest.ts` — extract → OCR → chunk → embed (e5) → PII (GLiNER) →
  build EdgeVec index → redact (curtain) → push mirror. All on-device; only the mirror + light
  metadata leave the browser (to the localhost Node service).

```ts
const API_BASE = "http://localhost:8787";

export async function ingestFolder(
  matter: Matter, folder: Folder, file: File, scopeToken: string,
): Promise<{ accepted: number }> {
  const doc = await extractDocument(file, withTesseractOcr(defaultConfig()));
  const chunks = chunkExtraction(doc, defaultChunking());
  const vectors = await embedChunks(chunks);
  const pii = (await Promise.all(chunks.map((c) => detectPii(c.text)))).flat();
  await buildIndex(matter.id, chunks, vectors);            // in-browser EdgeVec
  const { cipher } = await redactDocument(doc.text, pii);  // in-browser curtain
  await pushMirror(matter, await serializeIndex(matter.id), cipher, scopeToken);
  return { accepted: chunks.length };
}
```

- [ ] **Step 2:** `scopeToken` scoped to `AuthScopes.ingest`. Raw document text never leaves the
  browser; only the mirrored (redacted/tokenized) index + light metadata reach the Node service.
- [ ] **Step 3:** Commit.

---

#### Task 10 — `src/query.ts`: query the local EdgeVec index (browser)

- [ ] **Step 1:** Write `src/query.ts` — embed the query with the browser's e5 (same model) and run
  hybrid retrieval over the local EdgeVec index. This is the primary path (browser open).

```ts
export async function queryRag(
  matter: Matter, query: string, scopeToken: string, topK = 8,
): Promise<RetrievedChunk[]> {
  const qVec = await embedOne(query);          // browser e5, same space as mirror
  return retrieve(matter.id, qVec, topK);       // local EdgeVec hybrid search
}
```

- [ ] **Step 2:** `RetrievedChunk` returns `doc_id`, `chunk_index`, `text`, `page?`, `bbox?`,
  `score`, `citation` from the local index. (The MCP server uses the Node mirror for the same query
  when the browser is closed — see Plan 4.)
- [ ] **Step 3:** Commit.

---

#### Task 11 — Public barrel + build + typecheck

- [ ] **Step 1:** `src/index.ts` re-exports `ocr`, `chunk`, `embed`, `ner`, `rag`, `redact`,
  `mirror`, `ingest`, `query`.
- [ ] **Step 2:** `pnpm --filter wasm-pipeline build` (tsup ESM + dts) must succeed.
- [ ] **Step 3:** `pnpm --filter wasm-pipeline typecheck` (`tsc --noEmit`) clean.
- [ ] **Step 4:** Commit.
  `git commit -m "feat(wasm-pipeline): full on-device extract+OCR+chunk+embed+PII+RAG+redaction"`

---

### Principle: xberg for extract/OCR/chunk; browser-native runtimes for the rest

- **Extraction / OCR / chunking** → `@xberg-io/xberg-wasm` (xberg, prebuilt, consumed as-is).
- **Embeddings (e5, 768d)** → `onnxruntime-web` with the **same pinned `multilingual-e5-base`
  ONNX** the Node service serves. xberg cannot ship this in wasm (ORT excluded); we use the browser
  runtime instead, keeping vector-space compatibility.
- **PII / NER (GLiNER)** → `GLiNER.js` / `gliner` with the **same pinned `gliner-pii`
  ONNX** the Node service serves. Same reasoning.
- **RAG retrieval** → `edgevec` (WASM HNSW + sparse/BM25 + hybrid RRF) in the browser, persisted to IndexedDB/OPFS;
  mirrored to the Node service (`/rag/mirror`) for offline MCP. No `xberg::chunking::rag`, no server retrieval.
- **Redaction** → in-house reversible tokens (pattern from `curtain-privacy`) in the browser; originals encrypted into a local AES-GCM vault.
- **MCP** → the Node service (`@modelcontextprotocol/sdk`) delegates to the mirror; it runs no engine.
- Models are served from the Node service's local cache (`/models/*`), SHA256-pinned, never from HF
  at runtime → local-first + supply-chain integrity preserved.

---

### Depends on

- **Plan 1** (`2026-07-15-doc-intel-scaffold-core`): localhost API contracts
  (`POST /rag/mirror` accepts the EdgeVec index file + encrypted curtain vault, `/models/e5.onnx`,
  `/models/gliner-pii.onnx`, `/matters`, `/folders`, `/consent`), `packages/core` types,
  `@xberg-io/xberg-wasm` asset, and the pinned model cache that serves ONNX to the browser.
- **Plan 3** (`apps/web`) consumes this package as its browser engine.

---

### Verification

- [ ] `pnpm --filter wasm-pipeline build` — emits `dist/index.js` + `dist/index.d.ts`.
- [ ] `pnpm --filter wasm-pipeline typecheck` — `tsc --noEmit` clean under `strict` +
  `noUncheckedIndexedAccess`.
- [ ] Browser smoke test: load a scanned PDF → `extractDocument` returns Tesseract OCR text;
  `embedChunks` returns 768d e5 vectors; `detectPii` returns GLiNER PII spans; `buildIndex`
  persists an EdgeVec index; `queryRag` returns `RetrievedChunk[]` with `citation` from the
  local index.
- [ ] `pushMirror` POSTs the serialized EdgeVec index to `http://localhost:8787/rag/mirror`;
  the Node service loads it so `rag_query` works with the browser closed.
- [ ] Confirm the browser loads e5/gliner-pii ONNX from the Node service `/models/*` (no HF egress);
  models are SHA256-pinned in the server cache.

---

### Risks / Non-goals

- **xberg has no wasm ORT** (verified): GLiNER/e5 cannot run in `@xberg-io/xberg-wasm`. We use
  `onnxruntime-web` + `GLiNER.js` — browser-native, not xberg. This is the explicitly chosen
  trade-off (per architecture decision 2026-07-15).
- **Model download size in browser:** e5 ONNX (~hundreds of MB fp32; use int8/quantized ONNX to
  shrink) + gliner-pii ONNX (~197–330MB). Served from the local Node cache, downloaded once,
  cached in browser IndexedDB. WebGPU optional; WASM-CPU fallback slower.
- **Vector-space compatibility:** the browser MUST use the identical e5 model + pooling +
  normalization as the Node-served ONNX, or the mirror-based `rag_query` degrades. Pin the same
  ONNX artifact on both sides.
- **PII tag consistency:** browser GLiNER labels map to `PiiEntity.kind`; the encrypted curtain
  vault (not plaintext) is mirrored to Node for offline rehydration.
- **In-browser vector store IS in scope** (`edgevec`) — retrieval runs on-device; the Node mirror is
  only a read-only replica for offline MCP. Verify the `EdgeVec` npm package name/API before build.
- **Users never run cargo.** `@xberg-io/xberg-wasm` is a prebuilt npm package; ORT-Web/`gliner`/`edgevec`
  are npm deps.
