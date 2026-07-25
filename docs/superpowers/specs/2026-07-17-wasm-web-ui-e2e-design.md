# Design: End-to-End Testing of the WASM Web UI (All Features) + MCP

**Date:** 2026-07-17
**Status:** Approved (design)
**Author:** brainstorming session

## Goal

Verify, in CI, that the Xberg document-intelligence web app works perfectly for
**all** of its features with the **real** in-browser engine (`@xberg-io/wasm-pipeline`
over `@xberg-io/xberg-wasm` + ONNX Runtime Web + GLiNER + EdgeVec), and that the
**MCP server** tools operate correctly against a **live bundle produced by the UI
itself** (not seeded mocks).

This is the strictest possible verification: real Chromium, real pinned models,
real stdio MCP against a shared on-disk data directory.

## Decisions (from clarifying questions)

1. **Goal:** Verify the real engine end-to-end (wire the real
   `packages/wasm-pipeline` into `apps/web`; do not test the stub).
2. **Browser runtime:** Real Chromium + real pinned models (no ML mocking).
3. **MCP scope:** Stdio MCP tools tested against a **live mirrored bundle**
   produced by the UI e2e run (no HTTP MCP transport added).
4. **Environment:** CI workflow (GitHub Actions, Ubuntu, real Chromium).
5. **Redaction/Forget:** UI e2e includes the vault-seal → redact →
   `DELETE /matters/:id` → re-query-empty GDPR loop.
6. **Pipeline modules:** Real-model vitest/Playwright harness for `ocr`, `embed`,
   `ner`, `rag`, `ingest`, `query` (modules not driven by the UI alone).

## Approach

**Approach A — Single integrated e2e suite.** One CI workflow orchestrates:
build UI → start `xberg-mcp` server → Playwright (real Chromium) drives the full
UI flow producing a real `MirrorBundle` on disk → a stdio MCP client test launches
`xberg-mcp mcp` against the **same data dir** and exercises all 5 tools against that
live bundle. Plus a headless harness for pipeline modules not reachable through the
UI. (Chosen over independent-suite and contract-only approaches because it is the
only one satisfying all six decisions above.)

---

## Section 1 — Architecture & Test Topology

```text
GitHub Actions (Ubuntu, real Chromium)
  1. pnpm install --frozen-lockfile  (better-sqlite3 prebuilt; npx playwright install chromium)
  2. Build apps/web (static export -> apps/web/out)
  3. Build mcp-server (tsup ESM -> dist)
  4. Copy models/: services/mcp-server/models/ -> e2e data dir
     cp -r apps/web/out services/mcp-server/public
  5. Start server:
       node services/mcp-server/dist/index.js serve --port 8787 \
         --data-dir $RUNNER_TEMP/xberg-e2e
     (serves UI + /wasm/* + /models/* with COOP/COEP isolation headers)
  6. Playwright (real Chromium, WebGPU->WASM EP fallback):
       drives UI -> real xberg-wasm + ONNX (e5, gliner) + EdgeVec
       -> POST /rag/mirror (REAL MirrorBundle written to disk)
  7. MCP stdio test: spawn `xberg-mcp mcp --data-dir <same dir>`
       -> 5 tools read the live bundle the UI just produced
  8. Pipeline module harness (real models) runs in the same Chromium context
```

Key invariants:

- **One shared data dir** between the server (step 5) and the MCP process (step 7)
  proves the UI→server→MCP chain is consistent. Both processes are launched with
  the **same `--data-dir`** so they share the SQLite file (`dbPath`) and the mirror
  directory (`mirrorsDir`).
- **`serve` persists everything to disk synchronously.** `MetadataStore` writes via
  `better-sqlite3` with `journal_mode = WAL` (`store.ts:64`) — every mutation
  (matter create/delete, consent, ingest, redaction, audit) is committed to SQLite
  immediately; there is **no in-memory cache of SQLite rows**. Mirror bundles are
  written to `<mirrorsDir>/<matterId>.bin` on `POST /rag/mirror` (`mirror.ts:82`).
  Therefore a second process reading the same files sees all UI mutations.
- **The MCP stdio process is a SEPARATE process** with its OWN `MirrorStore`
  instance (`index.ts:236` → `createAppContext` → `new MirrorStore`). The two
  processes share the **disk**, not memory. `ragQuery`/`listPii`/`rehydrateChunk`
  resolve bundles via `getBundle` (`mirror.ts:147`), which reads from the on-disk
  `.bin` when its in-memory map is empty — so a **freshly spawned MCP process reads
  the live bundle the UI wrote**. WAL lets `serve` (writer) and the MCP process
  (reader) run concurrently against the same SQLite file.
