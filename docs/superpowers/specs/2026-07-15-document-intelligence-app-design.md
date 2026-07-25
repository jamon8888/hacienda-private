# Design Spec: Local-First Lawyer Document-Intelligence App (Consumes Xberg)

- **Date:** 2026-07-15
- **Status:** Approved for implementation planning
- **Author:** opencode brainstorming session
- **Repo:** xberg (Rust core + bindings). This app is a **thin consumer** of the **unmodified** upstream `xberg` crate, packaged as a single native binary plus a Next.js browser UI.

> ## 0. Core Principle (authoritative)
>
> **Consume xberg, never reimplement.** xberg is consumed **only as `@xberg-io/xberg-wasm`**
> (the prebuilt wasm32 build) for extract (96 formats) + Tesseract OCR + chunk. Every other
> engine stage runs in the browser via browser-native runtimes (ORT-Web e5, GLiNER.js PII,
> EdgeVec RAG, curtain redaction) using the **same SHA256-pinned `xberg-io` models** the Node
> service serves. We do **not** use `xberg-candle-ocr`, `xberg-gliner`, `xberg::chunking::rag`, or
> `xberg-mcp` — those are excluded by this architecture (no native server). Our app is a
> **thin consumer + orchestration + auth/consent/matter-scoping + UI** + a thin Node mirror/MCP host.
>
> **Exception (browser runs the full engine):** xberg excludes ONNX Runtime from its wasm
> build (`wasm-target` omits `ner-onnx` + `embeddings`; `ort` is undeclared for `wasm32`),
> so GLiNER PII and e5 embeddings **cannot** run inside `@xberg-io/xberg-wasm`. For a fully on-device
> privacy pipeline, the **browser runs the entire engine** with **browser-native runtimes**, using
> the **same SHA256-pinned `xberg-io` models**: `@xberg-io/xberg-wasm` (extract + Tesseract OCR +
> chunk), `onnxruntime-web` (e5), `gliner` (GLiNER.js) (GLiNER PII), `edgevec`
> (in-browser RAG), and in-house reversible redaction (pattern from `curtain-privacy`). All of it persists to
> IndexedDB/OPFS. A thin **Node.js** service (`services/mcp-server`, `@modelcontextprotocol/sdk`)
> serves the UI + pinned models, holds light metadata (matters/folders/consent) + an AES-GCM key
> vault, and **mirrors** the browser's EdgeVec index so `rag_query` works even with the browser
> closed. The Node service runs **no engine** — no xberg crate, no ORT, no RAG of its own.

## 1. Goal / Product / Scope

A **fully-local** document-intelligence app for lawyers. The **browser runs the entire engine**
on the user's own device (extract → OCR → chunk → embed → PII → RAG → redaction), and a thin
**Node.js** service (`services/mcp-server`) serves the UI, the pinned models, light metadata,
and the MCP interface — with **no engine logic of its own**.

Use case: a lawyer installs the Node service (or a wrapped binary), opens the browser UI, points
it at a **folder of documents** belonging to a **matter**, and gets a local-first pipeline —
**extract → OCR → NER/PII → chunk → embed → RAG** — surfacing PII and supporting redaction. The
corpus never leaves the device. The lawyer interacts with it two ways:

1. **Browser UI** (Next.js, served by the Node service) that runs the **full engine on-device** via
   `@xberg-io/xberg-wasm` + `onnxruntime-web` (e5) + `GLiNER.js` (PII) + `EdgeVec` (RAG) + `curtain-privacy`
   (redaction). Only a mirrored EdgeVec index + light metadata are pushed to the Node service.
2. **Claude Desktop plugin**: the Node service's MCP server (`node dist/index.js mcp`) exposes MCP
   tools so Claude can answer legal questions over the corpus with **grounded, citation-bearing**
   retrieval, gated by consent + scopes + matter scope. When the browser is closed, `rag_query`
   runs over the mirrored EdgeVec index.

Scope stays: **folder-centric** (folders are the unit of organization *and* processing),
**local-first** (no third-party upload, no egress of document content), and **PII/GDPR-aware**
(reversible curtain redaction, owner-only rehydration via a local AES-GCM key vault,
explicit revocable consent for raw-PII access). xberg is consumed **only as `@xberg-io/xberg-wasm`**.

## 2. Trust Boundary & Architecture Overview

