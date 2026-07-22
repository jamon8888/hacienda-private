import type { RetrievedChunk, BoundingBox } from "@xberg-io/core";
import type { EdgeVec } from "edgevec";
import init, { EdgeVec as EdgeVecClass, EdgeVecConfig } from "edgevec";
import { EMBED_DIM } from "./constants";

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

// In-memory live-instance cache, keyed by matterId. Read the comment on appendIndex below for why
// this exists: EdgeVec.load() cannot currently be relied on to round-trip a previously save()'d
// index, so appendIndex avoids calling it whenever the matter's index is still resident from an
// earlier append in this same page session.
const liveIndexes = new Map<string, EdgeVec>();

// Call after a matter is successfully forgotten/deleted server-side — otherwise its vectors stay
// resident in this cache (and therefore in the tab's memory) until the page reloads, even though
// the user asked for the matter's data to be gone.
export function evictLiveIndex(matterId: string): void {
  liveIndexes.delete(matterId);
}

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

export async function loadIndex(matterId: string): Promise<EdgeVec> {
  await ensureEdgeVec();
  return EdgeVecClass.load(dbName(matterId));
}

// Additive index build: reuse (or load, or create) the matter's EdgeVec index and insert the new
// chunks into it, so a second document in the same matter augments retrieval instead of replacing
// it (buildIndex starts fresh and would drop the earlier document's vectors).
//
// Prefers the in-memory `liveIndexes` cache over EdgeVec.load() for two independent reasons:
// 1. EdgeVec.load() HANGS forever (its Promise never settles) when no index has been saved for
//    `name` yet, rather than rejecting — so probing existence by catching a load() failure is
//    unsafe; `hasExistingIndex` (the caller's authoritative signal) exists because of this.
// 2. Separately — and this is the one that matters even when `hasExistingIndex` is true —
//    EdgeVec.load() in edgevec@0.9.0 currently CANNOT deserialize what EdgeVec.save() writes to
//    IndexedDB. Every load() of a previously-saved index throws "corrupted data: Deserialization
//    failed: This is a feature that PostCard will never implement", reproduced with bare
//    insert()-only indexes (zero metadata) and with every metadata-value-type combination tried —
//    it is not a metadata-shape issue on our side, it is the core index round-trip itself. Tracked
//    upstream; see docs/investigations/2026-07-21-onnxruntime-web-worker-url-typeerror.md.
//    Keeping the live instance in memory sidesteps save()+load() entirely for the common case this
//    exists for — several files dropped into the same folder in one sitting — at the cost of not
//    being able to resume appending to a matter's index after a page reload (that path still goes
//    through the broken load() and will throw; the matter's LATEST saved index remains intact and
//    correct on disk either way, since save() always runs after every insert batch).
export async function appendIndex(
  matterId: string,
  items: IndexedChunk[],
  hasExistingIndex: boolean,
): Promise<EdgeVec> {
  await ensureEdgeVec();
  let db = liveIndexes.get(matterId);
  if (!db) {
    if (hasExistingIndex) {
      db = await EdgeVecClass.load(dbName(matterId));
    } else {
      const config = new EdgeVecConfig(EMBED_DIM);
      config.metric = "cosine";
      db = new EdgeVecClass(config);
    }
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
  liveIndexes.set(matterId, db);
  return db;
}

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
