# Document-Intelligence App for Lawyers — Plan 1: Scaffold & Node MCP Server (`services/mcp-server`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the lightweight **Node.js TypeScript** service `services/mcp-server` — the single local process that serves the browser UI, the model cache (pinned downloads from `the pinned model repos`), the light metadata store (matters/folders/consent), an AES-GCM key vault, and the MCP host wiring. Also ship `packages/core` shared TS types. This is the backbone every later plan depends on.

**Architecture (per SHARED ARCHITECTURE BRIEF — authoritative):** A fully-local, single-machine app for lawyers. No cloud, no engine API keys, no egress. ONE local service `services/mcp-server` (Node.js + `@modelcontextprotocol/sdk`) that:
- (a) serves built `apps/web` output + `@xberg-io/xberg-wasm` assets as static files at localhost,
- (b) hosts a tiny HTTP API: model serving (`/models/*`), metadata (`/matters`, `/folders`, `/consent`), and the EdgeVec mirror endpoint (`/rag/mirror`),
- (c) hosts an MCP server (`mcp-server mcp` stdio, or localhost HTTP/SSE) exposing lawyer tools (stubbed here, implemented in Plan 4),
- (d) owns the light store: matters/folders/consent metadata (SQLite via `better-sqlite3`) + an AES-GCM key vault (owner-only rehydration),
- (e) owns the model cache (SHA256-pinned downloads from `the pinned model repos`).

**CORE PRINCIPLE (NON-NEGOTIABLE):** The **browser** runs the full engine — extraction/OCR/chunking via `@xberg-io/xberg-wasm`, e5 embeddings via `onnxruntime-web`, GLiNER PII via `gliner` (GLiNER.js), RAG via `edgevec`, and in-house reversible redaction (pattern from `curtain-privacy`) — all on-device, persisted to IndexedDB/OPFS. The Node service is **thin**: it serves models, holds light metadata + a key vault, and mirrors the browser's edgevec index so MCP `rag_query` works even with the browser closed. The Node service runs **no engine** — no xberg crate, no ORT, no RAG of its own.

**Intro monorepo layout (relevant slice):**
```
<repo>/
├─ services/
│  └─ mcp-server/                # Node.js TS service (this plan)
│     ├─ package.json
│     ├─ tsconfig.json
│     └─ src/
│        ├─ index.ts             # CLI: serve | mcp
│        ├─ config.ts            # AppConfig (host, port, dataDir, modelCacheDir)
│        ├─ static.ts            # serve apps/web + wasm pkg
│        ├─ models.ts            # download + SHA256-pin + serve /models/*
│        ├─ store.ts             # matters/folders/consent metadata (better-sqlite3)
│        ├─ vault.ts             # AES-GCM key vault (curtain rehydration)
│        ├─ mirror.ts            # POST /rag/mirror (EdgeVec index file) + load
│        └─ mcp/                 # stub wiring here, Plan 4 fills tools
├─ apps/
│  └─ web/                       # Next.js 14.2.5 (Plan 3) — built output served by mcp-server
├─ packages/
│  ├─ core/                      # shared TS types (this plan)
│  ├─ wasm-pipeline/             # browser wrapper: @xberg-io/xberg-wasm + ORT-Web + gliner + edgevec (Plan 2)
│  └─ wasm-runtime/              # optional browser model loader + curtain glue (Plan 2)
└─ .github/workflows/            # CI: build wasm (wasm32) + package Node server (Plan 6)
```

---

## Verified surface we consume (do NOT guess)

