import type { RetrievedChunk } from "@xberg-io/core";
import init, { EdgeVec as EdgeVecClass, EdgeVecConfig } from "edgevec";
import type { EdgeVec } from "edgevec";
import { EMBED_DIM } from "../constants";
import type { IndexedChunk, QueryArgs, SearchStore } from "./store";
import { pack, unpack, writeBlob, readBlob, deleteBlob } from "./persist";
import { buildSparse, addToVocabulary, createVocabulary, type Vocabulary } from "./hybrid";

let edgevecReady: Promise<void> | null = null;
function ensureEdgeVec(): Promise<void> {
  if (!edgevecReady) {
    edgevecReady = init().then(() => undefined);
  }
  return edgevecReady;
}

interface HybridHit {
  id: number;
  score: number;
}

interface BqHit {
  id: number;
  score?: number;
  distance?: number;
}

// A one-element placeholder sparse vector, used both to "burn" sparse id 0
// (see the note in open()/load()) and to stand in for a chunk with no
// sparse-encodable content -- EdgeVec rejects a zero-length sparse insert
// ("sparse vector must have at least one element"), and every dense insert
// must be paired with exactly one sparse insert to keep ids aligned.
const DUMMY_SPARSE_INDICES = new Uint32Array([0]);
const DUMMY_SPARSE_VALUES = new Float32Array([Number.MIN_VALUE]);

export class EdgeVecSearchStore implements SearchStore {
  private db: EdgeVec | null = null;
  private matterId: string | null = null;
  private vocab: Vocabulary = createVocabulary();
  private metaById = new Map<number, IndexedChunk>();
  private hybridAvailable = false;
  private bqAvailable = false;

  async open(matterId: string): Promise<void> {
    await ensureEdgeVec();
    const config = new EdgeVecConfig(EMBED_DIM);
    config.metric = "cosine";
    const db = new EdgeVecClass(config);

    this.hybridAvailable = typeof db.hybridSearch === "function" && typeof db.insertSparse === "function";
    if (this.hybridAvailable) {
      // EdgeVec's dense ids start at 1 but its sparse ids start at 0
      // (verified empirically -- a fresh index's first insertWithMetadata()
      // returns 1, first insertSparse() returns 0). hybridSearch fuses the
      // dense and sparse legs by treating the *same numeric id* as "the same
      // vector" in both spaces, so a naive 1:1 insertWithMetadata/insertSparse
      // pairing is silently misaligned by one from the very first chunk,
      // fusing each chunk's dense result with the PREVIOUS chunk's sparse
      // vector. Inserting one throwaway sparse vector before any real chunk
      // consumes sparse id 0, after which both sequences advance 1:1.
      db.insertSparse(DUMMY_SPARSE_INDICES, DUMMY_SPARSE_VALUES, 1);
    }

    this.bqAvailable = false;
    if (typeof db.enableBQ === "function") {
      try {
        db.enableBQ();
        this.bqAvailable = true;
      } catch {
        this.bqAvailable = false;
      }
    }

    this.db = db;
    this.matterId = matterId;
    this.vocab = createVocabulary();
    this.metaById = new Map();
  }

