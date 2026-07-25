# CodeRabbit Major Findings (PR #23) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two deferred CodeRabbit "Major" findings on PR #23 — (1) multi-file upload overwriting a matter's mirror, and (2) citation `page`/`bbox` deep-links that never reach the viewer — each in its own conventional commit, verified before push.

**Architecture:** Finding 1 is fixed entirely client-side: the server explicitly never imports edgevec and cannot merge the opaque EdgeVec `index` bytes nor reseal the AES-GCM `vault`, so the merge must live in the browser. We make the EdgeVec index additive per matter, keep a per-matter tokenized accumulator (pii/chunks + a re-sealable vault) in IndexedDB, push the full cumulative bundle on every ingest, and serialize the upload batch to kill the `Promise.all` race. Finding 2 parses the citation search params in `DocumentView` and threads them through `DocumentDualView` → `DocumentRouter` → `PDFViewer` (imperative `scrollToPageArea` + `renderPageOverlay`), degrading to a no-op for non-PDF viewers.

**Tech Stack:** TypeScript, Next.js 14 App Router, React, `@xberg-io/wasm-pipeline` (browser engine adapter at `apps/web/lib/engine`), `edgevec` (wasm vector index), WebCrypto (PBKDF2 + AES-GCM vault), `idb-keyval` (client store), Vitest (unit), Playwright (e2e).

## Global Constraints

- **Commit style:** one commit per finding, conventional format `fix(web): …`. **No AI/Claude attribution** anywhere in the message — the repo CI rejects `Co-Authored-By` / `Generated with` lines mentioning an AI. No `Co-Authored-By` trailer at all.
- **Do not push** without explicit confirmation. Commit and push are two separate approvals; ask before each.
- **exFAT environment (mandatory for every build/test):**
  - The repo lives on an exFAT SSD that breaks `next build` (AppleDouble `._*` collisions) and `tsx` Unix sockets. An APFS sparse image is mounted at `/Volumes/xbergtmp`.
  - If `ls /Volumes/xbergtmp` fails, remount: `hdiutil attach /Volumes/ExtremeSSD/xbergtmp.sparseimage`.
  - Always export `TMPDIR=/Volumes/xbergtmp/` for any build/test.
  - `apps/web/.next` and `apps/web/out` MUST be symlinks onto the APFS volume. Verify with `ls -la apps/web/.next apps/web/out`. If either is a real directory, recreate:

    ```text
    rm -rf apps/web/.next apps/web/out
    mkdir -p /Volumes/xbergtmp/web-next /Volumes/xbergtmp/web-out
    ln -s /Volumes/xbergtmp/web-next apps/web/.next
    ln -s /Volumes/xbergtmp/web-out apps/web/out
    ```

    (At plan time `.next` is a symlink but `out` is a real exFAT dir — recreate `out` before the first build.)
  - Playwright Chromium lives at `/Volumes/ExtremeSSD/.cache/ms-playwright`; the e5 model cache symlink in `apps/web/e2e/start-server.mjs` points at `/Volumes/xbergtmp/xberg-e2e-model-cache` (already in place).
  - After any macOS/Finder op, purge stray AppleDouble files: `find . -maxdepth 4 -iname "._*" -not -path "*/node_modules/*" -delete`.
- **Verification gate before EACH commit:**
  - Finding 1: `pnpm --filter mcp-server test`, `pnpm --filter @xberg-io/wasm-pipeline test`, `pnpm --filter web test`, then the full build + e2e (below).
  - Finding 2: `pnpm --filter web typecheck` + build, then manual browser deep-link check (e2e optional).
  - Build + e2e (from `apps/web`):

    ```text
    TMPDIR=/Volumes/xbergtmp/ pnpm run build
    PLAYWRIGHT_BROWSERS_PATH=/Volumes/ExtremeSSD/.cache/ms-playwright TMPDIR=/Volumes/xbergtmp/ pnpm exec playwright test
    ```

- **Branch:** create `fix/coderabbit-major-findings` from up-to-date `main` before any edit.

---

## File Structure

**Finding 1 (client-side cumulative merge):**