- **xberg wasm binding:** `@xberg-io/xberg-wasm` (prebuilt wasm32) exports `extract` / `extract_batch` + Tesseract OCR (`ocr-wasm`) + citation-preserving chunking. It does **NOT** export embeddings or NER — xberg excludes ORT from wasm (`wasm-target = no-ort-target+excel-wasm+ocr-wasm`; `ort` undeclared for `wasm32`). So browser embeddings/PII use external browser-native runtimes with the **same pinned `xberg-io` models**.
- **Browser embeddings:** `onnxruntime-web` (npm, ~1.24.x) runs `multilingual-e5-base` ONNX (768d) with WebGPU + WASM-CPU fallback. Model served from the Node server's `/models/e5.onnx` (same `Xenova/multilingual-e5-base` ONNX the server pins).
- **Browser PII:** `gliner` (npm, Knowledgator **GLiNER.js**, MIT) runs `gliner-pii` ONNX in-browser via `onnxruntime-web`; `@lmoe/gliner-onnx` is the Node alternative. Model served from `/models/gliner-pii.onnx` (same `onnx-community/gliner_small-v2.1` ONNX the server pins).
- **Browser RAG:** `edgevec` (npm `edgevec` v0.9.0, MIT/Apache-2.0) — WASM-native HNSW + FlatIndex + sparse/BM25 + hybrid RRF + persistence to IndexedDB/OPFS. Dense e5 + sparse BM25 are RRF-fused by EdgeVec, so **no separate FTS lib** (FlexSearch/MiniSearch optional). The browser mirrors the serialized index to the Node server for offline MCP.
- **Browser redaction:** in-house reversible tokenization (span → `{{CATEGORY_n}}`) driven by GLiNER PII spans; pattern inspired by `curtain-privacy`. Originals mapped to tokens, the token→original map held in a local AES-GCM key vault (browser-owned; Node holds an encrypted copy for offline rehydration).
- **MCP:** `@modelcontextprotocol/sdk` (npm, TypeScript) — we build our own MCP server (NOT rmcp, NOT xberg-mcp). Five lawyer tools delegate to the mirrored EdgeVec index + light metadata (Plan 4).

**Pinned deps (`services/mcp-server/package.json`):**
```json
{
  "name": "@xberg-io/mcp-server",
  "version": "<pin to xberg version>",
  "type": "module",
  "bin": { "xberg-mcp": "./dist/index.js" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "better-sqlite3": "^11.x",
    "express": "^4.x",
    "@xberg-io/core": "workspace:*",
    "zod": "^3.23.8",
    "sha2": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "tsup": "^8.0.0",
    "vitest": "^2.0.5"
  }
}
```
WASM CI build (Plan 6) consumes the prebuilt `@xberg-io/xberg-wasm` npm package — no wasm compile in this service.

---

## File Structure (this plan)

```
services/mcp-server/
├─ package.json                  # deps above; bin xberg-mcp
├─ tsconfig.json                 # strict + noUncheckedIndexedAccess; extends root base
├─ tsup.config.ts                # build dist/index.js (ESM) for serve + mcp
└─ src/
   ├─ index.ts                   # CLI parse: serve | mcp; model-cache dir init
   ├─ config.ts                  # AppConfig (host, port, dataDir, modelCacheDir, jwtSecret)
   ├─ error.ts                   # AppError -> JSON response
   ├─ static.ts                  # serve apps/web build + @xberg-io/xberg-wasm pkg at / and /wasm
   ├─ models.ts                  # download + SHA256-pin + serve /models/e5.onnx, gliner-pii.onnx
   ├─ store.ts                   # matters/folders/consent SQLite (better-sqlite3)
   ├─ vault.ts                   # AES-GCM key vault (owner rehydration)
   ├─ mirror.ts                  # POST /rag/mirror (EdgeVec file) + load for queries
   └─ mcp/
      └─ mod.ts                  # MCP server stub (lawyer tools implemented in Plan 4)

packages/core/
├─ package.json                  # @app/core (types only, no runtime deps)
├─ tsconfig.json
└─ src/
   ├─ index.ts                   # public exports
   └─ types.ts                   # PiiReport, RetrievedChunk, Matter, Folder, AuthScopes, req/resp shapes
```

---

### Task 1: Node project + dependency wiring

**Files:** `services/mcp-server/package.json`, `services/mcp-server/tsconfig.json`, `services/mcp-server/tsup.config.ts`, `services/mcp-server/src/config.ts`, `services/mcp-server/src/error.ts`, `services/mcp-server/src/index.ts` (skeleton)

