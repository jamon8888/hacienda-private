# Full Implementation Plan: Xberg WASM Web UI — Lawyer-Grade Enhancement

**Date:** 2026-07-20
**Status:** Ready to build
**Spec:** `docs/superpowers/specs/2026-07-20-web-ui-lawyer-enhancement.md`
**Depends on:** Current branch (all extend-hq/ui components already integrated via prior stash pop)
**Out of scope:** E-signature (removed per request). Sign-off out of v1.

## Codebase Review Summary (Key Findings)

**Existing features we leverage:**
| Module | Key Features | Relevance |
|---|---|---|
| `packages/wasm-pipeline/src/redact.ts` | `buildRedaction()` → tokens `{{KIND_N}}` (e.g., `{{PERSON_1}}`, `{{EMAIL_1}}`); `redactDocument()` returns `{redacted, entries, sealed}` | **Exact format Claude Desktop receives** — tokens replace PII |
| `packages/wasm-pipeline/src/vault.ts` | `BrowserVault` — PBKDF2 + AES-GCM rehydration with passphrase; `rehydrate()` reconstructs original | Passphrase-gated plaintext reveal; never in DOM without unlock |
| `packages/wasm-pipeline/src/mirror.ts` | Stores `index` + `vault cipher` + `pii spans (start/end/token/kind)` + `chunks` with `bbox`/`page`/citation | Source of truth for both original chunks and redacted tokens |
| `apps/web/components/ui/pdf-viewer.tsx` (2456 lines) | EmbedPDF: text search, selection, zoom, rotation, scroll, interaction, thumbnails, rendering | **All original PDF features** — search, select, navigate, zoom |
| `apps/web/components/ui/docx-viewer.tsx` | @extend-ai/react-docx: full DOCX rendering, track changes, comments | Original DOCX view |
| `apps/web/components/ui/xlsx-viewer.tsx` | @extend-ai/react-xlsx: full XLSX rendering, sheets, cells | Original XLSX view |
| `apps/web/components/ui/pptx-viewer.tsx` | @extend-ai/react-pptx: PPTX rendering, slides | Original PPTX view |
| `apps/web/components/ui/csv-viewer.tsx` | GlideDataGrid: CSV/TSV table view | Original CSV view |
| `apps/web/lib/engine/adapter.ts` | `ingestFolder()` → full pipeline extract→OCR→chunk→embed→PII→redact→index→mirror | Complete on-device pipeline already wired |
| `apps/web/components/PiiPanel.tsx` | Current: renders `e.text` plaintext (privacy bug) | **Must fix** → token spans only |
| `apps/web/components/RetrievedChunkCard.tsx` | Shows chunk text + citation | Search result view |

**Trust Mechanism (Claude Desktop):**
- Redacted document = `{{KIND_N}}` tokens replacing PII (no plaintext ever leaves browser)
- `BrowserVault` sealed with user passphrase (PBKDF2 200k + AES-GCM)
- Mirror bundle stored locally; only redacted text + tokens shared with Claude
- User can verify: "What Claude sees" = redacted view with tokens

---

## Resolved Open Questions

1. **Schema Builder scope:** v1 = display + per-matter PII-type selection that filters/highlights the PII panel + human-review. Does NOT alter extraction engine.
2. *(E-signature removed — no attestation work in v1.)*
3. **Persist corrected PII:** **Yes** — write corrections back via `pushMirror` (re-mirror) so reviewed state survives reload and is queryable.

---

## STEP 0 — Verify Baseline

- [ ] `pnpm --filter @xberg-io/web typecheck` → assert **0 errors**.
- [ ] `pnpm --filter @xberg-io/web build` → assert success.
- [ ] Confirm all 16 extend components + Base UI primitives present in `apps/web/components/ui/`.

---

## STEP 1 — Fix PII Privacy (Critical, Build First)

**Files:** `components/PiiPanel.tsx`, `lib/engine/adapter.ts`
- [ ] In `PiiPanel`, stop rendering `e.text`. Render **masked token spans** only:
  - Use `e.token` (format `{{KIND_N}}`) or derive stable mask from `start`/`end`.
  - Group entries by `e.kind`; filter chips per kind with counts.
  - Never put plaintext in the DOM.
- [ ] Click span → passphrase dialog → call `redactDocumentForUi(placeholderText, [pii], passphrase)` to rehydrate.
- [ ] Show rehydrated value **session-only** in a popover; do not persist plaintext.
- [ ] "Redact all of type X in matter" → batch `redactDocumentForUi` across matter's entities; show redaction marker (strikethrough token).
- [ ] Verify no network call on rehydration (`assertLocalFirst` invariant).
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 2 — Upload & Ingestion (Folder/Ingest Screen)

