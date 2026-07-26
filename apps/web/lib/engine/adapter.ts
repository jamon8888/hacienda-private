import { get, set } from "idb-keyval";
import type { Matter, Folder, PiiEntity, RetrievedChunk } from "@xberg-io/core";
import type { RedactionEntry } from "@xberg-io/wasm-pipeline-real";

import {
  extractDocument,
  firstDocument,
  defaultExtractionConfig,
  withTesseractOcr,
  withChunking,
  chunkExtraction,
  chunkCitation,
  chunkPage,
  chunkBoundingBox,
  embedChunks,
  embedQuery,
  retrieve,
  detectPii,
  listPiiTypes,
  buildRedaction,
  redactDocument,
  rehydrate,
  sealVault,
  openVault,
  appendIndex,
  replaceDocChunks,
  loadPersistedChunks,
  serializeIndex,
  pushMirror,
  serializeMirrorToBytes,
  detectCapabilities,
  selectScenario,
  EMBED_DIM,
  type IndexedChunk,
} from "@xberg-io/wasm-pipeline-real";
import {
  mergeIntoAccumulator,
  accumulatorKey,
  type MatterMirrorAccumulator,
  type MirrorChunk,
  type MirrorPiiSpan,
} from "./mirror-merge";

export interface ExtractedDocument {
  doc_id: string;
  name: string;
  text: string;
  pages: number;
  pii: PiiEntity[];
}

export interface IngestProgress {
  doc_id: string;
  name: string;
  stage: "extract" | "ocr" | "chunk" | "embed" | "pii" | "index" | "done" | "error";
  progress: number;
}

export interface IngestResult {
  doc_id: string;
  name: string;
  text: string;
  pages: number;
  pii: PiiEntity[];
  chunks: RetrievedChunk[];
  mirror: Uint8Array;
}

export interface IngestContext {
  matter: Matter;
  folder: Folder;
  // The server-assigned Document id (from createDocument), used to key mirror chunks/pii spans
  // and citations so RAG results and PII-review deep-links route to the right document. Falls
  // back to folder.id when omitted, for callers that haven't registered a Document row yet.
  docId?: string;
  scopeToken: string;
  passphrase: string;
  onProgress?: (p: IngestProgress) => void;
}

function emit(ctx: IngestContext, name: string, docId: string, stage: IngestProgress["stage"], progress: number) {
  ctx.onProgress?.({ doc_id: docId, name, stage, progress });
}

// Serializes read-modify-write access to a matter's accumulator + retrieval index (both mutated
// together by ingestFolder and reviewAndRepush) so two operations racing on the same matter — two
// documents reviewed close together, a review racing an in-flight ingest, two browser tabs — can't
// each read the same prior state and clobber each other's write. Falls back to running the callback
// directly where the Web Locks API is unavailable (e.g. the test environment); that's an acceptable
// gap since there's no real concurrency to guard against there.
async function withMatterLock<T>(matterId: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return fn();
  return locks.request(`xberg-matter-mirror:${matterId}`, fn);
}

function mirrorPiiSpans(
  items: IndexedChunk[],
  allEntries: { kind: string; start: number; end: number; token: string }[],
) {
  return allEntries.map((e) => ({
    doc_id: items[0]?.docId ?? "",
    kind: e.kind,
    start: e.start,
    end: e.end,
    token: e.token,
  }));
}

