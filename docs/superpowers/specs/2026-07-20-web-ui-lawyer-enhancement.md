# Design: Xberg WASM Web UI — Lawyer-Grade Enhancement (Full End-to-End)

**Date:** 2026-07-20
**Status:** Draft (design spec, no code yet)
**Author:** brainstorm session
**Depends on:** `stash@{0}` — "wip: extend-hq-ui full library + Base UI migration" (all extend-hq/ui components integrated + Base UI primitives + 0 type errors + successful `next build`)

## Goal

Elevate the Xberg on-device document-intelligence web app from a minimal
upload/view prototype into a **lawyer-grade workspace** that mirrors how legal
professionals actually work: *matter → binder of evidence → find the risky
clause / PII → verify it against the source → redact → sign off → prove it's
gone*. Every step runs **on-device** (xberg-wasm + ONNX Runtime Web + GLiNER +
EdgeVec); nothing leaves the browser.

This spec covers the **full end-to-end workflow** using the complete
extend-hq/ui component library. Two navigation paradigms are used: extend's
full `file-system` (Finder) for a self-contained browse view, and an
API-driven `matter-nav` for the primary workspace sidebar.

---

## 1. Current State (verified)

- Engine is wired: `apps/web/lib/engine/adapter.ts` composes
  `extractDocument → withTesseractOcr → chunkExtraction → embedChunks →
  detectPii → buildRedaction → sealVault → buildIndex → pushMirror` into a
  UI-shaped `IngestResult` with per-stage `IngestProgress`.
- Screens exist but are minimal: `matters`, `folders/[id]`, `documents/[id]`,
  `search`, `onboarding`. They use a single `max-w-3xl` column, a `prompt()`
  for folder names, and a **plaintext-PII bug** in `PiiPanel` (`e.text` is
  rendered in the DOM).
- `stash@{0}` already integrates **all 16 extend-hq/ui components** (pdf/docx/
  xlsx/pptx/csv viewers, file-upload, file-dropzone, file-system,
  file-thumbnail, document-viewer-sidebar, bounding-box-citations,
  e-signature, document-splits, docx/xlsx editors, schema-builder,
  layout-blocks) on **Base UI** primitives, with a responsive `app-shell` +
  `matter-nav` skeleton, compiling at 0 type errors and a successful
  static `next build`.

## 2. Design Principles

1. **Privacy by default.** PII values are never rendered in plaintext in the
   DOM. Only token spans / masks are shown; rehydration requires the vault
   passphrase. This fixes the current `PiiPanel` defect and is a hard
   requirement, not polish.
2. **Source-linked everything.** Every extracted value, chunk, and PII entity
   carries a citation back to its page/bounding box in the source document.
   Reviewers never lose the "where did this come from" thread.
3. **Zero-egress trust signal.** A persistent badge proves the engine runs
   100% locally (`assertLocalFirst` guard), since the product's value to
   lawyers is confidentiality.
4. **Lawyer-shaped, not dev-shaped.** Folders are "matters/binders", actions
   are "review / redact / sign off / forget", progress is staged and legible.
5. **Responsive first.** Desktop: 3-pane workspace (nav ‖ viewer ‖ context).
   Mobile/tablet: drawer nav + stacked panes.

---

## 3. Screen & Component Map (full end-to-end)

