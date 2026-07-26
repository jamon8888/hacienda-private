// BM25-style sparse term weighting for EdgeVec's insertSparse/hybridSearch, which store raw
// term-index -> weight pairs and expect the caller to supply BM25 (or similar) scores themselves
// (edgevec has no tokenizer/IDF of its own — see its insertSparse docs: "e.g., BM25 scores").

export const BM25_SPARSE_DIM = 2 ** 20;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface CorpusStats {
  docFrequency: Map<number, number>;
  avgDocLength: number;
  totalDocs: number;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// FNV-1a hash mod dim (the "hashing trick"): a fixed, stateless term -> index mapping means corpus
// stats can always be rebuilt purely from chunk text (no separate vocabulary needs persisting), at
// the cost of rare hash collisions between unrelated terms — acceptable at this app's per-matter
// vocabulary scale (hundreds to low thousands of unique terms) against a 2^20 index space.
function termIndex(term: string, dim: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    hash ^= term.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % dim;
}

// Computed fresh from whatever chunk texts are passed in — callers recompute this from the full
// corpus available at the time (rag.ts documents the incremental-append approximation this implies).
export function buildCorpusStats(texts: readonly string[], dim = BM25_SPARSE_DIM): CorpusStats {
  const docFrequency = new Map<number, number>();
  let totalLength = 0;
  for (const text of texts) {
    const terms = tokenize(text);
    totalLength += terms.length;
    const seen = new Set(terms.map((t) => termIndex(t, dim)));
    for (const idx of seen) docFrequency.set(idx, (docFrequency.get(idx) ?? 0) + 1);
  }
  return {
    docFrequency,
    avgDocLength: texts.length > 0 ? totalLength / texts.length : 0,
    totalDocs: texts.length,
  };
}

/** Okapi BM25 term scores for `text` against `stats`, keyed by hashed term index. */
export function bm25TermScores(text: string, stats: CorpusStats, dim = BM25_SPARSE_DIM): Record<number, number> {
  if (stats.totalDocs === 0) return {};
  const terms = tokenize(text);
  if (terms.length === 0) return {};
  const termFreq = new Map<number, number>();
  for (const term of terms) {
    const idx = termIndex(term, dim);
    termFreq.set(idx, (termFreq.get(idx) ?? 0) + 1);
  }
  const docLength = terms.length;
  const avgDocLength = stats.avgDocLength || docLength;
  const scores: Record<number, number> = {};
  for (const [idx, tf] of termFreq) {
    const df = stats.docFrequency.get(idx) ?? 1;
    // `1 + ...` keeps this always non-negative (unlike the textbook `log((N-df+0.5)/(df+0.5))`,
    // which can go negative for very common terms) since edgevec's sparse values are not expected
    // to carry negative weights.
    const idf = Math.log(1 + (stats.totalDocs - df + 0.5) / (df + 0.5));
    const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLength) / avgDocLength);
    scores[idx] = idf * ((tf * (BM25_K1 + 1)) / denom);
  }
  return scores;
}