- Create `apps/web/lib/engine/mirror-merge.ts` — pure, testable cumulative-merge core: the per-matter tokenized accumulator type and `mergeIntoAccumulator()` (opens the prior sealed vault, appends the new document's entries, reseals; concatenates tokenized pii/chunks). No plaintext at rest.
- Create `apps/web/lib/engine/mirror-merge.test.ts` — proves both documents' pii/chunks survive a merge and the resealed vault opens to all entries.
- Modify `packages/wasm-pipeline/src/rag.ts` — add `appendIndex(matterId, items)` that loads the existing matter index if present and inserts into it (additive), instead of always starting fresh.
- Modify `apps/web/lib/engine/adapter.ts` — `ingestFolder` uses `appendIndex`, drives `mergeIntoAccumulator`, persists the accumulator, pushes the cumulative bundle, and stores a **per-document** mirror locally (for collision-free rehydrate + this-doc redacted text).
- Modify `apps/web/app/folders/[id]/FolderView.tsx` — `onFilesAccepted` processes files **sequentially** (not `Promise.all`) so each ingest builds on the previous committed accumulator.
- Create `apps/web/e2e/fixtures/contract-note-2.csv` — a second fixture with distinct PII.
- Modify `apps/web/e2e/critical-path.spec.ts` — upload a second file into the same folder and assert both documents' redacted content/PII survive.
- (Optional) Modify `services/mcp-server/src/mirror.test.ts` (create if absent) — a regression test documenting that `saveMirror` replaces the whole matter dir (the constraint that forces client-side merge).

**Finding 2 (citation deep-link):**

- Create `apps/web/lib/citation-target.ts` — pure `parseCitationTarget(params)` → `{ page?, bbox? }` with validation.
- Create `apps/web/lib/citation-target.test.ts` — parser unit tests (valid, missing, malformed).
- Modify `apps/web/app/documents/[id]/DocumentView.tsx` — read `useSearchParams`, parse, pass a `citationTarget` prop down.
- Modify `apps/web/components/DocumentDualView.tsx` — accept `citationTarget`, forward to `DocumentRouter`.
- Modify `apps/web/components/document-router.tsx` — accept `citationTarget`; for the `pdf` branch, pass it to `PDFViewer` (ref + overlay); other branches ignore it.

---

## Interfaces (shared signatures used across tasks)

```ts
// packages/core BoundingBox (existing): { x: number; y: number; w: number; h: number }  // PDF-point corners: x,y top-left, w,h size

// apps/web/lib/engine/mirror-merge.ts
import type { RedactionEntry } from "@xberg-io/wasm-pipeline-real";
export interface MirrorPiiSpan { doc_id: string; kind: string; start: number; end: number; token: string; ciphertext?: string }
export interface MirrorChunk { doc_id: string; chunk_index: number; text: string; page?: number; bbox?: { x: number; y: number; w: number; h: number }; score: number; citation: string }
export interface MatterMirrorAccumulator { pii: MirrorPiiSpan[]; chunks: MirrorChunk[]; vaultCipher: number[]; vaultSalt: number[] }
export function accumulatorKey(matterId: string): string;                       // "xberg:matter-mirror:<id>"
export async function mergeIntoAccumulator(
  prior: MatterMirrorAccumulator | undefined,
  add: { entries: RedactionEntry[]; pii: MirrorPiiSpan[]; chunks: MirrorChunk[] },
  passphrase: string,
): Promise<MatterMirrorAccumulator>;

// packages/wasm-pipeline/src/rag.ts
export async function appendIndex(matterId: string, items: IndexedChunk[]): Promise<EdgeVec>;  // additive: load-or-create, insert, save

// apps/web/lib/citation-target.ts
import type { BoundingBox } from "@xberg-io/core";
export interface CitationTarget { page?: number; bbox?: BoundingBox }
export function parseCitationTarget(params: URLSearchParams | { get(k: string): string | null }): CitationTarget;
```

---

## Task 1: Finding 1 — cumulative client-side mirror merge

**Files:**

- Create: `apps/web/lib/engine/mirror-merge.ts`, `apps/web/lib/engine/mirror-merge.test.ts`
- Modify: `packages/wasm-pipeline/src/rag.ts`, `apps/web/lib/engine/adapter.ts:85-185`, `apps/web/app/folders/[id]/FolderView.tsx:81-130`
- Create: `apps/web/e2e/fixtures/contract-note-2.csv`
- Modify: `apps/web/e2e/critical-path.spec.ts`

**Interfaces:**

- Consumes: `sealVault`, `openVault`, `RedactionEntry` from `@xberg-io/wasm-pipeline-real`; `get`/`set` from `idb-keyval`; existing `buildIndex`/`serializeIndex`/`loadIndex` from `rag.ts`.
- Produces: `mergeIntoAccumulator`, `accumulatorKey`, `MatterMirrorAccumulator` (Task 1 internal); `appendIndex` (used by adapter).

- [ ] **Step 1: Write the failing merge test**

Create `apps/web/lib/engine/mirror-merge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sealVault, openVault } from "@xberg-io/wasm-pipeline-real";
import { mergeIntoAccumulator, type MirrorPiiSpan, type MirrorChunk } from "./mirror-merge";

const PASS = "correct horse battery staple";

function entry(token: string, original: string, start: number) {
  return { token, original, category: "PERSON", kind: "PERSON", start, end: start + original.length };
}
function span(docId: string, token: string, start: number): MirrorPiiSpan {
  return { doc_id: docId, kind: "PERSON", start, end: start + 5, token };
}
function chunk(docId: string, i: number): MirrorChunk {
  return { doc_id: docId, chunk_index: i, text: `redacted ${docId} ${i}`, score: 1, citation: `${docId}#chunk-${i}` };
}