```
┌───────────────────────── Lawyer's machine (localhost only) ────────────────────────┐
│                                                                                    │
│   Browser (apps/web, Next.js)  — runs the ENTIRE engine on-device                  │
│   ┌───────────────────────────────────────────────────────────────────────────┐    │
│   │ @xberg-io/xberg-wasm (extract+Tesseract OCR+chunk)                               │    │
│   │ + onnxruntime-web (e5 embed) + GLiNER.js (PII)                             │    │
│   │ + EdgeVec (RAG index, IndexedDB/OPFS) + curtain-privacy (redaction)        │    │
│   │   → full pipeline on-device; mirrors EdgeVec index + metadata to Node      │    │
│   └───────────────────────────────┬──────────────────────────────────────────┘    │
│                                   │  mirror (EdgeVec file) + light metadata        │
│                                   ▼                                                 │
│   ┌──────────── services/mcp-server (Node.js, localhost:8787) ─────────────────┐   │
│   │  • Hosts the Browser UI (static Next build) + @xberg-io/xberg-wasm assets         │   │
│   │  • Serves pinned models: GET /models/e5.onnx, /models/gliner-pii.onnx       │   │
│   │  • Light metadata: matters/folders/consent (SQLite) + AES-GCM key vault     │   │
│   │  • Receives POST /rag/mirror (EdgeVec index) → loads it for offline query   │   │
│   │  • MCP server (stdio `node dist/index.js mcp`) — Claude Desktop              │   │
│   │  • NO engine: no xberg crate, no ORT, no RAG of its own                     │   │
│   └───────────────────────────────┬──────────────────────────────────────────┘   │
│                                   │  stdio / localhost                             │
│                                   ▼                                                 │
│   Claude Desktop ──→ mcp-server mcp (tools gated by consent + scopes + matter)     │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Trust boundary:** Raw documents stay on the user's machine and are processed **entirely in the
browser**. The browser computes e5 embeddings and GLiNER PII on-device via browser-native runtimes
(`onnxruntime-web`, `GLiNER.js`) using the same pinned `xberg-io` models, builds the RAG index with
`EdgeVec`, and applies `curtain-privacy` redaction — all persisted to IndexedDB/OPFS. Only a
**mirrored EdgeVec index** (redacted/tokenized chunk text + e5 vectors + citations + an encrypted
curtain vault) and **light metadata** (matters/folders/consent) are pushed to the Node service. The
Node service serves models from its local cache (never Hugging Face) and answers `rag_query` from the
mirror when the browser is closed. **No document content egresses** the device.

## 3. Capability → Engine → Location Matrix

| Capability | xberg package | Runs where | Notes |
| --- | --- | --- | --- |
| Extract 96 formats | `xberg` (core) / `xberg-wasm` | **Browser (wasm)** + server | `xberg-wasm` exports `extract`/`extract_batch`; sync-only, 2 MB HTML cap, `SecurityLimits` enforced |
| OCR (scanned) — browser | `xberg-wasm` (`ocr-wasm`, Tesseract compiled in) | **Browser (wasm)** | wasm-safe; no candle/ORT in wasm |
| OCR (scanned) — server | `xberg-candle-ocr` (candle TrOCR + candle PaddleOCR-VL) | **Server** | native-only (`cfg(not(wasm32))`); higher quality for poor scans |
| Chunking | `xberg` (chunking) | **Browser (wasm)** | citation-preserving (page/bbox carried) |
| Embeddings — offline | `static-embeddings` (model2vec `lightweight` 256d) | **Browser (wasm)** | pure-Rust, no `hf-hub` in wasm; local model |
| Embeddings — browser | `onnxruntime-web` (e5 ONNX, 768d) | **Browser (wasm)** | external runtime; SAME `Xenova/multilingual-e5-base` ONNX, served from the Node service cache |
| Embeddings — model serving | Node service caches + serves the pinned e5 ONNX (no ORT in the server) | **Node service (serving only)** | `Xenova/multilingual-e5-base`, SHA256-pinned; the browser is the only embedder |
| PII / NER — browser | `gliner` (GLiNER.js) (gliner-pii ONNX) | **Browser (wasm)** | external runtime; SAME `onnx-community/gliner_small-v2.1` ONNX, served from the Node service cache |
| PII / NER — server | (none — server path dropped) | — | browser GLiNER.js is the only PII path; no native server |
| RAG retrieval | `edgevec` (WASM HNSW + sparse/BM25 + hybrid RRF; FTS built-in) — FlexSearch/MiniSearch optional | **Browser (wasm)** | in-browser vector index persisted to IndexedDB/OPFS; mirrored to Node for offline MCP |
| Rerank / ColBERT / layout | (out of scope for v1) | — | browser RAG uses EdgeVec hybrid RRF; server-side rerank not in v1 |
| Redaction | in-house reversible tokens (pattern from `curtain-privacy`) + AES-GCM key vault | **Browser + rehydration** | reversible tokens on-device; owner-only reveal via AES-GCM vault (browser + Node offline) |
| MCP server | `@modelcontextprotocol/sdk` (Node) + our lawyer tools | **Node service / stdio** | thin MCP host; tools delegate to the mirrored EdgeVec index + light metadata |

## 4. Engine Choices (no reimplementation)

For every capability we call the corresponding **xberg package** — we do not write our own
extractor, OCR, NER, embedder, retriever, or redactor.

- **Extraction / format parsing** → `xberg-wasm` (hosted as `@xberg-io/xberg-wasm`, wasm32
  build; one portable build, OS-independent). `packages/wasm-pipeline` is a **thin wrapper**
  over `@xberg-io/xberg-wasm` — no parsing logic of its own.
- **OCR** → in-browser OCR uses **Tesseract** via `xberg-wasm` (`ocr-wasm`, compiled into the
  WASM binary, wasm-safe). This is the wasm-safe OCR path; higher-quality candle OCR
  (`xberg-candle-ocr`, native-only) is **out of scope for v1** (there is no native server in this
  architecture — a future quality upgrade would require adding an optional OCR service, not in plan).
- **Embeddings** → the browser computes e5 (768d) **on-device** via `onnxruntime-web` using the
  SAME `multilingual-e5-base` ONNX the Node service serves from its model cache (SHA256-pinned,
  `Xenova/multilingual-e5-base`). Vectors stay consistent because both sides use the identical ONNX +
  pooling + normalization. (Optional model2vec 256d offline fallback via `static-embeddings`
  remains available in `@xberg-io/xberg-wasm` wasm, but is not the primary path.)
- **PII / NER** → the browser computes GLiNER PII **on-device** via `gliner` (GLiNER.js) using the
  SAME `gliner-pii` ONNX the Node service serves (SHA256-pinned,
  `onnx-community/gliner_small-v2.1`). xberg itself excludes ORT from wasm, so we use the browser runtime;
  there is no server-side GLiNER in this architecture.
- **RAG** → `EdgeVec` (WASM HNSW + Flat + sparse + hybrid RRF, persistence) as the primary
  in-browser vector store (`edgevec` provides dense + sparse/BM25 + hybrid RRF natively). The index is persisted to
  IndexedDB/OPFS and **mirrored** to the Node service (`POST /rag/mirror`) so `rag_query` works when
  the browser is closed. We do **not** use `xberg::chunking::rag` (the internal ORT-dependent RAG module) — browser RAG is the chosen path.
- **Rerank / ColBERT / layout** → out of scope for v1. Browser RAG uses EdgeVec hybrid RRF.
- **Redaction** → in-house reversible tokens (pattern from `curtain-privacy`) applied
  **in the browser**; originals are encrypted into a local AES-GCM key vault (owner-only
  rehydration, browser + Node offline). We do **not** use xberg's `redaction-ml`.

## 5. Storage & RAG

  - **Primary RAG store (browser):** `edgevec` (WASM HNSW + sparse/BM25 + hybrid RRF) persisted to
  IndexedDB/OPFS; full-text is provided natively by EdgeVec's sparse/BM25. Hybrid retrieval (vector ANN fused
  with FTS) gives lawyer-grade precision over exact strings (clause numbers, party names). The index
  is mirrored to the Node service (`POST /rag/mirror`) as a serialized file for offline `rag_query`.
- **Our app metadata (Node service, light):** matter / folder / consent records only — the corpus
  itself stays in the browser. Plus an **AES-GCM key vault** holding the owner's rehydration key:
  - `matters(id, name, created_at)`
  - `folders(id, matter_id, name, path?)`
  - `consent(id, subject, matter_id, scope, granted_at, expires_at?)`
  - `mirrors(matter_id, path, synced_at)` — pointer to the mirrored EdgeVec index file
  - `key_vault` — AES-GCM key material (owner-only rehydration of the mirrored curtain vault)
- **Matter scoping:** a `matter` groups folders (legal workflow). `rag_query` accepts a `matterId`.
  All reads/writes are scoped to the owning user + matter; no cross-tenant or cross-matter leakage.
  The mirror index is partitioned per `matter_id`.
- **Hybrid retrieval contract:** every returned chunk carries `doc_id`, `chunk_index`,
  `text`, `page?`, `bbox?`, `score`, `citation` so the LLM can cite "Exhibit A, p.4 ¶2"
  and the UI can highlight the span. Redacted chunks + tokens are returned by default.

## 6. Data Flow

**(a) Ingest a folder (browser-full pipeline)**
1. Lawyer drops a folder in the browser UI (`webkitdirectory`).
 2. `@xberg-io/xberg-wasm` extracts + Tesseract-OCRs + chunks **on-device**.
 3. The browser embeds with **e5** via `onnxruntime-web` and runs **GLiNER PII** via `GLiNER.js`
   — both on-device, using the pinned models served by the Node service at `/models/*`.
  4. The browser builds the **edgevec** RAG index (e5 vectors + native sparse/BM25 FTS) in IndexedDB/OPFS
   and applies in-house reversible redaction (originals → AES-GCM vault ciphertext).
 5. The browser **mirrors** the serialized EdgeVec index + light metadata to the Node service
   (`POST /rag/mirror`) so `rag_query` works when the browser is closed.
 6. Raw documents never leave the browser; only a mirrored (redacted/tokenized) index + light
   metadata reach the Node service.

**(b) Lawyer query via MCP (agent path)**
1. Claude Desktop launches `node dist/index.js mcp` (stdio) or connects to `localhost`.
2. `rag_query` (gated by `read` scope + consent + matter scope) → the Node service loads the
   mirrored EdgeVec index for the matter and runs hybrid retrieval → returns redacted chunks +
   citations. (When the browser is open, the browser serves its own live index instead.)
3. Claude synthesizes the answer from returned chunks (the service never generates prose).
4. `rehydrate_chunk` (gated by `redact`/raw consent + vault key) decrypts one chunk's
   ciphertext via the Node AES-GCM key vault so the owning lawyer sees real values; unconsented
   agents see only tokens.

## 7. MCP Tools (gated by consent + scopes)

The Node service's MCP server (built with `@modelcontextprotocol/sdk`, our lawyer tools only —
no `xberg-mcp` / `rmcp`) exposes a stable contract:

| Tool | Purpose | Gate |
| --- | --- | --- |
| `rag_query` | Hybrid retrieval over the mirrored (matter-scoped) EdgeVec index; returns redacted chunks + citations | `read` scope + consent + matter scope |
| `list_pii` | PII tags (kind + token, **not** values) for a document from the mirror metadata | `read` scope + matter scope |
| `rehydrate_chunk` | Consent-gated decrypt of a chunk's `ciphertext` via the Node AES-GCM vault; owner-only | `redact`/`raw` consent + live approval + vault key |
| `ingest_folder` | Record folder metadata (browser already ran extract/embed/index on-device) | `ingest` scope + matter scope |
| `redact` | Record a redaction marker (browser applied curtain tokens on-device) | `redact` scope + human-in-the-loop confirmation |

Deny-by-default. Every tool call is scoped to `user_id` + `matter_id` from the token.
Redaction-aware by default (tokens returned); raw rehydration requires explicit, revocable
consent and is audit-logged.

## 8. Models & Supply Chain

- All models come from **`the pinned model repos`** and are **SHA256-pinned** (embeddings:
  `Xenova/multilingual-e5-base` multilingual-e5-base; PII: `onnx-community/gliner_small-v2.1`
  gliner-pii). Pinning is enforced at the Node service's model cache layer (`models.ts`).
- **No ORT in the Node service.** Embeddings/PII run in the browser via `onnxruntime-web` +
  `GLiNER.js` (ORT lives in the browser tab, not the Node process). The Node service only
  **serves** the pinned ONNX files; it never loads ORT.
- **WASM is portable:** `@xberg-io/xberg-wasm` is one wasm32 build (OS-independent), published once as
  an npm package. Tesseract OCR comes from `ocr-wasm` (part of `wasm-target`); candle OCR is **not**
  in wasm (native-only, out of scope for v1).
- **Browser model serving:** the Node service downloads + SHA256-pins the e5 ONNX
  (`Xenova/multilingual-e5-base`) and gliner-pii ONNX (`onnx-community/gliner_small-v2.1`) and serves them
  to the browser from its local cache (`GET /models/e5.onnx`, `/models/gliner-pii.onnx`). The
  browser never contacts Hugging Face → local-first + supply-chain integrity.
- **Offline browser mode:** `static-embeddings` model2vec `lightweight` (256d) ships with
  the wasm and needs no `hf-hub` download — enables fully offline on-device embedding.
- Models are lazy-downloaded (pinned) or shipped in an offline bundle; clients never run
  `cargo`.

## 9. Security & GDPR

- **Local-first:** no egress of document content. All inference (extract/OCR/chunk/embed/PII/
  RAG/redaction) happens **entirely in the browser** on the lawyer's machine. The Node service
  holds only a mirrored (redacted/tokenized) index + light metadata.
- **Reversible redaction:** in-house tokens (pattern from `curtain-privacy`) produce stable reversible tokens
  **in the browser**; originals are encrypted into a local AES-GCM key vault (browser-owned;
  mirrored encrypted to Node for offline rehydration).
- **Key vault:** AES-GCM key material lives in a **local key vault** owned by the user (browser +
  Node offline copy); the service cannot reveal PII without it. Rehydration is owner-only.
- **Consent gate:** sending raw PII to Claude requires explicit, revocable consent
  (`rehydrate_chunk`); default = redacted tokens only.
- **Scoped tokens:** `AuthScopes = read | ingest | redact | admin`, plus matter/folder
  scoping. Deny-by-default RBAC on every tool/route.
- **Data minimization & erasure:** the Node service stores minimal artifacts (mirrored redacted
  index + light metadata + encrypted curtain vault). Right-to-erasure wipes the browser
  IndexedDB/OPFS **and** the Node mirror for the matter.
- **PII never logged.** A breach is low-impact: the Node mirror holds only tokens + vectors (+
  an encrypted curtain vault the key can't be exfiltrated without the owner key).
- **Audit log:** append-only record (Node `meta.sqlite`) of auth, ingest, `rag_query`, `list_pii`,
  `rehydrate_chunk`, `redact`, consent grant/revoke, admin actions — no PII in the log.

## 10. Release & Distribution

- **Lightweight Node.js service** (`services/mcp-server`) — cross-OS via Node (or wrapped into a
  standalone executable via `pkg` / `bun` / `nexe`); **no Rust, no cargo, no system ORT**.
- **Signed:** Windows Authenticode, macOS notarization (applied to the wrapped binary / installers).
- **WASM portable:** one `@xberg-io/xberg-wasm` npm package, no per-OS packaging.
- **Installers / one-liners:** `.msi` / `.pkg` / `.dmg` / `.deb` / AppImage + a one-liner script;
  published to **brew / winget / scoop**.
- **Models:** lazy-downloaded (SHA256-pinned) or shipped as an offline bundle.
- **Users never run `cargo` or `pnpm build` of the engine.** The browser engine ships as
  `@xberg-io/xberg-wasm`; the Node service ships prebuilt or as plain `node dist/index.js`.

## 11. Plans Index

This spec is implemented across six plans (tracked under `docs/superpowers/plans/`):

- **Plan 1 — Monorepo & Node MCP server scaffold**: `services/mcp-server` (Node.js TS,
  `@modelcontextprotocol/sdk`) serving UI + pinned models + light metadata + key vault + EdgeVec
  mirror; `apps/web`, `packages/wasm-pipeline`, `packages/core`, `packages/wasm-runtime` layout;
  localhost:8787 skeleton.
- **Plan 2 — Engine wiring (browser pipeline)**: `@xberg-io/xberg-wasm` extract/OCR/chunk +
  browser-native `onnxruntime-web` e5 embed + `GLiNER.js` PII + `EdgeVec` RAG + `curtain-privacy`
  redaction (same pinned models); mirrors the EdgeVec index to the Node `/rag/mirror`.
- **Plan 3 — Web UI & matter/folder model**: Next.js UI; browser runs RAG + redaction on-device;
  Node holds matter/folder/consent metadata; AES-GCM key vault; hybrid retrieval + matter scoping.
- **Plan 4 — MCP server & lawyer tools**: `node dist/index.js mcp` (stdio/localhost) with
  `rag_query`, `list_pii`, `rehydrate_chunk`, `ingest_folder`, `redact`; delegates to the mirrored
  EdgeVec index + light metadata; consent + scope gating; redaction-aware defaults.
- **Plan 5 — Security, GDPR & redaction**: browser-held PII/corpus, curtain reversible redaction,
  key vault, consent flows, audit log, erasure, supply-chain pinning.
- **Plan 6 — Release & distribution**: Node service cross-OS (no Rust), signing, installers,
  brew/winget/scoop, offline model bundle.

## 12. What We Do NOT Build (consumed from xberg / browser-native)

To honor the core principle, the following are **consumed, not reimplemented**:

- **Extractors** (96 formats) — `@xberg-io/xberg-wasm` (prebuilt wasm32).
- **OCR (browser)** — Tesseract via `xberg-wasm` (`ocr-wasm`). (Higher-quality candle OCR is
  native-only and out of scope for v1 — there is no native server in this architecture.)
- **In-browser e5 embeddings** — `onnxruntime-web` + the SAME pinned `Xenova/multilingual-e5-base`
  ONNX. Explicit exception to the core principle: xberg excludes ORT from wasm, so e5 cannot run in
  `@xberg-io/xberg-wasm`; the browser runtime keeps vector-space compatibility.
- **In-browser GLiNER PII / NER** — `gliner` (GLiNER.js) + the SAME pinned
  `onnx-community/gliner_small-v2.1` ONNX. Same reasoning.
- **In-browser RAG** — `edgevec` (WASM HNSW + sparse/BM25 + hybrid RRF); the browser
  owns the index (mirrored to Node for offline MCP). We do **not** use `xberg::chunking::rag`.
- **Redaction (reversible tokens)** — in-house (pattern from `curtain-privacy`) in the browser; we do **not** use xberg's
  `redaction-ml`.
- **MCP base server** — `@modelcontextprotocol/sdk` (Node); we build our own tools, no `xberg-mcp` /
  `rmcp`.

Our app owns only: orchestration, auth/consent/matter-scoping, the Next.js UI, the thin
`@xberg-io/xberg-wasm` wrapper (`packages/wasm-pipeline`), shared TS types (`packages/core`), and
optional browser model-loader/curtain glue (`packages/wasm-runtime`). The Node service owns only
model serving, light metadata, the key vault, the EdgeVec mirror, and the MCP host.

---

### Shared Contracts (authoritative)

- `AuthScopes = read | ingest | redact | admin`
- `Matter { id, name, created_at }`
- `Folder { id, matter_id, name, path? }`
- `PiiEntity { kind, start, end, text, ciphertext? }`
- `RetrievedChunk { doc_id, chunk_index, text, page?, bbox?, score, citation }`
- API base: `http://localhost:8787`
- MCP tools: `rag_query`, `list_pii`, `rehydrate_chunk`, `ingest_folder`, `redact`
- Browser→Node endpoints: `GET /models/e5.onnx`, `GET /models/gliner-pii.onnx`,
  `POST /rag/mirror` (EdgeVec index file), `GET/POST /matters`, `/folders`, `/consent`
- Node service has **no engine features** — it does not compile/run xberg, ORT, or RAG.
- WASM CI features: `["wasm-target","static-embeddings","url-ingestion"]`

## 2026-07-23 NER architecture amendment

Current state and target state must be represented separately:

- Current browser: injected JavaScript GLiNER/ORT.
- Current MCP ingest: Node `gliner@0.0.19`/ORT-Web, independent of Xberg NER.
- Target browser: Xberg Candle GLiNER2 compiled to WASM and run in a Worker.
- Target MCP: the same Xberg GLiNER2 implementation through the native Node
  binding, not through the browser WASM binary.

The official GLiNER2 privacy model is optional and lazy because its source
checkpoint is approximately 1.23 GB. Its English, French, Spanish, German,
Italian, Portuguese, and Dutch coverage must be disclosed; it cannot be
described as all-EU-language PII protection. Model identity, checksums,
thresholds, windowing, byte-offset semantics, and redaction taxonomy are shared
across hosts even when native F32 and browser F16 artifacts differ.