export async function ingestFolder(file: File, ctx: IngestContext): Promise<IngestResult> {
  const name = file.name;
  emit(ctx, name, name, "extract", 0.05);

  const base = await defaultExtractionConfig();
  const ocrConfig = await withTesseractOcr(base, "tesseract");
  const profile = await detectCapabilities();
  const scenario = selectScenario(profile);
  const config = await withChunking(ocrConfig, {
    maxCharacters: scenario.chunkSize,
    chunkerType: "markdown",
  });

  const result = await extractDocument(file, config);
  const doc = firstDocument(result);
  if (!doc) throw new Error(`no document extracted from ${name}`);
  emit(ctx, name, name, "ocr", 0.2);

  const piiTypes = listPiiTypes();
  const chunks = chunkExtraction(doc);
  emit(ctx, name, name, "chunk", 0.4);

  const vectors = await embedChunks(chunks.map((c) => ({ text: c.content })));
  emit(ctx, name, name, "embed", 0.6);

  const docId = ctx.docId ?? ctx.folder.id;
  const items: IndexedChunk[] = [];
  const allEntries: RedactionEntry[] = [];
  for (const [i, c] of chunks.entries()) {
    const v = vectors[i];
    if (!v) continue;
    const pii = await detectPii(c.content, piiTypes, scenario);
    const { redacted, entries } = buildRedaction(c.content, pii, `C${i}`, docId);
    for (const e of entries) allEntries.push(e);
    items.push({
      docId,
      chunkIndex: c.metadata.chunkIndex,
      text: redacted,
      page: chunkPage(c),
      citation: chunkCitation(docId, c),
      bbox: chunkBoundingBox(doc, c),
      vector: v,
    });
  }
  emit(ctx, name, name, "pii", 0.8);

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

  // Fetch-merge-push is one read-modify-write critical section over this matter's accumulator +
  // retrieval index; withMatterLock keeps it atomic against a concurrent ingest or review of
  // another document in the same matter (see withMatterLock's own comment).
  await withMatterLock(ctx.matter.id, async () => {
    // Fetch the matter accumulator up-front: its presence is the authoritative signal of whether a
    // prior ingest already persisted this matter's EdgeVec index (index + accumulator are written
    // together per matter). appendIndex must not probe via EdgeVec.load(), which hangs instead of
    // rejecting when no index exists yet. Reused below for mergeIntoAccumulator (no second read).
    const prior = await get<MatterMirrorAccumulator>(accumulatorKey(ctx.matter.id));

    // Additive retrieval index: augment the matter's existing EdgeVec index rather than replacing it.
    const db = await appendIndex(ctx.matter.id, items, prior !== undefined);
    const indexBytes = await serializeIndex(db);

    // Cumulative server bundle: merge this document's tokenized pii/chunks + vault entries into the
    // matter accumulator, then push the FULL matter state (server saveMirror replaces the whole
    // matter dir, so every push must carry everything).
    const merged = await mergeIntoAccumulator(
      prior,
      { entries: allEntries, pii: thisPii, chunks: thisChunks },
      ctx.passphrase,
    );
    await set(accumulatorKey(ctx.matter.id), merged);

    // Cumulative server bundle: version 2, matching services/mcp-server/src/mirror.ts's parseBundle
    // (server saveMirror replaces the whole matter dir, so every push must carry everything).
    const cumulativePayload = serializeMirrorToBytes(
      indexBytes,
      Uint8Array.from(merged.vaultCipher),
      Uint8Array.from(merged.vaultSalt),
      merged.pii,
      merged.chunks,
    );
    await pushMirror(ctx.matter.id, cumulativePayload, ctx.scopeToken);
  });
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

  const pii: PiiEntity[] = allEntries.map((e) => ({
    kind: e.kind,
    start: e.start,
    end: e.end,
    text: e.token,
  }));

  const retrieved: RetrievedChunk[] = items.map((it) => ({
    doc_id: it.docId,
    chunk_index: it.chunkIndex,
    text: it.text,
    score: 1,
    citation: it.citation ?? "",
    page: it.page,
    bbox: it.bbox,
  }));

  emit(ctx, name, name, "done", 1);
  return {
    doc_id: name,
    name,
    text: doc.content ?? "",
    pages: doc.pages?.length ?? 1,
    pii,
    chunks: retrieved,
    mirror: docMirror,
  };
}

export async function extractDocumentForUi(file: File): Promise<ExtractedDocument> {
  const base = await defaultExtractionConfig();
  const config = await withTesseractOcr(base, "tesseract");
  const result = await extractDocument(file, config);
  const doc = firstDocument(result);
  if (!doc) throw new Error(`no document extracted from ${file.name}`);
  const pii = await detectPii(doc.content ?? "", listPiiTypes(), selectScenario(await detectCapabilities()));
  return {
    doc_id: file.name,
    name: file.name,
    text: doc.content ?? "",
    pages: doc.pages?.length ?? 1,
    pii,
  };
}

export async function queryRagForUi(matter: Matter, query: string, topK = 8): Promise<RetrievedChunk[]> {
  const vec = await embedQuery(query);
  return retrieve(matter.id, vec, topK, query);
}

export async function redactDocumentForUi(
  text: string,
  pii: PiiEntity[],
  passphrase: string,
): Promise<{ redacted: string; entries: unknown[] }> {
  return redactDocument(text, pii, passphrase);
}

