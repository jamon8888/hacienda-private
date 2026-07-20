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

  const db = await buildIndex(ctx.matter.id, items);
  const indexBytes = await serializeIndex(db);
  const sealed = await sealVault(allEntries, ctx.passphrase);
  const payload = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      index: Array.from(indexBytes),
      vault: Array.from(sealed.cipher),
      vaultSalt: Array.from(sealed.salt),
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
  const entries = await openVault(
    { cipher: Uint8Array.from(parsed.vault), salt: Uint8Array.from(parsed.vaultSalt) },
    passphrase,
  );
  const match = entries.find((e) => e.kind === span.kind && e.start === span.start && e.end === span.end);
  if (!match) throw new Error("no matching PII entry for this span");
  return match.original;
}