**Files:** `app/folders/[id]/FolderView.tsx`, `components/ui/file-dropzone.tsx`, `lib/engine/adapter.ts` (`IngestContext`, `ingestFolder`, `IngestProgress`)
- [ ] Replace fake "Create folder" input with `file-dropzone` → `ingestFolder(matter, folder, file, options)`.
- [ ] Render per-file staged progress: `progress` bar driven by `IngestProgress.stage` (extract→ocr→chunk→embed→pii→index→done/error) + status `badge`.
- [ ] Virtualized queue (`@tanstack/react-virtual`) showing pages + PII count + retry on failure (structured error + suggestion).
- [ ] On completion: mirror pushed; doc appears in `matter-nav` without reload (event-driven refresh).
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 3 — Document View: MIME Routing + All Original Formats Viewable

**Files:** `app/documents/[id]/DocumentView.tsx`, `app/documents/[id]/page.tsx`, new `components/document-router.tsx`
- [ ] **Document Router** (`document-router.tsx`): route by MIME/ext to correct viewer:
  - `application/pdf` → `pdf-viewer` (full EmbedPDF: search, select, zoom, rotate, scroll, thumbnails)
  - `application/vnd.openxmlformats-officedocument.wordprocessingml.document` → `docx-viewer`
  - `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` → `xlsx-viewer`
  - `application/vnd.openxmlformats-officedocument.presentationml.presentation` → `pptx-viewer`
  - `text/csv` / `text/tab-separated-values` → `csv-viewer`
  - `image/*` → preview + OCR overlay
  - `text/*`, `application/json`, `text/markdown` → rendered with chunk boundaries
- [ ] **3-pane layout:** `[Viewer] ‖ [document-viewer-sidebar thumbnails] ‖ [PII/Context pane]`
- [ ] Viewer text-layer selection forwards selected span → opens PII panel / review for that span.
- [ ] Add `#portal` div in `app/layout.tsx` (Glide Data Grid requirement for bounding-box-citations).
- [ ] Wrap viewers needing browser-only APIs so they mount client-side.
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 4 — Dual-Pane View: Original + Redacted (Claude Desktop Trust)

**Files:** new `components/DocumentDualView.tsx`, `app/documents/[id]/DocumentView.tsx` (refactor)
- [ ] **Top pane: Original Document Viewer** (from Step 3) — shows the actual document with all features (search, select, zoom).
- [ ] **Bottom pane: Redacted Version Viewer** — shows the exact same document with **PII replaced by tokens** (`{{PERSON_1}}`, `{{EMAIL_1}}`, etc.):
  - Source: `mirror.ts` bundle's `chunks` with `text` field (already redacted) + `pii` spans.
  - Render as formatted text/markdown matching the original format.
  - Add "Copy for Claude Desktop" button → copies the redacted version to clipboard.
- [ ] **Trust Indicator Badge:** Persistent "🔒 What Claude sees" label on redacted pane; click → shows:
  - "This is the exact document sent to Claude Desktop"
  - "PII replaced with tokens: `{{PERSON_1}}`, `{{EMAIL_1}}`..."
  - "Original PII sealed in vault (passphrase required to rehydrate)"
  - "No plaintext ever leaves your browser"
- [ ] **Sync Scroll:** Optional sync scroll between original and redacted panes (toggle).
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 5 — Human Review (Bounding-Box Citations)

**Files:** new `components/PiiReviewPanel.tsx`, reuse `bounding-box-citations` `HumanReviewPanel`, `app/documents/[id]/DocumentView.tsx`
- [ ] `PiiReviewPanel` builds `ReviewField[]` from doc's PII + extracted values:
  - `key` (stable id), `schema` (infer from `kind`), `actual` (masked token), `expected` (editable),
  - `location: { page, area }` from `chunk.page` + `chunk.bbox`.
- [ ] Mount `HumanReviewPanel` with `fields`, `showExpected`, `onFieldFocus` (→ viewer scrolls/highlights `location`).
- [ ] Reviewer actions: Confirm (accept masked), Correct (set `expected`), Reject (mark null); per-field Undo + "Set to NULL".
- [ ] "Save review" → compile corrections → `pushMirror` (re-mirror) so reviewed state persists (Q3).
- [ ] Lazy-load `bounding-box-citations` via `next/dynamic` `ssr:false` (Glide Data Grid SSR).
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 6 — Search / RAG with Citation Deep-Links

**Files:** `app/search/page.tsx`, `components/RetrievedChunkCard.tsx`
- [ ] Add facet controls: folder `select`, PII-type `badge` toggle row, confidence `toggle` (Base UI `tabs`/`badge`/`select`).
- [ ] Persistent **zero-egress badge** while `queryRagForUi` runs (wrap in `assertLocalFirst` guard; show "100% on-device").
- [ ] `RetrievedChunkCard`: citation link → `/documents/:id?folder_id=:fid&page=:n&bbox=...` (from `chunk.citation` + `chunk.page` + `chunk.bbox`); click deep-links into viewer at exact source location (Step 3 reads query params).
- [ ] Render results in `scroll-area`; empty/loading states.
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 7 — Document Splits (Large Filings)