// Reveals the plaintext behind one masked PII span, gated by the matter's passphrase. `mirror` is
// the same payload bytes `ingestFolder` produced (IngestResult.mirror) — it carries the sealed
// vault (`vault` + `vaultSalt`) that `sealVault`/`openVault` round-trip through PBKDF2+AES-GCM.
// `redactDocumentForUi` does NOT do this — it redacts (builds a new sealed vault), it never
// decrypts one. There is no "already open" plaintext to read here: `openVault` decrypts the whole
// entries array once per call, so the matching span is looked up by (kind, start, end) — the same
// stable identity PiiEntity carries — rather than by an index into a live array.
export async function rehydrateSpanForUi(
  mirror: Uint8Array,
  span: Pick<PiiEntity, "kind" | "start" | "end">,
  passphrase: string,
): Promise<string> {
  const parsed = JSON.parse(new TextDecoder().decode(mirror)) as {
    vault: number[];
    vaultSalt: number[];
  };
  if (!Array.isArray(parsed.vault) || !Array.isArray(parsed.vaultSalt)) {
    throw new Error("this document's cached mirror is missing vault data — please re-ingest it");
  }
  const entries = await openVault(
    {
      cipher: Uint8Array.from(parsed.vault),
      salt: Uint8Array.from(parsed.vaultSalt),
    },
    passphrase,
  );
  const match = entries.find((e) => e.kind === span.kind && e.start === span.start && e.end === span.end);
  if (!match) throw new Error("no matching PII entry for this span");
  return match.original;
}

