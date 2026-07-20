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
  doc_id: string;
  chunk_index: number;
  text: string;
  page?: number;
  citation?: string;
  bbox?: BoundingBox;
}

let edgevecReady: Promise<void> | null = null;

function ensureEdgeVec(): Promise<void> {
  if (!edgevecReady) {
    edgevecReady = init().then(() => undefined);
  }
  return edgevecReady;
}

// edgevec@0.9.0's own metadata storage (insertWithMetadata / getAllMetadata) breaks its own
// save(name)/load(name) round-trip: loading a saved index back throws "corrupted data:
// Deserialization failed: This is a feature that PostCard will never implement" (postcard's
// Error::WontImplement, from attempting a self-describing/"any" deserialization it doesn't
// support) whenever any vector carries metadata — confirmed via a minimal repro against the
// installed package (no fix available; 0.9.0 is the latest published version). Chunk metadata
// is small and JSON-serializable, so we keep it entirely on the JS side instead, keyed by the
// same vector id edgevec assigns on insert() — this never touches edgevec's metadata storage.
//
// That workaround turned out to be necessary but not sufficient: `save(name)`/`load(name)`
// throw the exact same "PostCard will never implement" error even with zero metadata calls
// (confirmed live — a plain insert()-only index still fails to reload). The bug is in the
// base index (de)serialization itself, not specifically the metadata path, and there is no
// working replacement in this version (`save_stream()` has no matching "load from chunks"
// counterpart — it's write-only, meant for exporting bytes to the server mirror). So we never
// call `save`/`load` at all: persist the raw vectors ourselves (same JS-side approach as
// metadata) and rebuild the index by replaying `insert()` in id order, which reproduces the
// same id assignment a fresh EdgeVec instance always starts from.
function metaKey(matterId: string): string {
  return `edgevec-meta:${matterId}`;
}

function vectorKey(matterId: string): string {
  return `edgevec-vectors:${matterId}`;
}

function saveMetadata(matterId: string, metaById: Record<number, EdgeVecMetadata>): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(metaKey(matterId), JSON.stringify(metaById));
}

function loadMetadata(matterId: string): Record<number, EdgeVecMetadata> {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(metaKey(matterId)) ?? "{}") as Record<number, EdgeVecMetadata>;
  } catch {
    return {};
  }
}

function saveVectors(matterId: string, vectorsById: Record<number, number[]>): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(vectorKey(matterId), JSON.stringify(vectorsById));
}

function loadVectors(matterId: string): Record<number, number[]> {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(vectorKey(matterId)) ?? "{}") as Record<number, number[]>;
  } catch {
    return {};
  }
}

export async function buildIndex(matterId: string, items: IndexedChunk[]): Promise<EdgeVec> {
  await ensureEdgeVec();
  const config = new EdgeVecConfig(EMBED_DIM);
  config.metric = "cosine";
  const db = new EdgeVecClass(config);
  const metaById: Record<number, EdgeVecMetadata> = {};
  const vectorsById: Record<number, number[]> = {};
  for (const item of items) {
    const id = db.insert(item.vector);
    metaById[id] = {
      doc_id: item.docId,
      chunk_index: item.chunkIndex,
      text: item.text,
      page: item.page,
      citation: item.citation,
      bbox: item.bbox,
    };
    vectorsById[id] = Array.from(item.vector);
  }
  saveMetadata(matterId, metaById);
  saveVectors(matterId, vectorsById);
  return db;
}

export async function loadIndex(matterId: string): Promise<EdgeVec> {
  await ensureEdgeVec();
  const config = new EdgeVecConfig(EMBED_DIM);
  config.metric = "cosine";
  const db = new EdgeVecClass(config);
  const vectorsById = loadVectors(matterId);
  for (const id of Object.keys(vectorsById).map(Number).sort((a, b) => a - b)) {
    db.insert(new Float32Array(vectorsById[id] ?? []));
  }
  return db;
}

export async function retrieve(
  matterId: string,
  queryVec: number[] | Float32Array,
  topK: number,
): Promise<RetrievedChunk[]> {
  const db = await loadIndex(matterId);
  const metaById = loadMetadata(matterId);
  const q = queryVec instanceof Float32Array ? queryVec : new Float32Array(queryVec);
  const raw = db.search(q, topK);
  const hits = raw as unknown as Array<{ id: number; score: number }>;
  const out: RetrievedChunk[] = [];
  for (const hit of hits) {
    const m = metaById[hit.id];
    if (!m) continue;
    out.push({
      doc_id: m.doc_id,
      chunk_index: m.chunk_index,
      text: m.text,
      page: m.page,
      bbox: m.bbox,
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
