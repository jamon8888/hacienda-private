import { del, get, update } from "idb-keyval";
import type { BoundingBox } from "@xberg-io/core";

export interface IndexedChunk {
  docId: string;
  chunkIndex: number;
  text: string;
  page?: number;
  citation?: string;
  bbox?: BoundingBox;
  vector: Float32Array;
}

function chunksKey(matterId: string): string {
  return `rag-chunks:${matterId}`;
}

// idb-keyval stores values via IndexedDB's own structured-clone algorithm, which already handles
// typed arrays and plain objects natively — no custom binary encoding is needed. This is the
// persistence layer rag.ts rebuilds an EdgeVec index from (via replay) instead of relying on
// EdgeVec's own save()/load(), which cannot round-trip its own output (see rag.ts for details).
export async function loadPersistedChunks(matterId: string): Promise<IndexedChunk[]> {
  const stored = await get<IndexedChunk[]>(chunksKey(matterId));
  return stored ?? [];
}

/** Overwrites the matter's persisted chunk list (used by buildIndex, which starts fresh). */
export async function setPersistedChunks(matterId: string, items: IndexedChunk[]): Promise<void> {
  await update<IndexedChunk[]>(chunksKey(matterId), () => items);
}

/** Appends to the matter's persisted chunk list (used by appendIndex, which augments it). */
export async function appendPersistedChunks(matterId: string, items: IndexedChunk[]): Promise<IndexedChunk[]> {
  let merged: IndexedChunk[] = [];
  await update<IndexedChunk[]>(chunksKey(matterId), (existing) => {
    merged = [...(existing ?? []), ...items];
    return merged;
  });
  return merged;
}

export async function deletePersistedChunks(matterId: string): Promise<void> {
  await del(chunksKey(matterId));
}