  async ingest(items: IndexedChunk[]): Promise<void> {
    const db = this.requireDb("ingest");

    for (const item of items) addToVocabulary(this.vocab, item.text);

    for (const item of items) {
      const meta: Record<string, string | number> = {
        docId: item.docId,
        chunkIndex: item.chunkIndex,
        text: item.text,
      };
      if (item.page !== undefined) meta["page"] = item.page;
      if (item.citation !== undefined) meta["citation"] = item.citation;
      if (item.bbox !== undefined) meta["bbox"] = JSON.stringify(item.bbox);

      const denseId = db.insertWithMetadata(item.vector, meta);

      let sparseIndices: Uint32Array | undefined;
      let sparseValues: Float32Array | undefined;
      if (this.hybridAvailable) {
        const provided =
          item.sparseIndices !== undefined && item.sparseValues !== undefined && item.sparseIndices.length > 0;
        const sparse = provided
          ? { indices: item.sparseIndices as Uint32Array, values: item.sparseValues as Float32Array, dim: this.vocab.dim }
          : buildSparse(item.text, this.vocab);

        sparseIndices = sparse.indices.length > 0 ? sparse.indices : DUMMY_SPARSE_INDICES;
        sparseValues = sparse.values.length > 0 ? sparse.values : DUMMY_SPARSE_VALUES;
        const sparseId = db.insertSparse(sparseIndices, sparseValues, Math.max(sparse.dim, 1));
        if (sparseId !== denseId) {
          throw new Error(
            `EdgeVecSearchStore.ingest: dense/sparse id misalignment (dense=${denseId}, sparse=${sparseId}) -- hybridSearch would silently fuse the wrong vectors`,
          );
        }
      }

      // Store what was actually inserted (including any dummy substitution)
      // so persist()/load() can replay the identical insertSparse() call.
      this.metaById.set(denseId, { ...item, sparseIndices, sparseValues });
    }
  }

  async query(matterId: string, args: QueryArgs): Promise<RetrievedChunk[]> {
    const db = this.requireDb("query");
    if (this.matterId !== matterId) {
      throw new Error(`EdgeVecSearchStore.query: matter ${matterId} is not the open matter (${this.matterId})`);
    }
    const { vector, keyword, topK } = args;

    if (args.lowRam && this.bqAvailable) {
      const raw = db.searchBQRescored(vector, topK, 5) as BqHit[];
      return this.toRetrievedChunks(raw, (h) => h.score ?? h.distance ?? 0);
    }

    if (this.hybridAvailable && keyword.trim().length > 0) {
      const sparse = buildSparse(keyword, this.vocab);
      if (sparse.indices.length > 0) {
        const optionsJson = JSON.stringify({ dense_k: topK, sparse_k: topK, k: topK, fusion: "rrf" });
        const raw = JSON.parse(
          db.hybridSearch(vector, sparse.indices, sparse.values, sparse.dim, optionsJson),
        ) as HybridHit[];
        return this.toRetrievedChunks(raw, (h) => h.score);
      }
    }

    // Dense-only fallback: no keyword, hybrid unsupported, or an
    // all-out-of-vocabulary keyword (empty sparse leg).
    //
    // db.search() has a confirmed EdgeVec 0.9.0 bug under cosine metric: its
    // *internal* top-k selection picks the k results with the lowest raw
    // score, even though a higher score is the better cosine match (verified
    // empirically -- search(query, 1) returns the worse of two candidates,
    // and the array is never sorted best-first). Re-sorting after the fact
    // can't undo a truncation that already happened inside the wasm call, so
    // this asks for every indexed vector, sorts correctly ourselves, and
    // truncates to topK here. hybridSearch()/searchBQ() were separately
    // verified to already truncate and order correctly, so they are
    // untouched.
    const candidateK = Math.max(topK, this.metaById.size, 1);
    const raw = db.search(vector, candidateK) as unknown as HybridHit[];
    const sorted = [...raw].sort((a, b) => b.score - a.score).slice(0, topK);
    return this.toRetrievedChunks(sorted, (h) => h.score);
  }

  async persist(matterId: string): Promise<void> {
    if (!this.db || this.matterId !== matterId) {
      throw new Error(`EdgeVecSearchStore.persist: matter ${matterId} is not the open matter`);
    }
    const chunks = Array.from(this.metaById.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([id, item]) => ({
        id,
        docId: item.docId,
        chunkIndex: item.chunkIndex,
        text: item.text,
        page: item.page,
        citation: item.citation,
        bbox: item.bbox,
        vector: item.vector,
        sparseIndices: item.sparseIndices,
        sparseValues: item.sparseValues,
      }));
    const blob = pack({ dim: EMBED_DIM, sparseDim: Math.max(this.vocab.dim, 1), chunks });
    await writeBlob(matterId, blob);
  }

