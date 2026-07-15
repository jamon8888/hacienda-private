# Design Spec: Hybrid Document-Intelligence App (WASM + MCP)

- **Date:** 2026-07-15
- **Status:** Approved for implementation planning
- **Author:** opencode brainstorming session
- **Repo:** xberg (Rust core + multi-language bindings); this app is a new pnpm monorepo built on top of it.

## 1. Goal

A multi-user web app where a user uploads a **folder of documents** and gets a full, local-first pipeline:
**extract → OCR → NER/PII → chunk → embed → RAG**, with a chat/RAG interface over the extracted corpus and PII surfaced + optionally redacted.

The pipeline runs **client-side in the browser via WebAssembly** (documents never leave the device), while the server owns the **vector store + RAG query** and exposes an **MCP server** as an external-agent gateway.

## 2. Architecture (Hybrid)

```
┌───────────────────────────── Browser (per user) ─────────────────────────────┐
│  xberg-wasm (extract/format)  +  ORT-Web/transformers.js (OCR, NER, embed)      │
│  → chunk → embed (vectors stay in-browser)                                      │
│  Uploads ONLY: vectors + chunk display text + PII entity tags  ──┐              │
└────────────────────────────────────────────────────────────────┼─────────────┘
                                                                  ▼
┌───────────────────────────── Node VM (long-running) ─────────────────────────┐
│  apps/web  (Next.js: UI, auth, multi-user API routes)                          │
│        │ uses                                                                   │
│  packages/core  (types, API client, SQLite + sqlite-vec, auth)                 │
│        │ also used by                                                            │
│  services/mcp  (standalone MCP server — external agents: Claude/Codex/Cursor)   │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Trust boundary:** raw documents never leave the browser. Redaction (when invoked) happens client-side before upload. The server stores only vectors, chunk text, and PII tags.

## 3. Repo Structure (pnpm monorepo)

```
apps/web                 Next.js (App Router) — UI + API routes
services/mcp             Standalone MCP server (external-agent gateway)
packages/core            Shared: types, API client, DB/vector access, auth primitives
packages/wasm-pipeline   TS wrapper around xberg-wasm + ORT-Web/transformers.js (shared by web)
```

`apps/web` and `services/mcp` both depend on `@app/core`; `apps/web` depends on `@app/wasm-pipeline`. Mirrors xberg's existing `pnpm-workspace.yaml` layout.

## 4. Browser Pipeline (`packages/wasm-pipeline`)

Two distinct wasm subsystems:

1. **xberg-wasm** — deterministic extraction / format parsing (Rust → wasm-bindgen). Honors the repo's own `wasm-target` constraints (sync-only, 2 MB HTML cap, `SecurityLimits` for archives).
2. **ORT-Web / transformers.js** — the ML stages (OCR, NER/gliner, embeddings) as **quantized ONNX** models, run via the WebGPU execution provider.

### 4.1 Stages (chained, with progress events)
Folder drop (drag-drop + `<input webkitdirectory>`) → parallel per-file:
`xberg-wasm extract` → `OCR (wasm)` → `NER/PII (gliner wasm)` → `chunk` → `embed (wasm)`.

Output per document:
```ts
type ExtractedDoc = {
  docId: string;
  chunks: { index: number; text: string; vector: Float32Array; entities: Entity[] }[];
  piiReport: Entity[];            // persons, orgs, emails, ids, etc.
  redactedText?: string;          // derived client-side if redaction requested
};
type Entity = { type: string; start: number; end: number; text: string };
```

### 4.2 Startup & Model-Loading Strategy (performance-critical)
See Section 9. The runtime is built for fast first paint and download-once models.

## 5. Server / `packages/core`

- Next.js API routes call `@app/core` functions (no business logic in route handlers).
- **Storage:** SQLite + `sqlite-vec` vector extension. Tables:
  - `users(id, email, password_hash | oauth_sub, created_at)`
  - `documents(id, user_id, name, created_at, pii_summary_json)`
  - `chunks(id, doc_id, user_id, idx, text, entities_json, embedding BLOB)`
  - `pii_reports(id, doc_id, user_id, entities_json)`
- Every row scoped by `user_id` (multi-tenant isolation enforced in the data layer, not just the query).
- **Upload endpoint:** stores vectors (dimension-checked) + chunk text + entity tags.
- **RAG endpoint:** receives a query **vector** (client embeds the question with the same WASM model), runs ANN cosine search (`sqlite-vec`), returns top-k chunks with source doc references.

## 6. Auth & Multi-Tenancy

- Start with **email/password (bcrypt) + session JWT**; **OAuth (GitHub/Google)** as an add-on behind the same `users` schema (`oauth_sub`).
- Every DB read/write is user-scoped. MCP tokens map to a user and are treated identically.
- No cross-tenant reads anywhere in `@app/core`.

## 7. MCP Server (`services/mcp`)

- **Role:** external-agent gateway only. External agents (Claude Code, Codex, Cursor, etc.) connect with a **scoped user token**; the server exposes tools backed by `@app/core`.
- Tools:
  - `extract_document` — trigger/retrieve extraction for a doc/folder.
  - `ingest_folder` — register an uploaded corpus for an agent.
  - `rag_query` — semantic search over the user's corpus (server does ANN).
  - `list_pii` — return the PII report for a document.
  - `redact` — mark a document for redaction (applied client-side on next sync).
- Runs as its own Node process (PM2); authed per connecting agent. The Next.js app talks to `@app/core` **directly**, not through MCP.

## 8. Error Handling & Safety

- Per-file pipeline failures are caught; partial results are returned with structured error context (no panic — matches xberg's "preserve partial results" rule).
- Client validates MIME + size before extract; server re-validates vector dimensions and rejects oversized batches.
- PII is **never logged**. Redaction is non-destructive: the original is kept; a redacted copy is derived client-side.
- `SecurityLimits` (zip-bomb / depth / string-growth) applied on the client before extraction and on the server before any re-processing.

## 9. Performance & Startup Strategy (refined from 2025–2026 WASM research)

1. **Two wasm subsystems**, not one: xberg-wasm for deterministic parsing; ORT-Web for ML. Keep them independently code-split.
2. **Lazy, per-stage loading:** only the extract module loads at app start. OCR/NER/embedder workers spin up on demand and **pre-warm during idle** after the first folder drop. Initial JS/wasm payload stays tiny.
3. **Quantized ONNX (INT8/INT4):** embedder (all-MiniLM-L6-v2 q8 ≈10 MB vs 23 MB fp32), NER (gliner q8), OCR. Biggest download-size lever.
4. **Download-once model cache:** **OPFS** (primary, fastest sync access inside a worker) with **Cache Storage** fallback. First run downloads with a real progress bar; every later load is instant. Browsers also cache compiled wasm modules.
5. **Tiered execution-provider chain:** `WebGPU → WebGL → WASM-SIMD-threaded`, feature-detected at runtime. Sessions **warmed on idle**; use **GPU IO-binding + graph capture** to avoid CPU↔GPU copies.
6. **Worker offload:** all inference in a Web Worker (ORT proxy worker + threaded wasm worker) so the UI never blocks. Reuse typed arrays / buffers; keep tokenization in-worker.
7. **Server headers & transport:** emit `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (enables SharedArrayBuffer / multithreaded wasm), `Content-Type: application/wasm`, **Brotli** for `.wasm`/`.onnx`, and serve over **HTTPS** (WebGPU requires a secure context).
8. **Streaming compilation:** `WebAssembly.instantiateStreaming(fetch(...))` compiles while downloading.
9. **Model sharding + parallel range requests** for large models to parallelize download; show per-model progress.
10. **Expectation setting:** best performance on Chromium / Chrome-macOS (WebGPU). Safari & Firefox run via WebGL → WASM (functional, slower). **WebNN deferred** (Chrome origin trial only, no Safari/Firefox in 2026).