- **`serve` MUST remain running** during the MCP e2e (step 7) so the UI's SQLite
  state and mirror files are live; the MCP process reads them directly.
- **Real models** are SHA256-pinned and already downloaded at pin time (T7 done).
  CI serves them from the local `models/` dir — **no HF egress in CI**.
- **Cross-origin isolation** is asserted: Playwright setup checks
  `crossOriginIsolated === true` and `SharedArrayBuffer` exists before any engine
  call (guards the WebGPU/SharedArrayBuffer path).

---

## Section 2 — Engine Wiring (prerequisite fix)

The web UI's engine is currently a **stub** (`apps/web/lib/engine/index.ts`) whose
functions throw. The real `packages/wasm-pipeline` works in isolation but is not
wired in. Required changes:

1. **Remove the stub alias.** Delete the
   `resolve.alias['@xberg-io/wasm-pipeline'] -> lib/engine/index.ts` entry in
   `apps/web/next.config.mjs` so the real workspace package is used (already a
   workspace dependency).
2. **Fix the `ingestFolder` contract mismatch via a thin adapter.** The real barrel's
   `ingestFolder(matter, folder, file, options)` returns ONLY `{ accepted: number }`
   (opaque — it calls `pushMirror` internally) and takes a `Matter`/`Folder`/`passphrase`/
   `scopeToken`, while the UI consumes a 2-arg `ingestFolder(files, onProgress)` that
   expects a rich `IngestResult { text, pii, pages, chunks, mirror }` and uses
   `IngestProgress` stages. Likewise `queryRag(folderId, q, topK)` (UI) vs
   `queryRag(matter, q, topK)` (real), and `redactDocument(docId, entityIds)` (UI) vs
   `redactDocument(text, pii, passphrase, prefix)` (real). The real `ingestFolder` is
   therefore insufficient to drive the existing UI. **Resolution (deviation from the
   initial "no adapter" note):** keep the `@xberg-io/wasm-pipeline` alias pointing at
   `apps/web/lib/engine/index.ts`, but replace the stub with a real adapter that
   IMPORTS the real package under a separate, non-aliased specifier
   (`@xberg-io/wasm-pipeline-real`, aliased to `packages/wasm-pipeline/src/index.ts`)
   and COMPOSES its exported lower-level functions (`extractDocument`, `chunkExtraction`,
   `withChunking`, `withTesseractOcr`, `defaultExtractionConfig`, `embedChunks`,
   `detectPii`, `buildRedaction`, `sealVault`, `buildIndex`, `serializeIndex`,
   `pushMirror`, `detectCapabilities`, `selectScenario`) to produce the UI-shaped
   `IngestResult` and emit `IngestProgress` per stage. This uses the package; it does
   NOT reimplement engine logic (per AGENTS.md rule 1). The UI pages stay unchanged.
3. **API contract test.** Add `packages/wasm-pipeline/src/contract.test.ts` that
   imports the barrel (`src/index.ts`) and asserts the exported symbols exist with
   compatible types. Authoritative symbol table (all are real exports of the barrel):

   | Symbol | Source module | Used by |
   |--------|---------------|---------|
   | `initWasm`, `extractDocument`, `getWasm`, `firstDocument`, `extractText` | `runtime` | UI (DocumentView) |
   | `withTesseractOcr` | `ocr` | module harness (Section 5) |
   | `chunkExtraction`, `withChunking`, `toBoundingBox` | `chunk` | internal |
   | `embedChunks`, `embedQuery` | `embed` | module harness |
   | `detectPii`, `listPiiTypes` | `ner` | UI (PiiPanel) + module harness |
   | `buildIndex`, `loadIndex`, `retrieve`, `serializeIndex` | `rag` | module harness |
   | `buildRedaction`/`rehydrate`, `sealVault`/`openVault`, `redactDocument`, `redactText`/`rehydrateText` | `redact` | UI (redact.spec) |
   | `serializeMirror`, `serializeMirrorToBytes`, `pushMirror` | `mirror` | UI (folders-ingest) |
   | `ingestFolder(matter, folder, file, options)` | `ingest` | UI (FolderView) — 4-arg source of truth |
   | `queryRag(matter, query, topK)` | `query` | UI (search) |
   | `BrowserVault` | `vault` | UI (redact/forget) |
   | `assertLocalFirst` | `egress` | UI (search isolation) |
   | `detectCapabilities`, `selectScenario` | `capabilities`/`scenario` | engine init |

   The Section 5 module-harness names (`withTesseractOcr`, `embedChunks`,
   `embedQuery`, `buildIndex`, `retrieve`, `serializeIndex`, `detectPii`) are all
   confirmed real barrel exports — there is no separate/illustrative API. This
   contract test prevents the `ingestFolder` signature mismatch from silently
   regressing.
