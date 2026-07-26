import type { RetrievedChunk, BoundingBox } from "@xberg-io/core";
import type { EdgeVec } from "edgevec";
import init, { EdgeVec as EdgeVecClass, EdgeVecConfig } from "edgevec";
import { EMBED_DIM } from "./constants";
import { buildCorpusStats, type CorpusStats } from "./search/bm25";
import { initHybridStorage, insertSparseForChunk, hybridSearch as runHybridSearch } from "./search/hybrid";
import {
  appendPersistedChunks,
  deletePersistedChunks,
  loadPersistedChunks,
  setPersistedChunks,
  type IndexedChunk,
} from "./search/persist";

export type { IndexedChunk } from "./search/persist";

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

// In-memory live-instance cache, keyed by matterId — the ONLY source of truth this module reads
// from during a live session. EdgeVec.load() cannot currently be relied on to round-trip a
// previously save()'d index (edgevec@0.9.0: "corrupted data: Deserialization failed: This is a
// feature that PostCard will never implement" — reproduced with bare insert()-only indexes and
// every metadata-value-type combination tried, so it's the core round-trip itself, not a
// metadata-shape issue on our side). Instead of EdgeVec's own save()/load(), a cold cache is
// rebuilt by replaying inserts against the chunk list persisted in IndexedDB via search/persist.ts
// — see rebuildFromPersisted below. This also fixes a second, independent bug: retrieve() used to
// call EdgeVecClass.load() unconditionally, never consulting this cache even when it was warm.
const liveIndexes = new Map<string, EdgeVec>();

// Call after a matter is successfully forgotten/deleted server-side — otherwise its vectors stay
// resident in this cache (and therefore in the tab's memory) until the page reloads, even though
// the user asked for the matter's data to be gone. Also drops the persisted chunk list, which
// otherwise survives a "forget" indefinitely in IndexedDB.
export function evictLiveIndex(matterId: string): void {
  liveIndexes.delete(matterId);
  void deletePersistedChunks(matterId);
}

function newDb(): EdgeVec {
  const config = new EdgeVecConfig(EMBED_DIM);
  config.metric = "cosine";
  const db = new EdgeVecClass(config);
  initHybridStorage(db);
  return db;
}

function insertChunk(db: EdgeVec, item: IndexedChunk, stats: CorpusStats): void {
  const meta: Record<string, string | number> = {
    doc_id: item.docId,
    chunk_index: item.chunkIndex,
    text: item.text,
  };
  if (item.page !== undefined) meta["page"] = item.page;
  if (item.citation !== undefined) meta["citation"] = item.citation;
  if (item.bbox !== undefined) meta["bbox"] = JSON.stringify(item.bbox);
  db.insertWithMetadata(item.vector, meta);
  insertSparseForChunk(db, item.text, stats);
}

async function rebuildFromPersisted(matterId: string): Promise<{ db: EdgeVec; chunks: IndexedChunk[] }> {
  const chunks = await loadPersistedChunks(matterId);
  const db = newDb();
  const stats = buildCorpusStats(chunks.map((c) => c.text));
  for (const chunk of chunks) insertChunk(db, chunk, stats);
  return { db, chunks };
}

export async function buildIndex(matterId: string, items: IndexedChunk[]): Promise<EdgeVec> {
  await ensureEdgeVec();
  const db = newDb();
  const stats = buildCorpusStats(items.map((i) => i.text));
  for (const item of items) insertChunk(db, item, stats);
  await setPersistedChunks(matterId, items);
  liveIndexes.set(matterId, db);
  return db;
}

export async function loadIndex(matterId: string): Promise<EdgeVec> {
  await ensureEdgeVec();
  const cached = liveIndexes.get(matterId);
  if (cached) return cached;
  const { db } = await rebuildFromPersisted(matterId);
  liveIndexes.set(matterId, db);
  return db;
}

// Additive index build: reuse (or rebuild, or create) the matter's EdgeVec index and insert the
// new chunks into it, so a second document in the same matter augments retrieval instead of
// replacing it (buildIndex starts fresh and would drop the earlier document's vectors).
export async function appendIndex(
  matterId: string,
  items: IndexedChunk[],
  hasExistingIndex: boolean,
): Promise<EdgeVec> {
  await ensureEdgeVec();
  let db = liveIndexes.get(matterId);
  let priorChunks: IndexedChunk[] = [];
  if (!db) {
    if (hasExistingIndex) {
      const rebuilt = await rebuildFromPersisted(matterId);
      db = rebuilt.db;
      priorChunks = rebuilt.chunks;
    } else {
      db = newDb();
    }
  } else if (hasExistingIndex) {
    priorChunks = await loadPersistedChunks(matterId);
  }
  // BM25 stats are recomputed from the full corpus (prior + new) so this batch's weights account
  // for the whole matter, not just itself. Previously-inserted chunks keep the (slightly stale)
  // weights they were given at their own insertion time — edgevec has no way to update an
  // existing sparse entry's values — which is a standard, accepted approximation for incremental
  // BM25 (exact corpus-wide recomputation on every insert isn't done exactly even in most
  // production search engines). A full rebuild (rebuildFromPersisted, above) recomputes stats once
  // from the complete final corpus, so a freshly-reloaded index's weights are more consistent than
  // one built up incrementally across several appendIndex calls in one session.
  const stats = buildCorpusStats([...priorChunks, ...items].map((c) => c.text));
  for (const item of items) insertChunk(db, item, stats);
  liveIndexes.set(matterId, db);
  await appendPersistedChunks(matterId, items);
  return db;
}

export async function retrieve(
  matterId: string,
  queryVec: number[] | Float32Array,
  topK: number,
  queryText: string,
): Promise<RetrievedChunk[]> {
  const db = await loadIndex(matterId);
  const q = queryVec instanceof Float32Array ? queryVec : new Float32Array(queryVec);
  const chunks = await loadPersistedChunks(matterId);
  const stats = buildCorpusStats(chunks.map((c) => c.text));
  const hits = runHybridSearch(db, q, queryText, stats, topK);
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
