# MCP-Triggered Folder Ingest + GLiNER Consolidation — Design

**Status:** Approved (pending user review of this document)
**Depends on / extends:** `docs/superpowers/specs/2026-07-15-document-intelligence-app-design.md`

## Problem

Today, ingestion only happens one way: a human opens the Web UI, drags files into
`FolderView.tsx`, and the browser runs the ONNX pipeline (`packages/wasm-pipeline`)
directly on the dropped `File` objects, pushing an encrypted mirror to the Node
service. The MCP `ingest_folder` tool ([tools.ts:97](../../../services/mcp-server/src/mcp/tools.ts))
does not process anything — it only inserts a `Folder` row and an `ingests` audit
row. There is no way to point Claude Desktop at a real folder on disk and have it
actually ingested, and no `status` concept anywhere for the Web UI to reflect that
an ingest happened outside the browser.

Separately, investigation surfaced that the repo has **two independent GLiNER
integrations** with no shared model catalog: the native Rust engine
(`crates/xberg-gliner`, SHA256-pinned models from the `xberg-io/gliner-models` HF
repo) and a browser-only JS reimplementation (`packages/wasm-pipeline/src/ner.ts`,
third-party `gliner` npm package, differently-named/quantized models). A prebuilt
native Node binding to the Rust engine (`@xberg-io/xberg`, from `crates/xberg-node`)
exists but is installed nowhere in the workspace. Critically, that native binding's
`ner-onnx` feature is **excluded on the Windows build target**
(`crates/xberg/Cargo.toml`'s `windows-target` feature list, with an explicit comment
that Windows CI cannot build `ort` reliably there) — so binding the Node MCP server
directly to the compiled Rust engine for NER is not viable on Windows today.

This spec covers both: the MCP-triggered ingest feature, and — as its Node-pipeline
component — consolidating Node-side GLiNER on the same pinned model catalog the
Rust engine uses, via `onnxruntime-node` rather than the native binding.

## Goals

- Claude Desktop can call `ingest_folder` with a real filesystem path and have it
  fully processed (extraction, chunking, embedding, PII detection) without the
  browser being open.
- Every ingested file produces **two outputs**: a human-reviewable representation
  (plaintext PII entities, persisted server-side) for the Web UI, and a
  redacted/encrypted representation (the existing `ctx.mirror`) for MCP RAG
  consumption. Both entry points (browser drag-and-drop and MCP `ingest_folder`)
  write into the same schema.
- The Web UI reflects MCP-triggered ingests as "ingested folders" via polling,
  indistinguishable in the UI from browser-driven ingests.
- Close the two security gaps found during design discussion: unauthenticated
  `/api/*` REST routes, and MCP sessions always receiving full `admin` scope.
- Node-side GLiNER inference uses the same SHA256-pinned model catalog as the
  Rust native engine, closing the model/taxonomy divergence with `wasm-pipeline`.

## Non-goals

- Rewriting `packages/wasm-pipeline` to use `onnxruntime-node` or the native Rust
  binding — the browser is structurally stuck with `onnxruntime-web` (`xberg-wasm`
  excludes ONNX Runtime from its WASM build). Repointing the browser's model
  references at the shared catalog is a small follow-up, not part of this spec.
- Fixing the Windows `ner-onnx` native-build gap (`crates/xberg` Windows feature
  set). Tracked as a separate, unrelated infra problem.
- A full JWT issuance flow (`AuthIssueRequest`/`AuthIssueResponse` in
  `packages/core/src/types.ts` stay unimplemented placeholders) — the per-launch
  shared-secret token is sufficient for the single-user desktop scope of this app.
- Live push (SSE/WebSocket) status updates — polling is sufficient per the chosen
  approach.

## A. Data model & status tracking

New/changed SQLite tables in `services/mcp-server/src/store.ts`:

- `folders` gains `status: "pending" | "processing" | "done" | "error"` and
  `last_ingested_at`.
- New `documents` table: `id, folder_id, matter_id, path, content_hash, status,
  pages, chunk_count, pii_count, ingested_via ("mcp" | "browser"), created_at`.
  `content_hash` is a SHA256 of the file bytes and is the dedupe key: re-ingesting
  a folder skips any file whose hash already has a `documents` row, and only
  processes new or changed files. Nothing is deleted on re-ingest.
