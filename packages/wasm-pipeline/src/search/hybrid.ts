// BM25/sparse query builder for EdgeVec's native hybridSearch (spec Section 4).
// EdgeVec fuses dense + sparse legs internally (RRF); this module only tokenizes,
// maintains a per-matter term vocabulary (built at ingest so query-time term ids
// align with insert-time ids), and produces the sparse leg's
// indices/values/dim for db.insertSparse()/db.hybridSearch().

export interface Vocabulary {
	/** Next available term id == current vocabulary size. */
	dim: number;
	terms: Map<string, number>;
	/** Document frequency per term, for idf weighting. */
	df: Map<string, number>;
	/** Number of chunks folded into this vocabulary. */
	nDocs: number;
}

export interface SparseVector {
	indices: Uint32Array;
	values: Float32Array;
	dim: number;
}

export function createVocabulary(): Vocabulary {
	return { dim: 0, terms: new Map(), df: new Map(), nDocs: 0 };
}

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0);
}

/** Registers a chunk's terms into the vocabulary (assigns ids to new terms, bumps df). */
export function addToVocabulary(vocab: Vocabulary, text: string): void {
	const tokens = tokenize(text);
	const seen = new Set<string>();
	for (const term of tokens) {
		if (!vocab.terms.has(term)) {
			vocab.terms.set(term, vocab.dim);
			vocab.dim += 1;
		}
		if (!seen.has(term)) {
			seen.add(term);
			vocab.df.set(term, (vocab.df.get(term) ?? 0) + 1);
		}
	}
	vocab.nDocs += 1;
}

/** Builds a fresh vocabulary from a chunk set (used once at ingest time). */
export function buildVocabulary(chunks: Array<{ text: string }>): Vocabulary {
	const vocab = createVocabulary();
	for (const chunk of chunks) addToVocabulary(vocab, chunk.text);
	return vocab;
}

function termWeight(vocab: Vocabulary, term: string, tf: number): number {
	const df = vocab.df.get(term) ?? 1;
	const idf = Math.log(1 + vocab.nDocs / df);
	return tf * idf;
}

/**
 * Builds the sparse leg for a piece of text (query keyword or ingest-time chunk)
 * against an already-built vocabulary. Terms not present in the vocabulary are
 * dropped (can't sparse-encode against an unknown dimension). Indices are
 * returned sorted ascending, as EdgeVec's insertSparse/hybridSearch require.
 * An empty or fully-OOV query yields an empty sparse leg, signalling the
 * caller to fall back to dense-only search.
 */
export function buildSparse(text: string, vocab: Vocabulary): SparseVector {
	const dim = Math.max(vocab.dim, 1);
	const tokens = tokenize(text);
	if (tokens.length === 0 || vocab.dim === 0) {
		return { indices: new Uint32Array(0), values: new Float32Array(0), dim };
	}

	const counts = new Map<string, number>();
	for (const term of tokens) {
		if (!vocab.terms.has(term)) continue;
		counts.set(term, (counts.get(term) ?? 0) + 1);
	}

	const entries = Array.from(counts.entries())
		.map(([term, tf]): [number, number] => [vocab.terms.get(term) as number, termWeight(vocab, term, tf)])
		.sort((a, b) => a[0] - b[0]);

	const indices = new Uint32Array(entries.map((e) => e[0]));
	const values = new Float32Array(entries.map((e) => e[1]));
	return { indices, values, dim };
}