| # | Screen / Surface | extend-hq/ui components | Behavior |
|---|---|---|---|
| 0 | **App shell** | `matter-nav` (workspace sidebar) + extend `file-system` (browse route) + `command` (⌘K) + `scroll-area` | Persistent matter→folder→doc tree, top bar with matter context + vault-lock status + ⌘K, mobile drawer. |
| 1 | **Onboarding** | `card`, `button` | Enter workspace → generates local auth token + scopes; optional vault passphrase setup. |
| 2 | **Matters** | `matter-nav`, `dialog`, `button`, `badge` | List/create matters; each matter shows doc count + PII count badge. |
| 3 | **Browse (Finder)** | `file-system` | Self-contained Finder view of the matter's file tree (alternative to the workspace tree). |
| 4 | **Folder / Ingest** | `file-dropzone` → `file-upload`, `data-grid`/`table`, `progress`, `badge` | Drag-drop ingest with **staged progress** (extract→OCR→embed→PII→index) per file via `ingestFolder` adapter; virtualized queue showing pages + PII count + retry. |
| 5 | **Document view** | `pdf-viewer` / `docx-viewer` / `xlsx-viewer` / `pptx-viewer` / `csv-viewer` / `document-viewer-sidebar`, `tabs` | Route by MIME to the right viewer + responsive thumbnail sidebar; text-layer selection forwards spans to PII/review. |
| 6 | **PII panel** (right pane) | `PiiPanel` (fixed), `badge`, `popover`, `tabs` | **Token spans only**; grouped by `kind`; filter chips; passphrase-gated rehydration preview; "redact all of type X in matter". |
| 7 | **Human review** (differentiator) | `bounding-box-citations` (`HumanReviewPanel`) | Reviewer confirms/corrects each detected PII/extracted field against its **source bounding box**; side-by-side actual/expected; per-field undo. |
| 8 | **Search / RAG** | `RetrievedChunkCard`, `tabs`, `badge`, `scroll-area` | Query → cited chunks → click jumps into viewer at page/offset; **zero-egress badge**; facets (matter/folder/PII type). |
| 9 | **Splits & templates** | `document-splits`, `schema-builder` | Split large filings into reviewable segments; define extraction schema per matter type. |
| 10 | **Forget (GDPR)** | `dialog`, `button` | "Forget matter" → proves deletion end-to-end (adapter already supports `redactDocument`/vault + server `DELETE /matters/:id`). |
| 11 | **Forget (GDPR)** | `dialog`, `button` | "Forget matter" → proves deletion end-to-end (adapter already supports `redactDocument`/vault + server `DELETE /matters/:id`). |
| 12 | **Workspace layout** | `layout-blocks` | Composed 3-pane review workspace (viewer ‖ sidebar ‖ PII/review). |

> **E-signature is out of scope for v1** (removed per request). Sign-off is not
> part of this enhancement pass. |

---

## 4. Key Flows

### 4.1 Ingestion (Folder / Ingest screen)

1. User drops files/folder onto `file-dropzone`.
2. For each file: call `ingestFolder(matter, folder, file, options)` from the
   adapter; render `IngestProgress` stages (extract→ocr→chunk→embed→pii→index→
   done/error) as a `progress` bar + status `badge`.
3. On PII detection, update the folder's PII-count badge live (the `Folder`
   type already carries `pii_count`).
4. Failed files show structured error + retry (matching the Rust error
   contract: operation / input / root cause / suggestion).
5. On completion, mirror bundle is pushed (`pushMirror`) and the doc appears
   in `matter-nav` without a reload.

### 4.2 Document review (Document view + PII + Human review)

1. Open a document → routed to the correct viewer with `document-viewer-sidebar`
   thumbnails.
2. Right pane = `PiiPanel` showing **token spans only** (masked). Clicking a
   span prompts for the vault passphrase; on success, `redactDocument`/
   `sealVault` rehydrates the value for viewing (never persisted in plaintext).
3. "Review" action opens `bounding-box-citations` `HumanReviewPanel` with one
   `ReviewField` per detected PII/extracted value: `location: { page, area }`
   highlights the source bbox in the viewer; reviewer confirms, corrects, or
   rejects; per-field undo + "set to NULL".
4. "Redact all of type X in matter" batches `redactDocumentForUi` across the
   matter's entities.

### 4.3 Search (Search screen)

1. Natural-language query → `queryRagForUi(matter, q, topK)` →
   `RetrievedChunkCard`s with citations.