- [ ] **Step 1: Write `package.json`** with the deps above; `bin` → `xberg-mcp` → `./dist/index.js`; `scripts.build: tsup src/index.ts --format esm --dts`; `typecheck: tsc --noEmit`; `start: node dist/index.js serve`.
- [ ] **Step 2: Write `tsconfig.json`** — `strict: true`, `noUncheckedIndexedAccess: true`, `module: NodeNext`, `moduleResolution: NodeNext`, extends root base; `include: ["src"]`.
- [ ] **Step 3: Write `config.ts`** — `AppConfig { host: string, port: number, dataDir: string, modelCacheDir: string, jwtSecret: string }`. Resolve `dataDir` from `--data-dir` or `os.homedir()/.xberg`; model cache under `dataDir/models`.
- [ ] **Step 4: Write `error.ts`** — `AppError` class (Auth, NotFound, Scope, ConsentRequired, Store, Model) with a `toJSON()` (consistent shape; never leak internal paths — per xberg safety rules).
- [ ] **Step 5: Skeleton `index.ts`** parsing CLI (`serve` default, `mcp`) and printing resolved config. Confirm `pnpm --filter mcp-server build` compiles and `node dist/index.js serve --port 8787` starts.
- [ ] **Step 6: Commit** `chore(mcp-server): node project + config/error skeleton`.

---

### Task 2: CLI + startup (`index.ts`)

**Files:** `services/mcp-server/src/index.ts`

- [ ] **Step 1: Parse CLI with a light arg parser** (or `commander`) — subcommands:
  - default `serve`: start HTTP server + static serving on `:8787`.
  - `mcp`: run the MCP server over stdio (Plan 4 fills tools; stub `mcp/mod.ts` here).
  - flags: `--port` (default `8787`), `--host` (default `127.0.0.1`), `--data-dir` (override).
- [ ] **Step 2: Init model cache dir** (`config.modelCacheDir`) — create if missing; pinned `the pinned model repos` model downloads land here (SHA256-verified; see Task 6).
- [ ] **Step 3: Build `AppContext`** (init store + vault + mirror loader) and dispatch: `serve` → `express` app on `host:port`; `mcp` → `mcp/mod.ts run()` (stdio).
- [ ] **Step 4: Confirm `node dist/index.js serve --port 8787` starts and logs the bind address.**
- [ ] **Step 5: Commit** `feat(mcp-server): CLI serve/mcp + model cache init + startup`.

---

### Task 3: Static serving (UI + wasm)

**Files:** `services/mcp-server/src/static.ts`, `index.ts`

- [ ] **Step 1: Serve built `apps/web` output** (from `apps/web/.next` standalone or `apps/web/out` dir resolved via `config.dataDir` or an env path) at `/` using `express.static`.
- [ ] **Step 2: Serve the `@xberg-io/xberg-wasm` pkg** (npm-installed under `node_modules/@xberg-io/xberg-wasm` or copied to `public/wasm`) at `/wasm` so the browser can `import` it from a same-origin path.
- [ ] **Step 3: Confirm `mcp-server serve` opens `http://localhost:8787/`, serves `index.html`, and `/wasm/` lists the wasm pkg files.**
- [ ] **Step 4: Commit** `feat(mcp-server): static serving of web UI + @xberg-io/xberg-wasm`.

---

### Task 4: Model cache + serving (`/models/*`)

**Files:** `services/mcp-server/src/models.ts`

- [ ] **Step 1: Implement `ensureModel(name, url, sha256)`** — download from `the pinned model repos` (GitHub release or configured mirror) once, verify against the SHA256 pin; cache under `config.modelCacheDir`. Refuse to serve/load on mismatch.
- [ ] **Step 2: Serve `GET /models/e5.onnx`, `/models/gliner-pii.onnx`, `/models/e5.tokenizer.json`** from the cache. Browser never contacts Hugging Face → local-first + supply-chain integrity.
- [ ] **Step 3: Pin set** is config (`models/manifest.json`): `e5` → `Xenova/multilingual-e5-base` multilingual-e5-base ONNX; `gliner-pii` → `onnx-community/gliner_small-v2.1` gliner-pii ONNX. Mismatch → fail closed.
- [ ] **Step 4: Commit** `feat(mcp-server): SHA256-pinned model cache + /models/* serving`.