// Redaction tokens are minted per-chunk as `{{C<chunkIndex>_<CATEGORY>_<n>}}` (buildRedaction is
// called with prefix `C${chunkIndex}` above and in reviewAndRepush below). Parsing it back out is
// the only way to locate which chunk a given PII span belongs to — PiiEntity/RedactionEntry carry
// no chunk id directly. Shared with PiiReviewPanel.tsx, which uses it for the same reason.
export function chunkIndexFromToken(token: string): number | null {
  const match = /^\{\{C(\d+)_/.exec(token);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

export interface ReviewDecision {
  // Redaction tokens (e.g. "{{C0_PERSON_1}}", matching PiiReviewPanel's fieldKey — PiiEntity.text
  // is always the token) of spans the reviewer marked as false positives — these are un-redacted
  // (dropped from the PII list) rather than kept. Tokens are chunk-prefixed so they're unique
  // across the whole document; a plain "<kind>-<start>-<end>" key is NOT, since start/end are
  // chunk-local and could collide between two different chunks' spans.
  rejectedKeys: string[];
  // Missed spans the reviewer found still in plain text. When chunkIndex/start/end are given
  // (e.g. from a real text-selection UI, which already knows exactly where the selection is),
  // they're used directly against that chunk's reconstructed original text — no searching. When
  // omitted, falls back to matching by exact substring against each chunk's reconstructed original
  // text in chunk order, first match wins — good enough for a manually-typed correction without
  // requiring the reviewer to pinpoint a chunk/offset by hand.
  newSpans: { text: string; kind: string; chunkIndex?: number; start?: number; end?: number }[];
}

export interface ReviewContext {
  matterId: string;
  scopeToken: string;
  passphrase: string;
}

export interface ReviewResult {
  pii: PiiEntity[];
  mirror: Uint8Array;
  // newSpans entries whose text couldn't be located in any of this document's chunks.
  unappliedSpans: string[];
}

interface StoredMirror {
  vault: number[];
  vaultSalt: number[];
  pii: MirrorPiiSpan[];
  chunks: MirrorChunk[];
}

// Reconstructs a document's true original text from its sealed vault + currently-redacted chunk
// text, applies the reviewer's corrections (drop rejected spans, add missed ones), re-redacts, and
// pushes the result exactly the way ingestFolder does: reseal this doc's vault, replace its rows
// in the matter's live retrieval index (EdgeVec has no in-place update, so this is a rebuild with
// this doc's chunks swapped), replace its contribution in the matter accumulator, and push the
// cumulative mirror. Deterministic and re-extraction-free: `rehydrate` is the exact inverse of
// `buildRedaction`, so no OCR/extraction nondeterminism risk from re-running the pipeline.
export async function reviewAndRepush(
  docId: string,
  mirror: Uint8Array,
  ctx: ReviewContext,
  decision: ReviewDecision,
): Promise<ReviewResult> {
  const parsed = JSON.parse(new TextDecoder().decode(mirror)) as StoredMirror;
  if (!Array.isArray(parsed.vault) || !Array.isArray(parsed.vaultSalt)) {
    throw new Error("this document's cached mirror is missing vault data — please re-ingest it");
  }
  const entries = await openVault(
    { cipher: Uint8Array.from(parsed.vault), salt: Uint8Array.from(parsed.vaultSalt) },
    ctx.passphrase,
  );

  const remainingNewSpans = [...decision.newSpans];
  const freshEntries: RedactionEntry[] = [];
  const newChunks: MirrorChunk[] = [];
  const newPii: MirrorPiiSpan[] = [];

  for (const chunk of parsed.chunks) {
    const chunkEntries = entries.filter((e) => chunkIndexFromToken(e.token) === chunk.chunk_index);
    const originalText = rehydrate(chunk.text, chunkEntries);

    const survivors: PiiEntity[] = chunkEntries
      .filter((e) => !decision.rejectedKeys.includes(e.token))
      .map((e) => ({ kind: e.kind, start: e.start, end: e.end, text: originalText.slice(e.start, e.end) }));

    // Precise spans (chunkIndex/start/end all given) are applied first, directly, for this chunk
    // only — no searching, no ambiguity. Only falls through to the indexOf search below if the
    // given offsets don't actually land inside this chunk's text or overlap an existing span.
    for (let i = remainingNewSpans.length - 1; i >= 0; i--) {
      const span = remainingNewSpans[i];
      if (!span || span.chunkIndex !== chunk.chunk_index || span.start === undefined || span.end === undefined) {
        continue;
      }
      const { start, end } = span;
      if (start < 0 || end > originalText.length || start >= end) continue;
      const overlaps = survivors.some((s) => start < s.end && end > s.start);
      if (overlaps) continue;
      survivors.push({ kind: span.kind, start, end, text: originalText.slice(start, end) });
      remainingNewSpans.splice(i, 1);
    }

    // Substring-search fallback for spans with no (or invalid) precise coordinates. Still scoped
    // to the span's declared chunkIndex when given, so a bad precise span never silently lands in
    // the wrong chunk via a coincidental text match — only chunkIndex-less callers search freely.
    for (let i = remainingNewSpans.length - 1; i >= 0; i--) {
      const span = remainingNewSpans[i];
      if (!span || (span.chunkIndex !== undefined && span.chunkIndex !== chunk.chunk_index)) continue;
      const idx = originalText.indexOf(span.text);
      if (idx === -1) continue;
      const end = idx + span.text.length;
      const overlaps = survivors.some((s) => idx < s.end && end > s.start);
      if (overlaps) continue;
      survivors.push({ kind: span.kind, start: idx, end, text: span.text });
      remainingNewSpans.splice(i, 1);
    }

    const { redacted, entries: chunkEntriesFresh } = buildRedaction(
      originalText,
      survivors,
      `C${chunk.chunk_index}`,
      docId,
    );
    freshEntries.push(...chunkEntriesFresh);
    newChunks.push({ ...chunk, doc_id: docId, text: redacted });
    for (const e of chunkEntriesFresh) {
      newPii.push({ doc_id: docId, kind: e.kind, start: e.start, end: e.end, token: e.token });
    }
  }

  const unappliedSpans = remainingNewSpans.map((s) => s.text);

  const sealed = await sealVault(freshEntries, ctx.passphrase);
  const docMirror = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      index: [],
      vault: Array.from(sealed.cipher),
      vaultSalt: Array.from(sealed.salt),
      pii: newPii,
      chunks: newChunks,
    }),
  );

  // Replacing this doc's rows in the retrieval index and its contribution in the matter
  // accumulator is one read-modify-write critical section; withMatterLock keeps it atomic against
  // a concurrent ingest or another document's review landing on the same matter (see
  // withMatterLock's own comment).
  await withMatterLock(ctx.matterId, async () => {
    // The corrected chunks' embedding vectors don't change (re-redaction is a small text edit, not
    // worth re-embedding) — carry over each chunk's existing vector from the persisted index.
    const persisted = await loadPersistedChunks(ctx.matterId);
    const priorItems = persisted.filter((c) => c.docId === docId);
    const updatedItems: IndexedChunk[] = newChunks.map((c) => {
      const priorItem = priorItems.find((p) => p.chunkIndex === c.chunk_index);
      return {
        docId,
        chunkIndex: c.chunk_index,
        text: c.text,
        page: c.page,
        citation: c.citation,
        bbox: c.bbox,
        vector: priorItem?.vector ?? new Float32Array(EMBED_DIM),
      };
    });
    const db = await replaceDocChunks(ctx.matterId, docId, updatedItems);
    const indexBytes = await serializeIndex(db);

    const prior = await get<MatterMirrorAccumulator>(accumulatorKey(ctx.matterId));
    const merged = await mergeIntoAccumulator(
      prior,
      { entries: freshEntries, pii: newPii, chunks: newChunks },
      ctx.passphrase,
      docId,
    );
    await set(accumulatorKey(ctx.matterId), merged);

    const payload = serializeMirrorToBytes(
      indexBytes,
      Uint8Array.from(merged.vaultCipher),
      Uint8Array.from(merged.vaultSalt),
      merged.pii,
      merged.chunks,
    );
    await pushMirror(ctx.matterId, payload, ctx.scopeToken);
  });

  const pii: PiiEntity[] = freshEntries.map((e) => ({ kind: e.kind, start: e.start, end: e.end, text: e.token }));

  return { pii, mirror: docMirror, unappliedSpans };
}

export { warmupModels } from "@xberg-io/wasm-pipeline-real";
export type { WarmupProgress, WarmupResult } from "@xberg-io/wasm-pipeline-real";
