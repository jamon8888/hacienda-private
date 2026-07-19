// packages/node-pipeline/src/ingest.ts
import type { Document, DocumentPiiEntity, IngestSource } from "@xberg-io/core";
import type { WalkedFile } from "./walk.js";

export interface ExtractedDoc {
  content: string;
  pageCount: number;
}

// Narrow, structural subset of MetadataStore — see the task note on why this
// is not imported from @xberg-io/mcp-server.
export interface DocumentStore {
  findDocumentByHash(folderId: string, contentHash: string): Document | undefined;
  createDocument(input: {
    folder_id: string;
    matter_id: string;
    path: string;
    content_hash: string;
    ingested_via: IngestSource;
  }): Document;
  updateDocumentStatus(
    id: string,
    status: Document["status"],
    fields?: { pages?: number; chunk_count?: number; pii_count?: number; error_message?: string },
  ): void;
  insertPiiEntities(
    documentId: string,
    entities: { kind: string; start: number; end: number; text: string }[],
  ): DocumentPiiEntity[];
  getDocument(id: string): Document | undefined;
}

// Narrow, structural subset of MirrorStore.
export interface MirrorSink {
  appendMirror(
    matterId: string,
    additions: {
      pii: { doc_id: string; kind: string; start: number; end: number; token: string }[];
      chunks: { doc_id: string; chunk_index: number; text: string; score: number; citation: string }[];
    },
  ): void;
}

export interface IngestDeps {
  extract: (path: string) => Promise<ExtractedDoc>;
  chunk: (content: string) => string[];
  embed: (text: string) => Promise<number[]>;
  detectPii: (text: string) => Promise<{ kind: string; start: number; end: number; text: string }[]>;
  store: DocumentStore;
  mirror: MirrorSink;
}

export interface IngestFileContext {
  folderId: string;
  matterId: string;
  ingestedVia: IngestSource;
}

export async function ingestFile(deps: IngestDeps, file: WalkedFile, ctx: IngestFileContext): Promise<Document> {
  const existing = deps.store.findDocumentByHash(ctx.folderId, file.contentHash);
  // A successfully-ingested (or still-processing) document short-circuits; a previously-errored
  // file must be retried on the next ingest rather than silently skipped forever, since its
  // content hash — the dedupe key — never changes on its own.
  if (existing && existing.status !== "error") return existing;

  let doc: Document;
  if (existing) {
    // Reuse the errored row in place rather than inserting a second one for the same
    // (folder_id, content_hash) pair — that pair is enforced unique at the DB layer.
    deps.store.updateDocumentStatus(existing.id, "processing");
    doc = existing;
  } else {
    try {
      doc = deps.store.createDocument({
        folder_id: ctx.folderId,
        matter_id: ctx.matterId,
        path: file.path,
        content_hash: file.contentHash,
        ingested_via: ctx.ingestedVia,
      });
    } catch {
      // Lost a race against a concurrent ingest of the same file (unique constraint on
      // folder_id+content_hash) — the other caller's row now exists; use it instead of failing.
      const raced = deps.store.findDocumentByHash(ctx.folderId, file.contentHash);
      if (!raced) throw new Error(`document creation failed for ${file.path} and no row exists to recover`);
      doc = raced;
    }
  }

  try {
    const extracted = await deps.extract(file.path);
    const chunks = deps.chunk(extracted.content);
    const piiEntities = await deps.detectPii(extracted.content);

    // Embedding isn't consumed yet — mirror chunks still carry a static score (see
    // MirrorChunk/appendMirror) until real semantic ranking is wired up, so computing and
    // discarding an embedding per chunk here would just pay full model-inference cost for
    // nothing. Re-add the deps.embed(text) call once the mirror format can hold the result.
    const mirrorChunks = chunks.map((text, chunkIndex) => ({
      doc_id: doc.id,
      chunk_index: chunkIndex,
      text,
      score: 1,
      citation: `${doc.id}#${chunkIndex}`,
    }));

    deps.store.insertPiiEntities(doc.id, piiEntities);
    deps.mirror.appendMirror(ctx.matterId, {
      pii: piiEntities.map((e) => ({ doc_id: doc.id, kind: e.kind, start: e.start, end: e.end, token: e.kind })),
      chunks: mirrorChunks,
    });

    deps.store.updateDocumentStatus(doc.id, "done", {
      pages: extracted.pageCount,
      chunk_count: chunks.length,
      pii_count: piiEntities.length,
    });
  } catch (error) {
    deps.store.updateDocumentStatus(doc.id, "error", {
      error_message: error instanceof Error ? error.message : "ingest failed",
    });
  }

  const updated = deps.store.getDocument(doc.id);
  if (!updated) throw new Error(`document ${doc.id} disappeared after status update`);
  return updated;
}
