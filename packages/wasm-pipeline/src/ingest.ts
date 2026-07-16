import type { Matter, Folder, PiiEntity } from "@xberg-io/core";
import { extractDocument, firstDocument } from "./runtime";
import { defaultExtractionConfig, withTesseractOcr } from "./ocr";
import { chunkExtraction, withChunking, chunkCitation, chunkPage, chunkBoundingBox } from "./chunk";
import { embedChunks } from "./embed";
import { detectPii } from "./ner";
import { buildIndex, serializeIndex, type IndexedChunk } from "./rag";
import { buildRedaction, sealVault, type RedactionEntry } from "./redact";
import { pushMirror, serializeMirrorToBytes } from "./mirror";

export interface IngestOptions {
  passphrase: string;
  scopeToken: string;
  maxCharacters?: number;
  language?: string[];
}

export async function ingestFolder(
  matter: Matter,
  folder: Folder,
  file: File | Uint8Array,
  options: IngestOptions,
): Promise<{ accepted: number }> {
  const base = await defaultExtractionConfig();
  const ocrConfig = await withTesseractOcr(base, "tesseract", options.language);
  const config = await withChunking(ocrConfig, {
    maxCharacters: options.maxCharacters ?? 1000,
    chunkerType: "markdown",
  });

  const result = await extractDocument(file, config);
  const doc = firstDocument(result);
  if (!doc) {
    return { accepted: 0 };
  }

  const chunks = chunkExtraction(doc);
  const vectors = await embedChunks(chunks.map((c) => ({ text: c.content })));

  const items: IndexedChunk[] = [];
  const allEntries: RedactionEntry[] = [];
  for (const [i, c] of chunks.entries()) {
    const v = vectors[i];
    if (!v) continue;
    const pii: PiiEntity[] = await detectPii(c.content);
    const { redacted, entries } = buildRedaction(c.content, pii, `C${i}`);
    for (const e of entries) allEntries.push(e);
    items.push({
      docId: folder.id,
      chunkIndex: c.metadata.chunkIndex,
      text: redacted,
      page: chunkPage(c),
      citation: chunkCitation(folder.id, c),
      bbox: chunkBoundingBox(doc, c),
      vector: v,
    });
  }

  const db = await buildIndex(matter.id, items);
  const indexBytes = await serializeIndex(db);
  const sealed = await sealVault(allEntries, options.passphrase);
  const payload = serializeMirrorToBytes(indexBytes, sealed.cipher);
  await pushMirror(matter, payload, options.scopeToken);

  return { accepted: items.length };
}