4. **WebGPU in headless Chromium.** Playwright's bundled Chromium supports WebGPU
   with `--enable-unsafe-webgpu --use-angle=swiftshader`; if unavailable,
   `scenario.ts` falls back to WASM EP automatically. The e2e asserts
   `detectCapabilities()` returns a non-error profile and embed/PII complete.

---

## Section 3 — UI E2E Specs (Playwright, real Chromium)

New `apps/web/e2e/` with `playwright.config.ts` + specs. Each runs against the live
server on `:8787`. Real models load from `/models/*`.

**Fixtures** (`apps/web/e2e/fixtures/`): small sample set — a `.txt`, a `.docx`, a
`.pdf` with a text layer, and an image with embedded text (for OCR). Kept tiny; the
models (not fixtures) are the heavy part.

**Specs:**

1. `onboarding.spec.ts` — `/` redirects to `/onboarding`; "Enter workspace" lands on
   `/matters`. Shared `beforeEach` asserts `crossOriginIsolated === true` on every page.
2. `matters.spec.ts` — create a matter via UI; assert it persists (`GET /matters`).
3. `folders-ingest.spec.ts` — open matter, drop fixture files via the dropzone, assert
   progress completes, extracted text visible in `DocumentView`, folder record exists
   (`GET /folders?matter_id=`).
4. `pii.spec.ts` — after ingest, `PiiPanel` shows detected PII **token spans** (never
   plaintext); rehydration requires the vault passphrase.
5. `search.spec.ts` — RAG query from `/search` renders `RetrievedChunkCard` with
   citations; asserts no network egress (`assertLocalFirst` guard).
6. `isolation.spec.ts` — asserts COOP/COEP headers on `/`, `/wasm/*`, `/models/*`
   (via `response.headers()`) and `SharedArrayBuffer` availability.
7. `redact.spec.ts` — seal the `BrowserVault` with a passphrase, run `redactDocument`
   on a chunk; assert ciphertext stored and plaintext not present.
8. `forget.spec.ts` — `DELETE /matters/:id` (admin scope) then re-query via UI/search
   returns nothing for that matter (GDPR loop closed end-to-end).

**Determinism:** real ONNX → variable timings. Specs use `toBeVisible`/`toContainText`
waits (no fixed sleeps) and a generous `testTimeout` (e.g. 120s/spec). PII/embed
outputs asserted **structurally** (spans present, chunks returned, non-empty
citations), not by exact strings.

---

## Section 4 — MCP Stdio Specs (live bundle)

New `services/mcp-server/tests/e2e.mcp.test.ts`, run by a script (not the unit
`vitest` config). It:

1. Spawns `node dist/index.js mcp --data-dir <same dir the UI wrote to>` as a child
   process using `StdioServerTransport`. This is a **fresh process** with its own
   `MirrorStore`; because `serve` already wrote the bundle to `<mirrorsDir>/<id>.bin`
   on disk, the MCP tools read it through the `getBundle` disk fallback
   (`mirror.ts:147-156`) — no explicit `loadMirror` call needed for the read path.
2. Uses `@modelcontextprotocol/sdk` client over stdio to call all 5 tools against the
   **real MirrorBundle the UI produced in Section 3**:
   - `rag_query` (read scope) → cited chunks matching the ingested fixture.
   - `list_pii` (read + consent) → token spans, never plaintext.
   - `rehydrate_chunk` (redact scope + consent) → decrypts a known redacted chunk
     (vault passphrase supplied via env/stdio init from the UI run).
   - `ingest_folder` (ingest scope) → creates folder + ingest record.
   - `redact` (redact scope + consent) → records a redaction marker.