describe("mergeIntoAccumulator", () => {
  it("keeps both documents' pii + chunks and reseals a vault holding all entries", async () => {
    const a = await mergeIntoAccumulator(
      undefined,
      { entries: [entry("{{PERSON_1}}", "Alice", 0)], pii: [span("docA", "{{PERSON_1}}", 0)], chunks: [chunk("docA", 0)] },
      PASS,
    );
    const b = await mergeIntoAccumulator(
      a,
      { entries: [entry("{{PERSON_1}}", "Bob", 3)], pii: [span("docB", "{{PERSON_1}}", 3)], chunks: [chunk("docB", 0)] },
      PASS,
    );

    expect(b.pii.map((p) => p.doc_id).sort()).toEqual(["docA", "docB"]);
    expect(b.chunks.map((c) => c.doc_id).sort()).toEqual(["docA", "docB"]);

    const entries = await openVault(
      { cipher: Uint8Array.from(b.vaultCipher), salt: Uint8Array.from(b.vaultSalt) },
      PASS,
    );
    expect(entries.map((e) => e.original).sort()).toEqual(["Alice", "Bob"]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd /Volumes/ExtremeSSD/hacienda-private && TMPDIR=/Volumes/xbergtmp/ pnpm --filter web test -- mirror-merge`
Expected: FAIL — `mirror-merge` module not found.

- [ ] **Step 3: Implement `mirror-merge.ts`**

Create `apps/web/lib/engine/mirror-merge.ts`:

```ts
import { sealVault, openVault, type RedactionEntry } from "@xberg-io/wasm-pipeline-real";

export interface MirrorPiiSpan {
  doc_id: string;
  kind: string;
  start: number;
  end: number;
  token: string;
  ciphertext?: string;
}

export interface MirrorChunk {
  doc_id: string;
  chunk_index: number;
  text: string;
  page?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  score: number;
  citation: string;
}

// Per-matter cumulative mirror state kept in IndexedDB (idb-keyval). Tokenized only: `pii`/`chunks`
// carry redaction tokens, never plaintext, and the vault stays AES-GCM sealed at rest — merging a
// new document opens it in memory, appends, and reseals. This is the browser-owned source of truth
// the server can never reconstruct (it never imports edgevec and cannot reseal the vault).
export interface MatterMirrorAccumulator {
  pii: MirrorPiiSpan[];
  chunks: MirrorChunk[];
  vaultCipher: number[];
  vaultSalt: number[];
}

export function accumulatorKey(matterId: string): string {
  return `xberg:matter-mirror:${matterId}`;
}

export async function mergeIntoAccumulator(
  prior: MatterMirrorAccumulator | undefined,
  add: { entries: RedactionEntry[]; pii: MirrorPiiSpan[]; chunks: MirrorChunk[] },
  passphrase: string,
): Promise<MatterMirrorAccumulator> {
  const priorEntries = prior
    ? await openVault({ cipher: Uint8Array.from(prior.vaultCipher), salt: Uint8Array.from(prior.vaultSalt) }, passphrase)
    : [];
  const sealed = await sealVault([...priorEntries, ...add.entries], passphrase);
  return {
    pii: [...(prior?.pii ?? []), ...add.pii],
    chunks: [...(prior?.chunks ?? []), ...add.chunks],
    vaultCipher: Array.from(sealed.cipher),
    vaultSalt: Array.from(sealed.salt),
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd /Volumes/ExtremeSSD/hacienda-private && TMPDIR=/Volumes/xbergtmp/ pnpm --filter web test -- mirror-merge`
Expected: PASS.

- [ ] **Step 5: Add `appendIndex` to `rag.ts`**

In `packages/wasm-pipeline/src/rag.ts`, add after `buildIndex` (keep `buildIndex` as-is; `appendIndex` is the additive variant):

```ts
// Additive index build: load the matter's existing EdgeVec index if one is already persisted and
// insert the new chunks into it, so a second document in the same matter augments retrieval instead
// of replacing it (buildIndex starts fresh and would drop the earlier document's vectors).
export async function appendIndex(matterId: string, items: IndexedChunk[]): Promise<EdgeVec> {
  await ensureEdgeVec();
  let db: EdgeVec;
  try {
    db = await EdgeVecClass.load(dbName(matterId));
  } catch {
    const config = new EdgeVecConfig(EMBED_DIM);
    config.metric = "cosine";
    db = new EdgeVecClass(config);
  }
  for (const item of items) {
    const meta: Record<string, string | number> = {
      doc_id: item.docId,
      chunk_index: item.chunkIndex,
      text: item.text,
    };
    if (item.page !== undefined) meta["page"] = item.page;
    if (item.citation !== undefined) meta["citation"] = item.citation;
    if (item.bbox !== undefined) meta["bbox"] = JSON.stringify(item.bbox);
    db.insertWithMetadata(item.vector, meta);
  }
  await db.save(dbName(matterId));
  return db;
}
```

Then export it from `packages/wasm-pipeline/src/index.ts` alongside the other `rag` exports (find the existing `buildIndex, serializeIndex` export line and add `appendIndex`).

- [ ] **Step 6: Verify wasm-pipeline still builds/tests**

Run: `cd /Volumes/ExtremeSSD/hacienda-private && TMPDIR=/Volumes/xbergtmp/ pnpm --filter @xberg-io/wasm-pipeline test`
Expected: PASS (existing `mirror.test.ts` unaffected; no new unit test for `appendIndex` — edgevec wasm isn't exercised in the node vitest env, so it's covered by the e2e two-file upload instead).

- [ ] **Step 7: Rewire `adapter.ts` `ingestFolder` to cumulative merge**

In `apps/web/lib/engine/adapter.ts`:

1. Add imports:

```ts
import { get, set } from "idb-keyval";
import { appendIndex, sealVault, openVault } from "@xberg-io/wasm-pipeline-real"; // sealVault/openVault already used elsewhere? add appendIndex to the existing import block
import { mergeIntoAccumulator, accumulatorKey, type MatterMirrorAccumulator, type MirrorChunk } from "./mirror-merge";
```

(`sealVault` is already imported in the existing `@xberg-io/wasm-pipeline-real` block; add `appendIndex` there. `openVault` is already imported for `rehydrateSpanForUi`.)

2. Replace the index build + push section (currently `const db = await buildIndex(...)` through `await pushMirror(...)`, lines ~134-155) with:

```ts
  const docId = ctx.docId ?? ctx.folder.id;
  // ...existing item/entry loop stays unchanged, producing `items` and `allEntries`...

  // Additive retrieval index: augment the matter's existing EdgeVec index rather than replacing it.
  const db = await appendIndex(ctx.matter.id, items);
  const indexBytes = await serializeIndex(db);

  const thisPii = mirrorPiiSpans(items, allEntries);
  const thisChunks: MirrorChunk[] = items.map((it, i) => ({
    doc_id: it.docId,
    chunk_index: it.chunkIndex,
    text: it.text,
    page: it.page,
    bbox: it.bbox,
    score: 1 - i * 0.01,
    citation: it.citation ?? "",
  }));

  // Cumulative server bundle: merge this document's tokenized pii/chunks + vault entries into the
  // matter accumulator, then push the FULL matter state (server saveMirror replaces the whole matter
  // dir, so every push must carry everything). Sequential upload (FolderView) makes this race-free.
  const prior = await get<MatterMirrorAccumulator>(accumulatorKey(ctx.matter.id));
  const merged = await mergeIntoAccumulator(
    prior,
    { entries: allEntries, pii: thisPii, chunks: thisChunks },
    ctx.passphrase,
  );
  await set(accumulatorKey(ctx.matter.id), merged);

  const cumulativePayload = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      index: Array.from(indexBytes),
      vault: merged.vaultCipher,
      vaultSalt: merged.vaultSalt,
      pii: merged.pii,
      chunks: merged.chunks,
    }),
  );
  await pushMirror(ctx.matter, cumulativePayload, ctx.scopeToken);
  emit(ctx, name, name, "index", 1);

  // Per-document mirror stored locally (file-store): this document's OWN sealed vault + pii + chunks.
  // rehydrateSpanForUi matches spans by (kind,start,end) — cumulative entries from several documents
  // could collide on those, so local rehydrate and this-document redacted text must use a per-doc
  // vault, not the matter-wide one. `index` is unused locally, kept empty.
  const docSealed = await sealVault(allEntries, ctx.passphrase);
  const docMirror = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      index: [],
      vault: Array.from(docSealed.cipher),
      vaultSalt: Array.from(docSealed.salt),
      pii: thisPii,
      chunks: thisChunks,
    }),
  );
```

3. Update the trailing `return { ... mirror: payload }` to `mirror: docMirror`, and drop the now-unused `payload`/`sealed` locals from the old block. Keep `pii` (PiiEntity[]) and `retrieved` as they were.

Note: `openVault` import stays (used by `rehydrateSpanForUi`); `sealVault` now used twice (accumulator via merge-merge internally, plus per-doc here).

- [ ] **Step 8: Make `FolderView` upload sequential**

In `apps/web/app/folders/[id]/FolderView.tsx`, replace the `await Promise.all(files.map(async (file, idx) => { … }))` block (lines ~86-127) with a sequential loop so each ingest sees the previous ingest's committed accumulator:

```ts
        for (const [idx, file] of files.entries()) {
          const uploadKey = `${file.name}-${idx}`;
          setUploads((prev) => ({ ...prev, [uploadKey]: { name: file.name, stage: "extract", progress: 0 } }));
          let docId: string | undefined;
          try {
            const content_hash = await sha256Hex(file);
            const doc = await createDocument(auth.token, folderId, { path: file.name, content_hash });
            docId = doc.id;
            await refresh();
            const result = await ingestFolder(file, {
              matter,
              folder,
              docId,
              scopeToken: auth.token,
              passphrase: auth.passphrase as string,
              onProgress: (p) =>
                setUploads((prev) => ({ ...prev, [uploadKey]: { name: file.name, stage: p.stage, progress: p.progress } })),
            });
            await saveOriginalFile(docId, file, result.pii, result.mirror);
            await updateDocumentStatus(auth.token, docId, {
              status: "done",
              pages: result.pages,
              chunk_count: result.chunks.length,
              pii_count: result.pii.length,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : "ingest failed";
            setUploads((prev) => ({ ...prev, [uploadKey]: { name: file.name, stage: "error", progress: 1, error: message } }));
            if (docId) {
              await updateDocumentStatus(auth.token, docId, { status: "error", error_message: message });
            }
          } finally {
            await refresh();
          }
        }
```

(Keep the surrounding `useCallback` signature, the `if (!auth?.passphrase || !folder) return;`, and the `matter` const unchanged. Preserve the index-key comment about name collisions.)

- [ ] **Step 9: Run the web unit tests**

Run: `cd /Volumes/ExtremeSSD/hacienda-private && TMPDIR=/Volumes/xbergtmp/ pnpm --filter web test`
Expected: PASS (mirror-merge + existing contract/auth/route-id tests). Fix any type drift surfaced by `contract.test.ts`.

- [ ] **Step 10: Add the second e2e fixture**

Create `apps/web/e2e/fixtures/contract-note-2.csv` mirroring the shape of `contract-note.csv` but with **distinct** PII (open the existing fixture first to match its columns; use a different name/email, e.g. `Mary Jones` / `mary.jones@example.com`).

- [ ] **Step 11: Extend the e2e to prove both documents survive**

In `apps/web/e2e/critical-path.spec.ts`, after the first upload's `PII entities` assertion and before the reveal step, add a second upload into the same folder and assert the first document still resolves:

```ts
  const FIXTURE_2 = path.join(__dirname, "fixtures", "contract-note-2.csv");
  const PII_NAME_2 = "Mary Jones";
  // Upload a second file into the SAME folder — the mirror must merge, not overwrite.
  await page.locator('input[type="file"]').setInputFiles(FIXTURE_2);
  await expect(page.getByText(/contract-note-2\.csv/)).toBeVisible({ timeout: 5 * 60_000 });
  await expect(page.getByText("Processing…")).not.toBeVisible();

  // Both documents remain reachable in the sidebar after the second upload committed.
  await nav.getByRole("button", { name: "Discovery" }).click();
  await expect(nav.getByRole("button", { name: /contract-note\.csv/ })).toBeVisible();
  await expect(nav.getByRole("button", { name: /contract-note-2\.csv/ })).toBeVisible();
```

(Place the `const nav = …` declaration before this block if the reveal step currently declares it later — hoist it. Keep the existing first-document redacted-text and reveal/forget assertions intact, running after this block.)

- [ ] **Step 12: (Optional) mcp-server regression test**

If `services/mcp-server/src/mirror.test.ts` does not exist, create a minimal test asserting `saveMirror` replaces prior state (documents the constraint). Skip if it inflates scope — the e2e is the load-bearing proof. Then run `pnpm --filter mcp-server test` to confirm the suite is green regardless.

- [ ] **Step 13: Full verification gate (exFAT)**

```text
cd /Volumes/ExtremeSSD/hacienda-private
ls /Volumes/xbergtmp >/dev/null || hdiutil attach /Volumes/ExtremeSSD/xbergtmp.sparseimage
ls -la apps/web/out   # if not a symlink, recreate .next/out per Global Constraints
TMPDIR=/Volumes/xbergtmp/ pnpm --filter mcp-server test
TMPDIR=/Volumes/xbergtmp/ pnpm --filter @xberg-io/wasm-pipeline test
TMPDIR=/Volumes/xbergtmp/ pnpm --filter web test
TMPDIR=/Volumes/xbergtmp/ pnpm --filter web typecheck
cd apps/web
TMPDIR=/Volumes/xbergtmp/ pnpm run build
PLAYWRIGHT_BROWSERS_PATH=/Volumes/ExtremeSSD/.cache/ms-playwright TMPDIR=/Volumes/xbergtmp/ pnpm exec playwright test
```

Expected: all green; e2e shows both documents present after the second upload.

- [ ] **Step 14: Purge AppleDouble + commit Finding 1**

```text
cd /Volumes/ExtremeSSD/hacienda-private
find . -maxdepth 4 -iname "._*" -not -path "*/node_modules/*" -delete
git status   # confirm only intended files staged; no ._* files
git add apps/web/lib/engine/mirror-merge.ts apps/web/lib/engine/mirror-merge.test.ts \
        packages/wasm-pipeline/src/rag.ts packages/wasm-pipeline/src/index.ts \
        apps/web/lib/engine/adapter.ts apps/web/app/folders/[id]/FolderView.tsx \
        apps/web/e2e/fixtures/contract-note-2.csv apps/web/e2e/critical-path.spec.ts
# add services/mcp-server/src/mirror.test.ts only if Step 12 was done
git commit -m "fix(web): merge matter mirror across uploads instead of overwriting

Multi-file uploads into one folder raced on Promise.all and the server's
saveMirror replaces the whole matter dir, so the last push clobbered earlier
documents' chunks/embeddings/PII. The server can't merge EdgeVec bytes or
reseal the vault, so merge client-side: make the EdgeVec index additive,
keep a per-matter tokenized accumulator with a re-sealable vault, push the
full cumulative bundle each ingest, and process the upload batch
sequentially. Store a per-document mirror locally for collision-free
rehydrate. Cover the two-file case in the e2e."
```

**Do not push.** Ask the user for explicit push confirmation.

---

## Task 2: Finding 2 — citation `page`/`bbox` deep-link reaches the viewer

**Files:**

- Create: `apps/web/lib/citation-target.ts`, `apps/web/lib/citation-target.test.ts`
- Modify: `apps/web/app/documents/[id]/DocumentView.tsx`, `apps/web/components/DocumentDualView.tsx`, `apps/web/components/document-router.tsx`

**Interfaces:**

- Consumes: `RetrievedChunkCard`'s existing param format — `page` = `String(chunk.page)` (integer), `bbox` = `JSON.stringify({x,y,w,h})` (PDF-point corners). `PDFViewerHandle.scrollToPageArea(pageNumber, { top, left?, width?, height? })` and `renderPageOverlay({ pageNumber, pageWidth, pageHeight, scale, rotation })` from `apps/web/components/ui/pdf-viewer.tsx`.
- Produces: `parseCitationTarget`, `CitationTarget` (used by DocumentView → DualView → Router).

- [ ] **Step 1: Write the failing parser test**

Create `apps/web/lib/citation-target.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCitationTarget } from "./citation-target";

function sp(entries: Record<string, string>) {
  return new URLSearchParams(entries);
}

describe("parseCitationTarget", () => {
  it("parses a valid page + bbox", () => {
    const t = parseCitationTarget(sp({ page: "3", bbox: JSON.stringify({ x: 10, y: 20, w: 30, h: 40 }) }));
    expect(t).toEqual({ page: 3, bbox: { x: 10, y: 20, w: 30, h: 40 } });
  });
  it("returns empty when params are absent", () => {
    expect(parseCitationTarget(sp({}))).toEqual({});
  });
  it("ignores a non-positive or non-integer page", () => {
    expect(parseCitationTarget(sp({ page: "0" }))).toEqual({});
    expect(parseCitationTarget(sp({ page: "abc" }))).toEqual({});
  });
  it("ignores malformed or non-numeric bbox without throwing", () => {
    expect(parseCitationTarget(sp({ bbox: "not json" }))).toEqual({});
    expect(parseCitationTarget(sp({ bbox: JSON.stringify({ x: "a", y: 1, w: 2, h: 3 }) }))).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd /Volumes/ExtremeSSD/hacienda-private && TMPDIR=/Volumes/xbergtmp/ pnpm --filter web test -- citation-target`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `citation-target.ts`**

Create `apps/web/lib/citation-target.ts`:

```ts
import type { BoundingBox } from "@xberg-io/core";

export interface CitationTarget {
  page?: number;
  bbox?: BoundingBox;
}

function parseBbox(raw: string | null): BoundingBox | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const nums = ["x", "y", "w", "h"].map((k) => v[k]);
    if (nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
      const [x, y, w, h] = nums as number[];
      return { x, y, w, h };
    }
  } catch {
    /* malformed bbox param — ignore, viewer opens normally */
  }
  return undefined;
}

// Reads the citation deep-link params emitted by RetrievedChunkCard (`page`, `bbox`). Both are
// optional and independently validated; anything malformed is dropped so the viewer still opens.
export function parseCitationTarget(params: URLSearchParams | { get(k: string): string | null }): CitationTarget {
  const target: CitationTarget = {};
  const pageRaw = params.get("page");
  if (pageRaw !== null) {
    const page = Number(pageRaw);
    if (Number.isInteger(page) && page > 0) target.page = page;
  }
  const bbox = parseBbox(params.get("bbox"));
  if (bbox) target.bbox = bbox;
  return target;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd /Volumes/ExtremeSSD/hacienda-private && TMPDIR=/Volumes/xbergtmp/ pnpm --filter web test -- citation-target`
Expected: PASS.

- [ ] **Step 5: Read the target params in `DocumentView` and pass them down**

In `apps/web/app/documents/[id]/DocumentView.tsx`:

1. Add imports: `import { useSearchParams } from "next/navigation";` and `import { parseCitationTarget } from "@/lib/citation-target";`.
2. Inside the component: `const searchParams = useSearchParams();` and `const citationTarget = parseCitationTarget(searchParams);`.
3. Pass to the dual view:

```tsx
<DocumentDualView
  mimeType={stored.mimeType}
  fileName={stored.fileName}
  src={src}
  textContent={textContent}
  redactedText={redactedTextFromMirror(stored.mirror)}
  citationTarget={citationTarget}
/>
```

- [ ] **Step 6: Forward `citationTarget` through `DocumentDualView`**

In `apps/web/components/DocumentDualView.tsx`:

1. Extend props: add `import type { CitationTarget } from "@/lib/citation-target";` and `citationTarget?: CitationTarget;` to `DocumentDualViewProps`.
2. Destructure `citationTarget` and pass it to `DocumentRouter`:

```tsx
<DocumentRouter mimeType={mimeType} fileName={fileName} src={src} textContent={textContent} citationTarget={citationTarget} />
```

- [ ] **Step 7: Wire the PDF branch in `document-router.tsx`**

In `apps/web/components/document-router.tsx`:

1. Add `import { useRef, useEffect } from "react";`, `import type { CitationTarget } from "@/lib/citation-target";`, and `import type { PDFViewerHandle } from "@/components/ui/pdf-viewer";`.
2. Add `citationTarget?: CitationTarget;` to `DocumentRouterProps` and destructure it.
3. Replace the `case "pdf":` return with a dedicated component that owns the ref + overlay so hooks are legal:

```tsx
    case "pdf":
      return <PdfWithCitation src={src} fileName={fileName} citationTarget={citationTarget} />;
```

4. Add the component to the file:

```tsx
function PdfWithCitation({
  src,
  fileName,
  citationTarget,
}: {
  src: string;
  fileName: string;
  citationTarget?: CitationTarget;
}) {
  const viewerRef = useRef<PDFViewerHandle>(null);

  useEffect(() => {
    const page = citationTarget?.page;
    if (!page) return;
    // The engine reports bbox in PDF-point corners (x,y top-left). scrollToPageArea's `top`/`left`
    // are page-relative offsets in the same space; width/height frame the cited region. Absent bbox
    // → scroll to the page top. Retry briefly: the viewport may not be laid out on first paint.
    const bbox = citationTarget?.bbox;
    const area = bbox ? { top: bbox.y, left: bbox.x, width: bbox.w, height: bbox.h } : { top: 0 };
    let tries = 0;
    const timer = setInterval(() => {
      viewerRef.current?.scrollToPageArea(page, area);
      if (viewerRef.current?.getViewportElement() || ++tries >= 10) clearInterval(timer);
    }, 150);
    return () => clearInterval(timer);
  }, [citationTarget?.page, citationTarget?.bbox]);

  return (
    <PDFViewer
      ref={viewerRef}
      src={src}
      fileName={fileName}
      renderPageOverlay={({ pageNumber, scale }) =>
        citationTarget?.bbox && citationTarget.page === pageNumber ? (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-sm bg-blue-500/20 ring-2 ring-blue-500/70"
            style={{
              left: citationTarget.bbox.x * scale,
              top: citationTarget.bbox.y * scale,
              width: citationTarget.bbox.w * scale,
              height: citationTarget.bbox.h * scale,
            }}
          />
        ) : null
      }
    />
  );
}
```

(Non-PDF branches ignore `citationTarget`; no other change needed. Confirm `PDFViewer` is exported as a `forwardRef` accepting `ref` — it is, per `pdf-viewer.tsx:2311`. Verify the `scale`→overlay mapping against `e-signature.tsx`'s overlay during the manual check; if the engine's `pageWidth`/`scale` relationship differs, adjust the multiplier there.)

- [ ] **Step 8: Typecheck + unit tests**

Run:

```text
cd /Volumes/ExtremeSSD/hacienda-private
TMPDIR=/Volumes/xbergtmp/ pnpm --filter web typecheck
TMPDIR=/Volumes/xbergtmp/ pnpm --filter web test
```

Expected: PASS. Resolve any prop-type mismatches surfaced by threading `citationTarget`.

- [ ] **Step 9: Build**

Run: `cd /Volumes/ExtremeSSD/hacienda-private/apps/web && TMPDIR=/Volumes/xbergtmp/ pnpm run build`
Expected: successful static export (recreate `.next`/`out` symlinks first if needed).

- [ ] **Step 10: Manual browser deep-link check**

Ingest a **PDF** into a folder, open its document, then visit `/documents/<id>?page=2&bbox=%7B%22x%22%3A50%2C%22y%22%3A80%2C%22w%22%3A120%2C%22h%22%3A30%7D` (URL-encoded `{"x":50,"y":80,"w":120,"h":30}`). Confirm: the viewer scrolls to page 2 and a highlight box renders over the cited region; visiting the same document with no params opens normally with no highlight and no console errors. (Also click a citation from the search/RAG results `RetrievedChunkCard` to confirm the real end-to-end link.) e2e for this path is optional — the current e2e fixture is CSV, which has no page/bbox concept.

- [ ] **Step 11: Purge AppleDouble + commit Finding 2**

```text
cd /Volumes/ExtremeSSD/hacienda-private
find . -maxdepth 4 -iname "._*" -not -path "*/node_modules/*" -delete
git status
git add apps/web/lib/citation-target.ts apps/web/lib/citation-target.test.ts \
        apps/web/app/documents/[id]/DocumentView.tsx \
        apps/web/components/DocumentDualView.tsx apps/web/components/document-router.tsx
git commit -m "fix(web): open cited page and highlight bbox from citation deep-links

RetrievedChunkCard linked to /documents/[id]?page=&bbox= but DocumentView
never read the params, so citations always opened at the document top. Parse
and validate them, thread a CitationTarget through DocumentDualView and
DocumentRouter, and drive the PDF viewer's scrollToPageArea plus a bbox
highlight overlay. Missing or malformed params fall back to normal opening."
```

**Do not push.** Ask the user for explicit push confirmation.

---

## Self-Review

**Spec coverage:**

- Finding 1 steps 1-4 (read mirror/ingest semantics → decide approach → add multi-file test → run all suites + build/e2e): covered — investigation done in-plan, approach = full cumulative client-side merge, Task 1 Steps 1/11 add unit + e2e coverage, Step 13 runs every suite.
- Finding 2 steps 1-5 (find param format → read params in DocumentView → forward to viewer → handle missing/invalid → test/typecheck/build): covered by Task 2 Steps 1-11.
- Commit style (one per finding, `fix(web):`, no AI attribution) + push-gating: covered in Global Constraints and each commit step.
- exFAT environment handling: covered in Global Constraints and every build/e2e/verify step.

**Placeholder scan:** none — all code steps show complete code; commands show expected output.

**Type consistency:** `MatterMirrorAccumulator`, `MirrorPiiSpan`, `MirrorChunk`, `mergeIntoAccumulator`, `accumulatorKey`, `appendIndex`, `CitationTarget`, `parseCitationTarget`, `PDFViewerHandle.scrollToPageArea`/`renderPageOverlay` are used consistently across tasks and match the verified source signatures.

**Known residual (not in scope):** the *server-side* cumulative vault stores entries from multiple documents that could share `(kind,start,end)`; the MCP rehydration path (not the web UI, which uses the per-document local mirror) could in principle mismatch. Documented, not fixed here — flag if the MCP path later needs doc-scoped vault lookup.
