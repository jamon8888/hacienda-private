import type { EdgeVec } from "edgevec";
import { createHybridOptions, createSparseVector, parseHybridResults } from "edgevec/sparse-helpers.js";
import { bm25TermScores, BM25_SPARSE_DIM, type CorpusStats } from "./bm25";

export interface HybridHit {
  id: number;
  score: number;
}

// EdgeVec's sparse vector ids start at 0 while dense ids (from insertWithMetadata) start at 1.
// hybridSearch fuses a dense hit and a sparse hit into one row whenever they carry the SAME id
// number — verified empirically against edgevec@0.9.0 (see the PR description) — it does not
// otherwise correlate them by insertion order or any other signal. Left unaligned, a dense hit for
// chunk A (dense id 1) and a sparse hit for chunk B (sparse id 1) get silently fused into one
// fabricated result. Burning one throwaway sparse id up front realigns the two bases so every
// subsequent 1:1 dense+sparse insert pair (see rag.ts's insertChunk) shares the same id number.
const SPARSE_ID_PAD_INDEX = BM25_SPARSE_DIM - 1;

export function initHybridStorage(db: EdgeVec): void {
  db.initSparseStorage();
  db.insertSparse(new Uint32Array([SPARSE_ID_PAD_INDEX]), new Float32Array([Number.EPSILON]), BM25_SPARSE_DIM);
}

export function insertSparseForChunk(db: EdgeVec, text: string, stats: CorpusStats): void {
  const scores = bm25TermScores(text, stats, BM25_SPARSE_DIM);
  const sparse = createSparseVector(scores, BM25_SPARSE_DIM);
  if (sparse.indices.length === 0) return;
  db.insertSparse(sparse.indices, sparse.values, sparse.dim);
}

export function hybridSearch(
  db: EdgeVec,
  denseQuery: Float32Array,
  queryText: string,
  stats: CorpusStats,
  k: number,
): HybridHit[] {
  const scores = bm25TermScores(queryText, stats, BM25_SPARSE_DIM);
  const sparse = createSparseVector(scores, BM25_SPARSE_DIM);
  if (sparse.indices.length === 0) {
    // hybridSearch rejects an empty sparse query outright ("sparse vector must have at least one
    // element") — fall back to dense-only search, explicitly re-sorted best-first: db.search()
    // returns results in ASCENDING score order (verified empirically), the opposite of
    // hybridSearch's own descending order, so trusting its raw order silently inverted every
    // dense-only retrieval.
    const raw = db.search(denseQuery, k) as unknown as HybridHit[];
    return [...raw].sort((a, b) => b.score - a.score);
  }
  const options = createHybridOptions({ k });
  const json = db.hybridSearch(denseQuery, sparse.indices, sparse.values, sparse.dim, options);
  return parseHybridResults(json);
}