3. **Forget proof:** after Section 3's `forget.spec.ts` issues
   `DELETE /matters/:id` (which calls `store.forgetMatter` + `mirror.forget`,
   deleting the on-disk `.bin`), this step spawns a **second fresh MCP process**
   against the same data dir and asserts `rag_query`/`list_pii` for that matter
   **error with `not_found`** (the bundle file is gone). This proves the live bundle
   and MCP share the same store and that deletion is reflected across processes
   (the "live bundle" guarantee). The `serve` process stays alive through both steps
   (WAL permits a writer + reader concurrently).

Scopes/consent are granted via the same consent store the UI writes
(`POST /consent`), so the stdio MCP process reads the same SQLite (WAL). This is the
"live bundle" guarantee.

---

## Section 5 — Pipeline Module Harness (real models)

New `packages/wasm-pipeline/e2e/` + a Playwright (or `vitest` + `playwright` runner)
config that loads the package in real Chromium and tests modules not driven by the UI:

- `ocr.spec.ts` — fixture image → `withTesseractOcr` returns text.
- `embed.spec.ts` — `embedChunks`/`embedQuery` return 768-dim vectors; determinism
  (same input → same vector).
- `ner.spec.ts` — `detectPii` returns expected PII types on a known fixture.
- `rag.spec.ts` — `buildIndex`/`retrieve`/`serializeIndex` round-trip; `retrieve`
  top-K returns the seeded chunk.
- `ingest.spec.ts` — full `ingestFolder` orchestration (extract→chunk→embed→PII→
  redact→index→mirror) produces a `MirrorBundle` locally (doubles as the 4-arg API
  contract proof).
- `runtime.spec.ts` — asserts the *real* EP selection (WebGPU or WASM fallback)
  initializes ORT/GLiNER without error.

Reuses the same pinned models served by the local server (or loaded directly from
`services/mcp-server/models/` copied into the test data dir).

---

## Section 6 — CI Workflow

New `.github/workflows/e2e-web.yml`:

1. `pnpm install --frozen-lockfile` (better-sqlite3 prebuilt;
   `npx playwright install chromium`).
2. Build UI: `pnpm --filter web build` → `apps/web/out`.
3. Build mcp-server: `pnpm --filter mcp-server build`.
4. Copy `services/mcp-server/models/` → e2e data dir;
   `cp -r apps/web/out services/mcp-server/public`.
5. Start `node services/mcp-server/dist/index.js serve --port 8787 \
   --data-dir $RUNNER_TEMP/xberg-e2e` (background).
6. `pnpm --filter web test:e2e` (Playwright, real Chromium + WebGPU flags).
7. `pnpm --filter wasm-pipeline test:e2e` (module harness, real models).
8. Run MCP stdio e2e against the same data dir.
9. Upload Playwright HTML report + failed-bundle artifacts on failure.

Gated by: real models already pinned (T7 done) → no HF egress. Generous timeouts
(models ~1–2 GB served locally; first ONNX session init is slow).

### Additions to `package.json` scripts

- `apps/web`: `"test:e2e": "playwright test"` (add `playwright.config.ts`).
- `packages/wasm-pipeline`: `"test:e2e": "<runner command>"`.
- `services/mcp-server`: `"test:e2e:mcp": "node tests/run-e2e-mcp.mjs"` (spawns server-less stdio MCP child + sdk client).

---

## Open risks / mitigations

- **CI model download size:** mitigated — models are pinned locally, copied into the
  data dir; no network fetch in CI.
- **WebGPU unavailable in CI runners:** mitigated — `scenario.ts` falls back to WASM
  EP; spec asserts completion, not a specific EP.
- **Flaky ONNX init:** mitigated — generous per-spec timeouts + structural assertions.
- **Shared data-dir ordering:** the MCP e2e MUST run after the UI e2e writes the
  bundle; CI job dependencies enforce this.

## Out of scope (explicit)

- No HTTP MCP transport added (UI keeps REST; MCP stays stdio).
- No mocked-ML fast gate (user chose real models only).
- No changes to the Rust core or Alef bindings (covered by existing `task test`).

## 2026-07-23 GLiNER2 test-topology amendment

During migration, CI must identify whether it is testing legacy injected
JavaScript NER or Xberg Candle GLiNER2. The target suite adds dispatch/binding
presence, invalid-byte handling, real-model native-versus-WASM parity,
canonical UTF-8 offsets, long-window overlap, seven supported-language
fixtures, and unsupported-language UX.

The full model is too large for every fast job. Keep invalid-input and binding
smokes in the normal WASM matrix, and use one explicitly cached, checksum-pinned
real-model job for parity and resource measurements.
