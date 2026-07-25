---
title: "Document Intelligence App — Plan 3: apps/web UI"
date: 2026-07-15
status: ready
depends_on:
  - 2026-07-15-doc-intel-api-localhost
  - 2026-07-15-doc-intel-wasm-pipeline
  - 2026-07-15-doc-intel-core-types
phase: 3
summary: >
  Next.js 14.2.5 App Router thin client that talks to the local Node service
  (`services/mcp-server`) HTTP API (http://localhost:8787) and uses `packages/wasm-pipeline`
  for the full on-device engine (extract+OCR+chunk+e5+GLiNER+EdgeVec RAG+curtain redaction).
  Folder-centric lawyer UX: onboarding → Matter → Folder → drag/drop docs → "Process folder"
  → results with PII panel + reversible redaction → RAG search with citations. Consumes xberg
  only as `@xberg-io/xberg-wasm` (plus browser-native runtimes); never reimplements extraction.
---

## Plan 3 — apps/web (Next.js UI)

**Depends on:** Plan 1 (API contracts, auth, localhost:8787, `/rag/mirror`), Plan 2
(`packages/wasm-pipeline` — full browser engine: extract/OCR/chunk + e5 + GLiNER + EdgeVec RAG +
curtain redaction), and `packages/core` (shared TS types: `AuthScopes`, `Matter`, `Folder`,
`PiiEntity`, `RetrievedChunk`).

**Goal:** A working, fully-local, navigable web app where a lawyer creates a Matter, adds a
Folder, drops documents, runs the **entire on-device pipeline in the browser** (extract/OCR/
chunk/embed/PII/RAG/redaction), reviews extracted text with a PII panel, triggers reversible
in-browser redaction, and runs a RAG query that returns cited chunks with page/bbox highlights.

> TypeScript `strict` + `noUncheckedIndexedAccess`, no `any`, ESM, `import type` for types.
> Components from `extend-hq/ui` (MIT shadcn registry) vendored as **editable source** under
> `apps/web/components/ui/` — copy the needed components, do NOT npm-install a black box.
> Tailwind configured per the registry.

---

### Context

The UI is a **thin client** of the browser engine (`packages/wasm-pipeline`):

- **On-device (browser, `packages/wasm-pipeline`):** extract text + Tesseract OCR + chunk
  (`@xberg-io/xberg-wasm`); embed e5 (`onnxruntime-web`); PII detection (`GLiNER.js`); **RAG
  (`EdgeVec`, persisted to IndexedDB/OPFS)**; and **reversible redaction (`curtain-privacy`
  tokens in a local AES-GCM key vault)**. The entire engine runs in the browser.
- **Node service (`services/mcp-server` localhost:8787):** serves the UI + pinned models
  (`/models/*`), holds light metadata (matters/folders/consent), the AES-GCM key vault, and
  receives the **EdgeVec mirror** (`POST /rag/mirror`) for offline MCP. It runs no engine.
- **Auth:** on first run the app obtains a scoped token from the Node service and stores it in
  `localStorage` (local only). Requests send it as `Authorization: Bearer <token>`.
  Scopes are `read | ingest | redact | admin`. This is NOT a user register/login flow.
- **Shared types** (`Matter`, `Folder`, `PiiEntity`, `RetrievedChunk`, `AuthScopes`) come
  from `packages/core` and must be reused, not redefined.

The app serves the lawyer workflow from the spec: onboarding (consent + confirm local data
dir) → matters list → matter folders → folder documents → document viewer + PII → RAG search.

---

### Approach / Tasks

#### Task 1 — Scaffold app + vendored extend-hq/ui

- [ ] **Step 1:** `apps/web/package.json`. Name `@xberg-io/web` (`web` filter for `pnpm --filter web`).
  Dependencies: `next@14.2.5`, `react@18.3.1`, `react-dom@18.3.1`, `packages/core` + `packages/wasm-pipeline`
  (`workspace:*`), `zod`. Dev: `typescript@5.5.x`, `vitest`, `@testing-library/react`,
  `@playwright/test`, Tailwind toolchain.
- [ ] **Step 2:** Vendor needed `extend-hq/ui` components as **editable source** under
  `apps/web/components/ui/` (MIT registry): button, input, card, dialog, progress,
  table, tabs, scroll-area, badge, tooltip, file-dropzone, data-grid. Add `components/ui/index.ts` barrel.
  Configure `apps/web/tailwind.config.ts` + `apps/web/postcss.config.mjs` + `apps/web/app/globals.css`.
- [ ] **Step 3:** `apps/web/next.config.mjs` — `transpilePackages: ["@xberg-io/core", "@xberg-io/wasm-pipeline"]`;
  COOP/COEP headers for WASM (WebGPU→WebGL→WASM-SIMD); `async headers()` for `(.*)`.
- [ ] **Step 4:** `apps/web/tsconfig.json` — `strict: true`, `noUncheckedIndexedAccess: true`, path alias
  `@/*` → `apps/web/*`.
- [ ] **Step 5:** `apps/web/vitest.config.ts` + `apps/web/vitest.setup.ts` (jsdom + RTL + globals).
- [ ] **Step 6:** `pnpm install` at root; commit scaffold.

#### Task 2 — API client + auth token

- [ ] **Step 1:** `apps/web/lib/api.ts` — typed client against `http://localhost:8787` using `packages/core`
  types. Functions: `getToken()`, `obtainAuth()` (calls `GET /auth`, stores Bearer in localStorage),
  `getMatters()`, `createMatter()`, `getFolders(matterId)`, `createFolder()`, `getDocuments(folderId)`,
  `processDocuments()` (delegates to `packages/wasm-pipeline`), `getPii(docId)`, `redact(docId, entityIds)`,
  `ragQuery(folderId, question)`. Each request attaches `Authorization: Bearer <token>`.
- [ ] **Step 2:** `apps/web/lib/auth.ts` — `useAuth()` hook: on mount, if no token, call `obtainAuth()`;
  exposes `token`, `scopes`, `ready`. Token persisted in `localStorage` (local only).
- [ ] **Step 3:** `apps/web/lib/api.test.ts` — mock `fetch`, assert Bearer header + typed parse.
- [ ] **Step 4:** Commit.

#### Task 3 — Onboarding page

- [ ] **Step 1:** `apps/web/app/onboarding/page.tsx` — consent screen + confirm local data directory;
  calls `GET /auth` to obtain scoped token and marks `localStorage` `xberg.onboarded`. Uses vendored
  `dialog` + `button`.
- [ ] **Step 2:** Gate at `apps/web/app/layout.tsx`: redirect to `/onboarding` if not onboarded.
- [ ] **Step 3:** `apps/web/app/onboarding/page.test.tsx` — assert token obtained + `onboarded` flag set.
- [ ] **Step 4:** Commit.

#### Task 4 — Matters + Folders (folder-centric flow)

- [ ] **Step 1:** `apps/web/app/matters/page.tsx` — list matters (`GET /matters`), create Matter
  (`POST /matters`, `Matter{id,name}`). Vendored `card` + `input` + `button`.
- [ ] **Step 2:** `apps/web/app/matters/[id]/page.tsx` — list folders for matter (`GET /folders?matter_id=`),
  create Folder (`POST /folders`, `Folder{id,matter_id,name}`).
- [ ] **Step 3:** `apps/web/app/folders/[id]/page.tsx` — documents grid (`GET /documents?folder_id=`) using
  vendored `data-grid` + `file-dropzone`. "Process folder" button:
   1. For each dropped document, call `packages/wasm-pipeline` `ingestFolder(file)` — runs the
      full on-device pipeline (extract + Tesseract OCR + chunk + e5 embed + GLiNER PII + EdgeVec
      index + curtain redaction) and pushes the EdgeVec mirror to the Node service.
   2. Render per-file progress via vendored `progress`.
- [ ] **Step 4:** `apps/web/app/folders/[id]/page.test.tsx` — mock `packages/wasm-pipeline` `extractDocument`
  - `fetch`; assert folder process → ingest POST fired.
- [ ] **Step 5:** Commit.

#### Task 5 — Document viewer + PII panel + redact

- [ ] **Step 1:** `apps/web/app/documents/[id]/page.tsx` — extracted text viewer (from ingest result)
  - PII panel rendering `PiiEntity[]` (`{kind,start,end,text,ciphertext?}`) from the browser engine.
- [ ] **Step 2:** `apps/web/components/PiiPanel.tsx` — list entities with `kind` + masked text; a
  "Redact" action calls `packages/wasm-pipeline` `redactDocument` (curtain reversible tokens;
  originals encrypted into the browser AES-GCM key vault). A mirrored redaction marker is pushed to
  Node via `/rag/mirror`.
- [ ] **Step 3:** `apps/web/components/PiiPanel.test.tsx` — assert redact call carries entity ids + updates state.
- [ ] **Step 4:** Commit.

#### Task 6 — RAG search with citations

- [ ] **Step 1:** `apps/web/app/search/page.tsx` — lawyer query box → calls `packages/wasm-pipeline`
  `queryRag` (in-browser EdgeVec hybrid retrieval); renders `RetrievedChunk[]` with `text`, `score`,
  and `citation`; highlights `page?`/`bbox?`. (When the browser is closed, the MCP server answers
  `rag_query` from the Node mirror instead.)
- [ ] **Step 2:** `apps/web/components/RetrievedChunkCard.tsx` — vendored `card` showing chunk text +
  citation (doc + chunk_index + page/bbox when present).
- [ ] **Step 3:** `apps/web/app/search/page.test.tsx` — mock `queryRag`, assert chunks + citations rendered.
- [ ] **Step 4:** Commit.

#### Task 7 — Build + full test run

- [ ] **Step 1:** `pnpm --filter web build` (Next production build) — must succeed.
- [ ] **Step 2:** `pnpm --filter web exec tsc --noEmit` — strict typecheck clean.
- [ ] **Step 3:** `pnpm --filter web test` — all RTL tests green.
- [ ] **Step 4:** Commit.

---

### Depends on

- Plan 1 — API contracts, auth (scoped token, localhost:8787), MCP tools
  (`rag_query`, `list_pii`, `rehydrate_chunk`, `ingest_folder`, `redact`).
- Plan 2 — `packages/wasm-pipeline` (thin `@xberg-io/xberg-wasm` wrapper: `extractDocument` extract+OCR+chunk).
- `packages/core` — shared TS types: `AuthScopes`, `Matter`, `Folder`, `PiiEntity`, `RetrievedChunk`.

### Verification

- `pnpm --filter web dev` (pointed at a running `services/mcp-server` on localhost:8787).
- Manual flow: create Matter → add Folder → drag/drop docs → "Process folder" → see extracted
  text + PII panel → redact (reversible curtain token) → `/search` returns cited chunks with
  page/bbox highlights.
- `pnpm --filter web build` + `pnpm --filter web exec tsc --noEmit` both clean.

### Risks / Non-goals

- **No extraction/engine logic in the UI.** The browser only calls `packages/wasm-pipeline`, which
  itself consumes `@xberg-io/xberg-wasm` + browser-native runtimes (ORT-Web, GLiNER.js, EdgeVec, curtain).
  The Node service runs no engine — it serves models, holds metadata, and mirrors the index.
- **Non-goal: multi-user / cloud.** Single local user, scoped token in localStorage, all traffic
  to localhost only. No remote auth, no shared tenancy.
- Risk: WASM delivery needs COOP/COEP headers (wasm-pipeline sets them; verify dev/prod match).
- Risk: `extend-hq/ui` vendored components may need light TS strictness fixes after copy.

### Exit criteria

- `pnpm --filter web build` and `tsc --noEmit` clean; unit tests green.
- Folder-centric lawyer flow works end-to-end against the local Node service: onboarding → Matter →
  Folder → Process (full browser pipeline) → PII panel → reversible in-browser redaction → RAG
  search with citations (browser EdgeVec, mirrored for offline MCP).
- PII detection, embeddings, RAG, and redaction all happen in the browser; UI never reimplements them.

### 2026-07-23 GLiNER2 UI amendment

PII remains backend-neutral at the UI boundary. Today it is supplied by
GLiNER.js; the target is Xberg Candle GLiNER2 in a Worker. Add visible states
for optional model installation, verified download, initialization,
cancellation/failure, and unsupported document language. Human review is
mandatory outside the model's seven claimed languages.