---

### Task 5: Light metadata store (matters/folders/consent)

**Files:** `services/mcp-server/src/store.ts`

- [ ] **Step 1: Init `better-sqlite3`** at `config.dataDir/meta.sqlite`. Schema:
  - `matters(id TEXT PK, name TEXT, created_at TEXT)`
  - `folders(id TEXT PK, matter_id TEXT REFERENCES matters, name TEXT, path TEXT NULL, created_at TEXT)`
  - `consent(id TEXT PK, subject TEXT, matter_id TEXT, scope TEXT, granted_at TEXT, expires_at TEXT NULL)`
- [ ] **Step 2: Typed CRUD** `getMatters`, `createMatter`, `getFolders(matterId)`, `createFolder`, `grantConsent`, `isConsentActive(subject, matterId, scope)`. Used by routes + MCP tools.
- [ ] **Step 3: `GET/POST /matters`, `GET/POST /folders`, `GET/POST /consent`** routes (matter/folder-scoped). Enforce `matter_id` ownership.
- [ ] **Step 4: Commit** `feat(mcp-server): matters/folders/consent metadata store + routes`.

---

### Task 6: AES-GCM key vault (owner rehydration)

**Files:** `services/mcp-server/src/vault.ts`

- [ ] **Step 1: Implement `KeyVault`** wrapping Node `crypto` (AES-256-GCM): `seal(plaintext) -> ciphertext`, `open(ciphertext) -> plaintext`. Master key derived from an OS keychain / passphrase (Argon2id) or a generated key stored encrypted at `config.dataDir/vault.key`.
- [ ] **Step 2: Browser mirrors its encrypted curtain vault blob to Node (via `/rag/mirror`); Node decrypts only for `rehydrate_chunk` when the browser is closed, owner-only, consent-gated.**
- [ ] **Step 3: `cargo`/Node round-trip test: encrypt → decrypt yields original; wrong key → throws.**
- [ ] **Step 4: Commit** `feat(mcp-server): AES-GCM key vault for curtain rehydration`.

---

### Task 7: EdgeVec mirror endpoint (`/rag/mirror`)

**Files:** `services/mcp-server/src/mirror.ts`

- [ ] **Step 1: `POST /rag/mirror`** — browser uploads the serialized EdgeVec index file (the "mirror") plus a redacted chunk metadata blob (tokenized text + vectors + citations + encrypted curtain vault). Stream to `config.dataDir/mirrors/<matterId>.bin`.
- [ ] **Step 2: Load the mirror into an in-process EdgeVec (Node build) so `rag_query` (Plan 4) runs hybrid retrieval over browser-computed e5 vectors even with the browser closed.**
- [ ] **Step 3: `GET /rag/mirror/:matterId/status`** reports last-sync time.
- [ ] **Step 4: Commit** `feat(mcp-server): EdgeVec mirror receive + load for offline rag_query`.

---

### Task 8: MCP host stub

**Files:** `services/mcp-server/src/mcp/mod.ts`

- [ ] **Step 1: Add `mcp/mod.ts run()`** using `@modelcontextprotocol/sdk` `Server`. Register a placeholder tool list; do NOT implement tool bodies (Plan 4 fills `rag_query`, `list_pii`, `rehydrate_chunk`, `ingest_folder`, `redact`).
- [ ] **Step 2: Wire `index.ts` `mcp` subcommand to `mcp/mod.ts run()` over stdio; also expose localhost HTTP/SSE variant behind a flag for the inspector.
- [ ] **Step 3: Confirm `node dist/index.js mcp` starts and the MCP handshake initializes (tools list may be sparse).**
- [ ] **Step 4: Commit** `feat(mcp-server): MCP host stub (tools in Plan 4)`.

---

### Task 9: `packages/core` shared TS types

**Files:** `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/types.ts`, `packages/core/src/index.ts`