2. Each card's citation links to `/documents/:id?...&page=:n&bbox=...`,
   deep-linking the viewer to the exact source location.
3. `assertLocalFirst` guard renders a "100% on-device" badge; if any egress is
   attempted it errors (privacy guarantee made visible).
4. Faceted filters: by folder, by PII type, by confidence.

### 4.4 Governance (Splits / Templates / Forget)

1. `document-splits`: break a large filing into labeled segments for
   distributed review.
2. `schema-builder`: matter-type extraction templates (selected PII types
   filter/highlight the PII panel + review).
3. Forget: `DELETE /matters/:id` → re-query returns nothing (GDPR closure),
   mirrored by the e2e `forget.spec.ts` loop.

> **E-signature / sign-off is out of scope for v1.**

---

## 5. Component Integration Notes (from stash@{0})

- **Base UI primitives** are the foundation (button, dialog, tabs, tooltip,
  scroll-area, select, etc. were migrated from Radix to Base UI to match the
  extend components). Keep them; do not revert to Radix.
- **`bounding-box-citations`** API: `HumanReviewPanel` takes
  `fields: ReviewField[]`, `activeFieldKey?`, `onFieldFocus?`,
  `showExpected?`, `theme?`. `ReviewField` = `{ key, schema, actual, expected,
  location?: { page, area } }`. Needs a `#portal` div (Glide Data Grid) and
  `next/dynamic` `ssr: false` if SSR errors appear.
- **`e-signature`** expects `PDFViewer` + `pdf-block-resizable-shell`.
- **`docx-editor` / `xlsx-editor`** are experimental; use read+track-changes
  review, not free-form editing, for v1.
- **Version skew handled in stash:** GlideDataGrid 6.x lacks `emptyGridSelection`
  (local const added), Base UI 1.6 `Button` lacks `loading` (use `disabled`),
  `icon-sm` size exists. Don't reintroduce these.
- **`file-system`** is a self-contained Finder; wire it to a `/browse` route
  reading the same matter/folder data as `matter-nav`.

## 6. Privacy & Safety (must-haves)

- `PiiPanel` MUST render token spans, never `e.text`. (Fixes current defect.)
- Rehydration requires passphrase; rehydrated plaintext is session-only.
- Zero-egress badge is always visible during search/index operations.
- "Forget matter" is irreversible and verified by empty re-query.

## 7. Responsive Behavior

- `md+`: 3-pane — `matter-nav` (w-72) ‖ viewer/main (flex-1) ‖ context pane
  (PII/review, w-96, collapsible).
- `<md`: `matter-nav` becomes a slide-in drawer (hamburger); context pane
  stacks below the viewer; `command` palette reachable via ⌘K / search button.

## 8. Out of Scope (this pass)

- Server/Rust changes (already covered by other plans).
- Real ML-model accuracy tuning (models pinned; covered by e2e design).
- Multi-user/cloud sync (explicitly local-first by design).

## 9. Resolved Decisions

1. `schema-builder` templates: v1 = display + per-matter PII-type selection that
   *filters/highlights* the PII panel and human-review. Does not alter the
   extraction engine.
2. **E-signature / sign-off: removed from scope (v1).** Not built.
3. Reviewed/corrected PII: **persisted** via `pushMirror` (re-mirror) so the
   reviewed state survives reload and is queryable.

## 10. Build Sequence (when approved — see full plan)

See `2026-07-20-web-ui-lawyer-enhancement-plan.md` for the granular STEP 0–11
build sequence (e-signature excluded).

## 2026-07-23 GLiNER2 review amendment

The review UI must show contextual-NER backend/model identity and supported
languages. The existing JS detector is transitional; the target is Xberg
Candle GLiNER2 shared with native MCP. A pinned model alone is not assurance:
outside English, French, Spanish, German, Italian, Portuguese, and Dutch the UI
must warn and require human review or a validated fallback.