- New `document_pii` table: `id, document_id, kind, start, end, text, reviewed:
  boolean`. This is the human-reviewable output — plaintext PII entities persisted
  server-side (replacing today's browser-only `sessionStorage` transient state),
  gated behind `read` + `redact` scope and consent, matching the existing
  `list_pii` tool's authorization.
- The existing `ctx.mirror` store (chunks + e5 vectors + citations + encrypted
  vault ciphertext) remains the redacted/encrypted output, unchanged in shape.
  Both entry points push into it identically.

## B. Node-side pipeline (GLiNER consolidation + folder walk)

New package `packages/node-pipeline` (TypeScript), consumed by
`services/mcp-server`:

- **Model catalog:** switches from the browser's ad-hoc `gliner-pii.{quant}.onnx`
  set to the SHA256-pinned catalog `crates/xberg-gliner` already uses
  (`xberg-io/gliner-models` HF repo: `gliner_small/medium/large-v2.5`, span-mode,
  fp32). The vendored `gliner-models.sha256` manifest becomes the single source of
  truth for both Rust and Node; Node's `ModelCache` downloads/verifies against it
  instead of its own separate manifest.
- **Runtime:** `onnxruntime-node` (Microsoft's prebuilt Node bindings — supported
  on Windows, unlike the Rust `ort` build). CPU execution provider only; no
  capability-detection needed since it's one fixed server machine.
- **Taxonomy:** adopts the Rust `EntityCategory` set (person, organization,
  location, date, time, money, percent, email, phone, url, custom) as canonical.
  The browser's extra `ssn`/`financial` labels map to `Custom("ssn")` /
  `Custom("financial")` — passed through GLiNER's zero-shot label input, no model
  retraining required.
- **Folder walk:** recursive, filtered to extensions the extractor supports
  (matching what `extractDocument`/`@xberg-io/xberg-wasm`'s `extract()` already
  handles), skipping dotfiles and dot-directories. Files that fail to extract are
  recorded as `documents.status = "error"` with a message and do not abort the
  rest of the walk.
- **Pipeline per file:** compute `content_hash` → skip if already ingested →
  extract (`@xberg-io/xberg-wasm`, reused as-is; wasm32 extraction runs fine under
  Node, this was never the blocked part) → chunk → embed (`onnxruntime-node`, e5
  model) → GLiNER PII (`onnxruntime-node`, pinned catalog above) → write
  `document_pii` rows → push into `ctx.mirror` → update `documents`/`folders`
  status.

## C. MCP tool surface

Changes in `services/mcp-server/src/mcp/tools.ts`:

- **`list_matters`** (new) — no args beyond the implicit scope check; returns
  `ctx.store.getMatters()`. Requires `read`.
- **`create_matter`** (new) — `{ name: string }`; requires `ingest`. Returns the
  new `Matter`.
- **`ingest_folder`** (rewritten) — `{ matter_id: string, path: string,
  recursive?: boolean }`. Validates `matter_id` exists, walks `path` via the
  pipeline in section B, and reports progress via standard MCP progress
  notifications (`notifications/progress`, keyed on the request's
  `progressToken`) — e.g. "12/47 files processed" — when the client supplies one,
  rather than blocking silently. Returns `{ folder, documents_processed,
  documents_skipped, pii_entities_found, errors: [{ path, message }] }`.
- `list_pii`, `rehydrate_chunk`, `rag_query`, `redact` — unchanged in shape, now
  read from the richer `documents`/`document_pii` tables instead of the bare
  `ingests` audit row.

## D. Auth & scope hardening

- **REST token:** on `serve` startup, generate a random 32-byte token, write it to
  `<dataDir>/session.token` (0600 perms), log it once. `handle()` in
  `services/mcp-server/src/index.ts` gains a guard at the top of the function:
  every `/api/*` route requires `Authorization: Bearer <token>` matching the file,
  returning `401` otherwise. `/wasm/*`, `/models/*`, and `/` remain public static
  assets — no user data lives there.
- **MCP scope:** `createAppContext` stops hardcoding
  `["read","ingest","redact","admin"]`. Default `mcp` sessions (i.e. Claude
  Desktop's default config) get `["read","ingest"]`. `redact` and `admin` require
  an explicit `--elevated` flag on the `mcp` CLI invocation, which the user adds to
  their Claude Desktop MCP server config only if they intend to let Claude call
  `redact`/`rehydrate_chunk`.
- The new ingestion tools (`ingest_folder`, `list_matters`, `create_matter`) only
  need `read`/`ingest` — the primary new capability ships without requiring the
  elevated scopes at all.

## E. Web UI sync (polling)

- `GET /api/folders` gains `status`, `document_count`, `pii_count`,
  `last_ingested_at` per folder via an aggregate query — no new endpoint, reuses
  the existing mount-time fetch in `MatterView.tsx`.
- New `GET /api/folders/:id/documents` — returns `documents` rows for a folder.
  `FolderView.tsx` gets a second render mode: if the folder already has documents
  (ingested via Claude Desktop rather than drag-and-drop), it shows that list with
  per-document status badges instead of the empty dropzone, polling every 3s while
  any document is `"processing"` and stopping once all settle.
- New `GET /api/documents/:id/pii` — returns `document_pii` rows for a PII-review
  screen, gated by the same bearer token as every other `/api/*` route.
- Browser drag-and-drop ingestion (`pushMirror`) is unchanged in mechanism, but now
  also writes into `documents`/`document_pii` per section A, so both entry points
  converge on identical Web UI state.

## Testing / Verification

- `packages/node-pipeline`: unit tests for folder walk (recursion, hidden-file
  skip, extension filtering), content-hash dedupe, and GLiNER taxonomy mapping
  (mirroring the existing `crates/xberg-gliner` label-mapping test pattern).
- `services/mcp-server`: integration test driving `ingest_folder` against a fixture
  folder, asserting `documents`/`document_pii`/`mirror` all get populated, and that
  a second call with no file changes skips everything (`documents_skipped`
  matches file count).
- `services/mcp-server`: auth test asserting `/api/*` returns `401` without the
  session token and `200` with it; scope test asserting a default (non-elevated)
  MCP session cannot call `redact`.
- Manual: run `ingest_folder` from an actual Claude Desktop session against a real
  folder, then confirm the Web UI's Matter/Folder view shows the folder as ingested
  with correct document/PII counts without any browser-side action.

## Risks / Follow-ups (out of scope here)

- Windows `ner-onnx` gap in the native Rust build remains open; if fixed later,
  `packages/node-pipeline` could potentially be replaced by binding directly to
  `@xberg-io/xberg`, but that's a future decision, not blocking this spec.
- `packages/wasm-pipeline`'s model references still point at the old
  `gliner-pii.{quant}.onnx` catalog; repointing them at the shared pinned catalog
  is a small, separate follow-up once this spec's Node-side catalog is live.
- The per-launch shared-secret token is a minimal fix, not a full auth system — if
  this app ever grows beyond single-user desktop use, the stubbed
  `AuthIssueRequest`/`AuthIssueResponse` flow should be revisited.
