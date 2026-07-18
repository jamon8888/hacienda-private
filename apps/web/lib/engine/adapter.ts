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
  buildIndex,
  serializeIndex,
  pushMirror,
  detectCapabilities,
  selectScenario,
  type IndexedChunk,
} from "@xberg-io/wasm-pipeline-real";

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
  scopeToken: string;
  passphrase: string;
  onProgress?: (p: IngestProgress) => void;
}

function emit(ctx: IngestContext, name: string, docId: string, stage: IngestProgress["stage"], progress: number) {
  ctx.onProgress?.({ doc_id: docId, name, stage, progress });
}

function mirrorPiiSpans(items: IndexedChunk[], allEntries: { kind: string; start: number; end: number; token: string }[]) {
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

  const vectors = await embedChunks(chunks.map((c) => ({ text: c.content })), scenario);
  emit(ctx, name, name, "embed", 0.6);

  const items: IndexedChunk[] = [];
  const allEntries: RedactionEntry[] = [];
  for (const [i, c] of chunks.entries()) {
    const v = vectors[i];
    if (!v) continue;
    const pii = await detectPii(c.content, piiTypes, scenario);
    const { redacted, entries } = buildRedaction(c.content, pii, `C${i}`);
    for (const e of entries) allEntries.push(e);
    items.push({
      docId: ctx.folder.id,
      chunkIndex: c.metadata.chunkIndex,
      text: redacted,
      page: chunkPage(c),
      citation: chunkCitation(ctx.folder.id, c),
      bbox: chunkBoundingBox(doc, c),
      vector: v,
    });
  }
  emit(ctx, name, name, "pii", 0.8);

  const db = await buildIndex(ctx.matter.id, items);
  const indexBytes = await serializeIndex(db);
  const sealed = await sealVault(allEntries, ctx.passphrase);
  const payload = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      index: Array.from(indexBytes),
      vault: Array.from(sealed.cipher),
      pii: mirrorPiiSpans(items, allEntries),
      chunks: items.map((it, i) => ({
        doc_id: it.docId,
        chunk_index: it.chunkIndex,
        text: it.text,
        page: it.page,
        bbox: it.bbox,
        score: 1 - i * 0.01,
    citation: it.citation ?? "",
      })),
    }),
  );
  await pushMirror(ctx.matter, payload, ctx.scopeToken);
  emit(ctx, name, name, "index", 1);

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
    mirror: payload,
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