- [ ] **Step 1: Write `package.json`** — name `@app/core`, `type: module`, no runtime deps (types only; optionally `zod`). `scripts.build: tsc --noEmit`.
- [ ] **Step 2: Write `tsconfig.json`** — extends root base (strict + `noUncheckedIndexedAccess`), `include: ["src"]`.
- [ ] **Step 3: Write `src/types.ts`** with the SHARED CONTRACTS:
  - `AuthScopes = "read" | "ingest" | "redact" | "admin"`
  - `Matter { id: string; name: string; created_at: string }`
  - `Folder { id: string; matter_id: string; name: string; path?: string }`
  - `PiiEntity { kind: string; start: number; end: number; text: string; ciphertext?: Uint8Array }`
  - `PiiReport = PiiEntity[]`
  - `RetrievedChunk { doc_id: string; chunk_index: number; text: string; page?: number; bbox?: {x:number;y:number;w:number;h:number}; score: number; citation: string }`
  - Request/response shapes: `EmbedRequest/Response`, `NerRequest/Response`, `RagMirrorRequest`, `RagQueryRequest/Response`, `AuthIssueRequest/Response`, `ConsentGrant/Check`.
- [ ] **Step 4: `src/index.ts`** re-exports `types`.
- [ ] **Step 5: Type-check with `tsc --noEmit` (`pnpm --filter @app/core build`); must pass clean.**
- [ ] **Step 6: Commit** `feat(core): shared TS contracts (AuthScopes, Matter, Folder, PiiReport, RetrievedChunk, API shapes)`.

---

## Plan 1 Definition of Done

- [ ] `pnpm --filter mcp-server build` succeeds; `pnpm --filter mcp-server test` green (store init, vault round-trip, mirror load).
- [ ] `mcp-server serve` binds `http://localhost:8787`, serves the web shell at `/` and the wasm pkg at `/wasm`.
- [ ] `GET /models/e5.onnx` and `/models/gliner-pii.onnx` serve the SHA256-pinned models; browser never hits Hugging Face.
- [ ] `GET/POST /matters`, `/folders`, `/consent` mounted and matter-scoped.
- [ ] `POST /rag/mirror` receives + loads an EdgeVec index for offline `rag_query`.
- [ ] `mcp-server mcp` starts the MCP host (stub tools; bodies in Plan 4).
- [ ] `packages/core` type-checks clean (`tsc --noEmit`) with the shared contracts.
- [ ] No engine logic in the Node service — it serves models, holds light metadata + vault, mirrors the browser index. The browser runs extract/OCR/chunk/embed/PII/RAG/redaction.

## Depends on

- **None** — this is the base plan. (Plans 2, 3, 4, 5, 6 build on top of it.)

## Verification

- `pnpm --filter mcp-server build` → compiles clean.
- `pnpm --filter mcp-server test` → store init, vault encrypt/decrypt round-trip, mirror load all green.
- `node dist/index.js serve` → opens localhost; `curl http://localhost:8787/` returns the web shell; `curl http://localhost:8787/models/e5.onnx` returns the pinned model bytes.
- `node dist/index.js mcp` → MCP handshake initializes (stub tools).
- `pnpm --filter @app/core build` (`tsc --noEmit`) → types clean.

## Risks / Non-goals

- **Do NOT run an engine in Node** — no xberg crate, no ORT, no RAG of its own. The Node service is a thin model-server + metadata + mirror + MCP host. The browser owns the engine (extract/OCR/chunk/embed/PII/RAG/redaction via `@xberg-io/xberg-wasm` + ORT-Web + GLiNER.js + EdgeVec + curtain).
- **Do NOT add Rust/cargo** to this service or to the end-user install. Ship Node + the prebuilt `@xberg-io/xberg-wasm` package.
- **Non-goal:** cloud deployment, multi-tenant SaaS, or any network egress of document content. Fully local, single machine.
- **Resolved:** npm package is `edgevec` (v0.9.0; `import init, { EdgeVec } from "edgevec"`). It natively provides dense + sparse (BM25) + hybrid RRF + persistence, so FlexSearch/MiniSearch are not required. Browser PII pkg is `gliner` (GLiNER.js); `@lmoe/gliner-onnx` is the Node alternative.
- **Risk:** Node server holds an encrypted copy of the curtain vault for offline rehydration — it must be AES-GCM and owner-only; loss of the key = no rehydration.
