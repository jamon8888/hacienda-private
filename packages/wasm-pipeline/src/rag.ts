import type { RetrievedChunk, BoundingBox } from "@xberg-io/core";
import type { EdgeVec } from "edgevec";
import init, { EdgeVec as EdgeVecClass, EdgeVecConfig } from "edgevec";
import { EMBED_DIM } from "./constants";

/** A chunk plus its embedding and citation metadata, ready for indexing. */
export interface IndexedChunk {
  docId: string;
  chunkIndex: number;
  text: string;
  page?: number;
  citation?: string;
  bbox?: BoundingBox;
  vector: Float32Array;
}

interface EdgeVecMetadata {
  doc_id?: string;
  chunk_index?: number;
  text?: string;
  page?: number;
  citation?: string;
  bbox?: string;
}

let edgevecReady: Promise<void> | null = null;

function ensureEdgeVec(): Promise<void> {
  if (!edgevecReady) {
    edgevecReady = init().then(() => undefined);
  }
  return edgevecReady;
}

function dbName(matterId: string): string {
  return `edgevec:${matterId}`;
}

/**
 * Build a cosine EdgeVec index for a matter from indexed chunks and persist it.
 *
 * @param matterId - The matter the index belongs to (used as the DB name).
 * @param items - The chunks (with vectors + metadata) to insert.
 * @returns The populated, saved {@link EdgeVec} instance.
 */
export async function buildIndex(matterId: string, items: IndexedChunk[]): Promise<EdgeVec> {
  await ensureEdgeVec();
  const config = new EdgeVecConfig(EMBED_DIM);
  config.metric = "cosine";
  const db = new EdgeVecClass(config);
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

/**
 * Load a previously persisted EdgeVec index for a matter.
 *
 * @param matterId - The matter whose index should be loaded.
 * @returns The loaded {@link EdgeVec} instance.
 */
export async function loadIndex(matterId: string): Promise<EdgeVec> {
  await ensureEdgeVec();
  return EdgeVecClass.load(dbName(matterId));
}

/**
 * Retrieve the top-K most similar chunks for a query vector.
 *
 * @param matterId - The matter whose index to search.
 * @param queryVec - The query embedding (array or `Float32Array`).
 * @param topK - Maximum number of results to return.
 * @returns Ranked {@link RetrievedChunk}s with score, citation, and optional bbox.
 */
export async function retrieve(
  matterId: string,
  queryVec: number[] | Float32Array,
  topK: number,
): Promise<RetrievedChunk[]> {
  const db = await loadIndex(matterId);
  const q = queryVec instanceof Float32Array ? queryVec : new Float32Array(queryVec);
  const raw = db.search(q, topK);
  const hits = raw as unknown as Array<{ id: number; score: number }>;
  const out: RetrievedChunk[] = [];
  for (const hit of hits) {
    const m = db.getAllMetadata(hit.id) as unknown as EdgeVecMetadata | undefined;
    if (!m) continue;
    let bbox: BoundingBox | undefined;
    if (m.bbox) {
      try {
        bbox = JSON.parse(m.bbox) as BoundingBox;
      } catch {
        bbox = undefined;
      }
    }
    out.push({
      doc_id: m.doc_id ?? "",
      chunk_index: m.chunk_index ?? 0,
      text: m.text ?? "",
      page: m.page,
      bbox,
      score: hit.score,
      citation: m.citation ?? "",
    });
  }
  return out;
}

/**
 * Serialize an EdgeVec index into a single contiguous byte buffer.
 *
 * Drains the index's streaming save iterator and concatenates the chunks.
 *
 * @param db - The index to serialize.
 * @returns The full serialized index as a {@link Uint8Array}.
 */
export async function serializeIndex(db: EdgeVec): Promise<Uint8Array> {
  const iter = db.save_stream();
  const parts: Uint8Array[] = [];
  let chunk = iter.next_chunk();
  while (chunk) {
    parts.push(chunk);
    chunk = iter.next_chunk();
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