**Files:** `app/documents/[id]/splits` (new route or modal), `document-splits`
- [ ] Add "Split document" action on Document view → opens `document-splits` with doc's pages.
- [ ] User defines segment boundaries → produces labeled segments (store metadata client-side; mirror alongside doc).
- [ ] Segments become selectable review units in `matter-nav` / review panel.
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 8 — Schema Builder (Matter Templates)

**Files:** `app/matters/[id]/templates` (new) or modal, `schema-builder`
- [ ] Add "Extraction template" to Matter view → opens `schema-builder`.
- [ ] User picks PII types the matter cares about (from `listPiiTypes()`); selection saved to matter metadata.
- [ ] Selected types **filter + highlight** the PII panel (Step 1) and human-review panel (Step 5): non-selected kinds dimmed/collapsed.
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 9 — Layout Blocks (Review Workspace)

**Files:** `layout-blocks`, `app/(workspace)/layout.tsx` or composed `DocumentWorkspace` component
- [ ] Use `layout-blocks` to compose the 3-pane review workspace: `matter-nav` (or `file-system`) ‖ viewer+`document-viewer-sidebar` ‖ PII/review pane.
- [ ] Make panes resizable (`resizable`) and collapsible on `<md`.
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 10 — Browse Route (Extend File-System)

**Files:** `app/browse/page.tsx` (new)
- [ ] Mount extend `file-system` Finder reading same matter/folder/doc data as `matter-nav` (via `lib/api.ts`); double-click doc → `/documents/:id`.
- [ ] Keep `matter-nav` as primary workspace sidebar; `file-system` is alternate browse surface reachable from top bar.
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 11 — Forget / GDPR Closure

**Files:** `app/matters/[id]/MatterView.tsx`, `lib/api.ts` (`DELETE /matters/:id`)
- [ ] Add "Forget matter" action (destructive, confirm `dialog`) → calls `DELETE /matters/:id`.
- [ ] After success, clear local session state for that matter; re-query search returns nothing (proven by e2e `forget.spec.ts`).
- [ ] `pnpm --filter @xberg-io/web typecheck`.

---

## STEP 12 — Polish

- [ ] Skeletons for viewer/PII/search loading; empty states for no-matter / no-folder / no-results.
- [ ] Toasts for ingest-done, redact, review-saved, forget.
- [ ] Dark/light theming via Base UI tokens (`next-themes` already a dep).
- [ ] Responsive pass: `md+` 3-pane; `<md` drawer nav (hamburger) + stacked panes; ⌘K palette wired in `app-shell`.
- [ ] `pnpm --filter @xberg-io/web typecheck` → 0 errors.
- [ ] `pnpm --filter @xberg-io/web build` → success.
- [ ] (Optional) Extend Playwright e2e to cover PII review + redact + forget + dual-pane view.

---

## File Change Index

| Step | Files (N=new, M=modified) |
|---|---|
| 0 | (verify) |
| 1 | `components/PiiPanel.tsx` (M), `lib/engine/adapter.ts` (M) |
| 2 | `app/folders/[id]/FolderView.tsx` (M), `components/ui/file-dropzone.tsx` (use) |
| 3 | `app/documents/[id]/DocumentView.tsx` (M), `app/documents/[id]/page.tsx` (M), `components/document-router.tsx` (N) |
| 4 | `components/DocumentDualView.tsx` (N), `app/documents/[id]/DocumentView.tsx` (M) |
| 5 | `components/PiiReviewPanel.tsx` (N), `app/documents/[id]/DocumentView.tsx` (M) |
| 6 | `app/search/page.tsx` (M), `components/RetrievedChunkCard.tsx` (M) |
| 7 | `app/documents/[id]/splits` (N) |
| 8 | `app/matters/[id]/templates` (N) |
| 9 | workspace layout / `DocumentWorkspace` (N/M) |
| 10 | `app/browse/page.tsx` (N) |
| 11 | `app/matters/[id]/MatterView.tsx` (M), `lib/api.ts` (M) |
| 12 | various (polish) |

---

## Risks / Mitigations

- **Glide Data Grid SSR:** `next/dynamic` `ssr:false` + `#portal` div (Steps 3/4/5).
- **Base UI API drift:** keep primitives as-is; never revert to Radix.
- **Experimental editors:** use docx/xlsx viewers + track-changes review, not free-form edit.
- **Version skew (solved):** `emptyGridSelection`→local const, `icon-sm` exists, `Button` no `loading` (use `disabled`).

---

## Definition of Done

- ✅ All original document formats viewable with full features (search, select, zoom, navigate).
- ✅ Redacted version viewable alongside (tokens `{{KIND_N}}`) — exact Claude Desktop view.
- ✅ Trust indicator explains what Claude sees; "Copy for Claude" button works.
- ✅ PII panel never renders plaintext; rehydration passphrase-gated.
- ✅ Human review against source bbox via bounding-box-citations.
- ✅ Matter→ingest→view→review→redact→search→split→template→forget loop on-device.
- ✅ Typecheck + build green.
- ✅ E-signature explicitly excluded.

---

## Next Action

Say **"build"** and I'll execute sequentially starting from Step 0.