## 10. Testing

- `packages/wasm-pipeline`: unit each stage against sample docs (pdf/docx/image/scan); property tests for the chunker; model-cache hit/miss tests.
- `packages/core`: SQLite integration tests — vector recall quality, tenant isolation (no cross-user leakage), redaction non-destructiveness.
- `apps/web`: Playwright e2e — folder upload → chunks/PII visible → ask a RAG question → get grounded answer.
- `services/mcp`: agent-tool smoke tests against a seeded test user (auth scope enforced).

## 11. Build / Run / Deploy

- Dev: `pnpm dev` runs web + mcp concurrently.
- Build: `pnpm -r build`.
- Deploy: **Node server on a VM** (PM2/systemd), SQLite file on a mounted disk, wasm/model assets served statically from the same origin (so COOP/COEP + CORP work without cross-origin friction). HTTPS terminating at the VM or a reverse proxy.
- Reverse proxy must forward the COOP/COEP/Brotli/`application/wasm` headers and TLS.

## 12. Milestones (phasing)

1. **Scaffold** monorepo + `@app/core` types + SQLite schema + auth.
2. **Pipeline MVP:** xberg-wasm extract + chunk + client embed (WebGPU) + upload to core; RAG query working end-to-end (single user).
3. **OCR + NER/PII** stages + UI highlighting + optional redaction.
4. **Multi-user + auth** + tenant isolation + tests.
5. **Startup hardening:** lazy load, OPFS cache, EP chain, worker offload, COOP/COEP + Brotli + HTTPS, pre-warm.
6. **MCP gateway** + tools + agent auth.
7. **E2E + perf pass** (Lighthouse/WebPerf, recall benchmarks).

## 13. Risks / Open Questions

- WebGPU absence on Safari/Firefox → WebGL/WASM fallback is slower; document this in UI.
- ORT-Web WebGPU has a known macOS concurrent-multi-session crash (ort #27592) — avoid concurrent WebGPU sessions; serialize or pool.
- xberg-wasm-runtime JS layer is **not present in this checkout** (fork-local) — we build `packages/wasm-pipeline` from xberg-wasm + ORT-Web directly.
- `xberg-rag` crate is absent here; we implement the vector store in `@app/core` (SQLite + sqlite-vec) rather than depending on it.
- Model licensing/size for OCR and gliner must be confirmed before locking versions.
