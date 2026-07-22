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
  sealVault,
  openVault,
  appendIndex,
  serializeIndex,
  pushMirror,
  detectCapabilities,
  selectScenario,
  type IndexedChunk,
} from "@xberg-io/wasm-pipeline-real";
import {
  mergeIntoAccumulator,
  accumulatorKey,
  type MatterMirrorAccumulator,
  type MirrorChunk,
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

  const vectors = await embedChunks(
    chunks.map((c) => ({ text: c.content })),
    scenario,
  );
  emit(ctx, name, name, "embed", 0.6);

  const docId = ctx.docId ?? ctx.folder.id;
  const items: IndexedChunk[] = [];
  const allEntries: RedactionEntry[] = [];
  for (const [i, c] of chunks.entries()) {
    const v = vectors[i];
    if (!v) continue;
    const pii = await detectPii(c.content, piiTypes, scenario);
    const { redacted, entries } = buildRedaction(c.content, pii, `C${i}`);
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

  // Fetch the matter accumulator up-front: its presence is the authoritative signal of whether a
  // prior ingest already persisted this matter's EdgeVec index (index + accumulator are written
  // together per matter). appendIndex must not probe via EdgeVec.load(), which hangs instead of
  // rejecting when no index exists yet. Reused below for mergeIntoAccumulator (no second read).
  const prior = await get<MatterMirrorAccumulator>(accumulatorKey(ctx.matter.id));

  // Additive retrieval index: augment the matter's existing EdgeVec index rather than replacing it.
  const db = await appendIndex(ctx.matter.id, items, prior !== undefined);
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
  return { doc_id: file.name, name: file.name, text: doc.content ?? "", pages: doc.pages?.length ?? 1, pii };
}

export async function queryRagForUi(matter: Matter, query: string, topK = 8): Promise<RetrievedChunk[]> {
  const scenario = selectScenario(await detectCapabilities());
  const vec = await embedQuery(query, scenario);
  return retrieve(matter.id, vec, topK);
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
    { cipher: Uint8Array.from(parsed.vault), salt: Uint8Array.from(parsed.vaultSalt) },
    passphrase,
  );
  const match = entries.find((e) => e.kind === span.kind && e.start === span.start && e.end === span.end);
  if (!match) throw new Error("no matching PII entry for this span");
  return match.original;
}
