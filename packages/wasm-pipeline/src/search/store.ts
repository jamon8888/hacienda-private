import type { RetrievedChunk, BoundingBox } from "@xberg-io/core";

export interface IndexedChunk {
  docId: string;
  chunkIndex: number;
  text: string;
  page?: number;
  citation?: string;
  bbox?: BoundingBox;
  vector: Float32Array;
  sparseIndices?: Uint32Array;
  sparseValues?: Float32Array;
}

export interface IndexedChunkMap {
  [id: number]: IndexedChunk;
}

export interface QueryArgs {
  vector: Float32Array;
  keyword: string;
  topK: number;
  lowRam?: boolean;
}

export interface SearchStore {
  open(matterId: string): Promise<void>;
  ingest(items: IndexedChunk[]): Promise<void>;
  query(matterId: string, args: QueryArgs): Promise<RetrievedChunk[]>;
  persist(matterId: string): Promise<void>;
  load(matterId: string): Promise<boolean>;
  forget(matterId: string): Promise<void>;
  close(): Promise<void>;
}