  async load(matterId: string): Promise<boolean> {
    const blob = await readBlob(matterId);
    if (!blob) return false;
    const persisted = unpack(blob);

    await ensureEdgeVec();
    const config = new EdgeVecConfig(persisted.dim);
    config.metric = "cosine";
    const db = new EdgeVecClass(config);

    const hybridAvailable = typeof db.hybridSearch === "function" && typeof db.insertSparse === "function";
    if (hybridAvailable) {
      db.insertSparse(DUMMY_SPARSE_INDICES, DUMMY_SPARSE_VALUES, 1);
    }

    let bqAvailable = false;
    if (typeof db.enableBQ === "function") {
      try {
        db.enableBQ();
        bqAvailable = true;
      } catch {
        bqAvailable = false;
      }
    }

    const vocab = createVocabulary();
    const metaById = new Map<number, IndexedChunk>();

    // Replay in original id order: vocabulary term->id assignment is a pure
    // function of (term, first-occurrence order), so reprocessing chunks in
    // the same order they were originally ingested deterministically
    // reproduces the same vocabulary without persisting it separately.
    const ordered = [...persisted.chunks].sort((a, b) => a.id - b.id);
    for (const chunk of ordered) {
      addToVocabulary(vocab, chunk.text);

      const meta: Record<string, string | number> = {
        docId: chunk.docId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
      };
      if (chunk.page !== undefined) meta["page"] = chunk.page;
      if (chunk.citation !== undefined) meta["citation"] = chunk.citation;
      if (chunk.bbox !== undefined) meta["bbox"] = JSON.stringify(chunk.bbox);

      const denseId = db.insertWithMetadata(chunk.vector, meta);

      if (hybridAvailable) {
        const indices = chunk.sparseIndices && chunk.sparseIndices.length > 0 ? chunk.sparseIndices : DUMMY_SPARSE_INDICES;
        const values = chunk.sparseValues && chunk.sparseValues.length > 0 ? chunk.sparseValues : DUMMY_SPARSE_VALUES;
        const sparseId = db.insertSparse(indices, values, Math.max(persisted.sparseDim, 1));
        if (sparseId !== denseId) {
          throw new Error(
            `EdgeVecSearchStore.load: dense/sparse id misalignment on rebuild (dense=${denseId}, sparse=${sparseId})`,
          );
        }
      }

      metaById.set(denseId, {
        docId: chunk.docId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        page: chunk.page,
        citation: chunk.citation,
        bbox: chunk.bbox,
        vector: chunk.vector,
        sparseIndices: chunk.sparseIndices,
        sparseValues: chunk.sparseValues,
      });
    }

    this.db = db;
    this.matterId = matterId;
    this.hybridAvailable = hybridAvailable;
    this.bqAvailable = bqAvailable;
    this.vocab = vocab;
    this.metaById = metaById;
    return true;
  }

  async forget(matterId: string): Promise<void> {
    await deleteBlob(matterId);
    if (this.matterId === matterId) {
      this.db = null;
      this.matterId = null;
      this.vocab = createVocabulary();
      this.metaById = new Map();
    }
  }

  async close(): Promise<void> {
    this.db = null;
    this.matterId = null;
  }

  private requireDb(op: string): EdgeVec {
    if (!this.db) throw new Error(`EdgeVecSearchStore.${op} called before open()`);
    return this.db;
  }

  private toRetrievedChunks<T extends { id: number }>(raw: T[], scoreOf: (h: T) => number): RetrievedChunk[] {
    const out: RetrievedChunk[] = [];
    for (const hit of raw) {
      const item = this.metaById.get(hit.id);
      if (!item) continue;
      out.push({
        doc_id: item.docId,
        chunk_index: item.chunkIndex,
        text: item.text,
        page: item.page,
        bbox: item.bbox,
        score: scoreOf(hit),
        citation: item.citation ?? "",
      });
    }
    return out;
  }
}
