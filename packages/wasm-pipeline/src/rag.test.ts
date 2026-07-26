import { beforeEach, describe, expect, it, vi } from "vitest";

const loadMock = vi.fn();

// A faithful-enough fake of edgevec@0.9.0's real, empirically-verified quirks (see hybrid.ts's
// comments and the PR description for how these were confirmed against the real WASM module):
// - insertWithMetadata assigns dense ids starting at 1; insertSparse assigns sparse ids starting
//   at 0, independently — hybridSearch fuses a dense hit and a sparse hit only when they share the
//   same id number, so this fake enforces the same alignment rag.ts's initHybridStorage relies on.
// - db.search() returns hits in ASCENDING score order (least similar first).
// - db.hybridSearch()'s fused results come back in DESCENDING score order.
function cosineSim(a: Float32Array, b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < b.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

vi.mock("edgevec", () => {
  class FakeEdgeVecConfig {
    metric = "cosine";
    constructor(public readonly dim: number) {}
  }

  class FakeEdgeVec {
    dense: Array<{ vector: Float32Array; metadata: Record<string, unknown> }> = [];
    sparse: Array<{ indices: number[]; values: number[] }> = [];

    initSparseStorage(): void {
      // no-op: sparse storage is just this.sparse
    }

    private bq = false;

    enableBQ(): void {
      this.bq = true;
    }

    hasBQ(): boolean {
      return this.bq;
    }

    insertWithMetadata(vector: Float32Array, metadata: Record<string, unknown>): number {
      this.dense.push({ vector, metadata });
      return this.dense.length; // 1-indexed, matches real edgevec
    }

    insertSparse(indices: Uint32Array, values: Float32Array): number {
      this.sparse.push({ indices: Array.from(indices), values: Array.from(values) });
      return this.sparse.length - 1; // 0-indexed, matches real edgevec
    }

    getAllMetadata(id: number): Record<string, unknown> | undefined {
      return this.dense[id - 1]?.metadata;
    }

    search(query: Float32Array, k: number): Array<{ id: number; score: number }> {
      const scored = this.dense.map((d, i) => ({ id: i + 1, score: cosineSim(query, Array.from(d.vector)) }));
      // Real edgevec returns ascending (least-similar-first) — verified empirically.
      return scored.sort((a, b) => a.score - b.score).slice(0, k);
    }

    hybridSearch(
      denseQuery: Float32Array,
      sparseIndices: Uint32Array,
      sparseValues: Float32Array,
      _sparseDim: number,
      _optionsJson: string,
    ): string {
      const denseRanked = this.dense
        .map((d, i) => ({ id: i + 1, score: cosineSim(denseQuery, Array.from(d.vector)) }))
        .sort((a, b) => b.score - a.score);
      const queryTerms = new Map<number, number>();
      for (let i = 0; i < sparseIndices.length; i++) queryTerms.set(sparseIndices[i]!, sparseValues[i]!);
      const sparseRanked = this.sparse
        .map((s, id) => {
          let dot = 0;
          for (let i = 0; i < s.indices.length; i++) dot += (queryTerms.get(s.indices[i]!) ?? 0) * s.values[i]!;
          return { id, score: dot };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);

      const RRF_K = 60;
      const fused = new Map<number, { id: number; score: number; dense_rank?: number; sparse_rank?: number }>();
      denseRanked.forEach((hit, i) => {
        fused.set(hit.id, { id: hit.id, score: 1 / (RRF_K + i + 1), dense_rank: i + 1 });
      });
      sparseRanked.forEach((hit, i) => {
        const existing = fused.get(hit.id);
        const contribution = 1 / (RRF_K + i + 1);
        if (existing) {
          existing.score += contribution;
          existing.sparse_rank = i + 1;
        } else {
          fused.set(hit.id, { id: hit.id, score: contribution, sparse_rank: i + 1 });
        }
      });
      // Real edgevec returns fused hybrid results in DESCENDING score order — verified empirically.
      const results = [...fused.values()].sort((a, b) => b.score - a.score);
      return JSON.stringify(results);
    }

    save_stream(): { next_chunk(): Uint8Array | null } {
      return { next_chunk: () => null };
    }

    static load(name: string): Promise<unknown> {
      return loadMock(name);
    }
  }

  return {
    default: vi.fn(async () => undefined),
    EdgeVec: FakeEdgeVec,
    EdgeVecConfig: FakeEdgeVecConfig,
  };
});

const idbStore = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => idbStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  update: vi.fn(async (key: string, updater: (old: unknown) => unknown) => {
    idbStore.set(key, updater(idbStore.get(key)));
  }),
  del: vi.fn(async (key: string) => {
    idbStore.delete(key);
  }),
}));

interface ChunkOverrides {
  docId?: string;
  chunkIndex?: number;
  text?: string;
  vector?: number[];
  citation?: string;
}

function makeChunk(overrides: ChunkOverrides = {}) {
  return {
    docId: overrides.docId ?? "doc-1",
    chunkIndex: overrides.chunkIndex ?? 0,
    text: overrides.text ?? "hello world",
    citation: overrides.citation ?? "doc-1#0",
    vector: new Float32Array(overrides.vector ?? [1, 0, 0, 0]),
  };
}

describe("rag persistence + retrieval", () => {
  beforeEach(() => {
    loadMock.mockReset();
    idbStore.clear();
    vi.resetModules();
  });

  it("appendIndex builds a live index and retrieve() reads it back without reloading", async () => {
    const { appendIndex, retrieve } = await import("./rag");
    const items = [makeChunk({ text: "granite retrieval hit", vector: [1, 0, 0, 0] })];
    await appendIndex("matter-1", items, false);

    const hits = await retrieve("matter-1", new Float32Array([1, 0, 0, 0]), 5, "granite retrieval hit");
    expect(loadMock).not.toHaveBeenCalled();
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe("granite retrieval hit");
    expect(hits[0]?.doc_id).toBe("doc-1");
  });

  it("survives a reload (liveIndexes cleared) by rebuilding from persisted chunks, never calling EdgeVec.load()", async () => {
    const ragModule = await import("./rag");
    const items = [
      makeChunk({ chunkIndex: 0, text: "granite retrieval hit", vector: [1, 0, 0, 0], citation: "doc-1#0" }),
      makeChunk({ chunkIndex: 1, text: "an unrelated second chunk", vector: [0, 1, 0, 0], citation: "doc-1#1" }),
    ];
    await ragModule.appendIndex("matter-2", items, false);

    // Simulate a page reload: drop the in-memory cache, keep only what was persisted.
    vi.resetModules();
    const reloaded = await import("./rag");

    const hits = await reloaded.retrieve("matter-2", new Float32Array([1, 0, 0, 0]), 5, "granite retrieval hit");
    expect(loadMock).not.toHaveBeenCalled();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toBe("granite retrieval hit");
  });

  it("ranks a chunk with strong term overlap above a dense-only weak match (hybrid/BM25 signal)", async () => {
    const { appendIndex, retrieve } = await import("./rag");
    const items = [
      // Dense-close to the query vector, but shares no vocabulary with the query text.
      makeChunk({ chunkIndex: 0, text: "zebra quokka platypus", vector: [0.9, 0.1, 0, 0], citation: "doc-1#0" }),
      // Dense-far from the query vector, but an exact verbatim term match with the query text.
      makeChunk({
        chunkIndex: 1,
        text: "invoice payment terms net thirty",
        vector: [0, 0, 0, 1],
        citation: "doc-1#1",
      }),
    ];
    await appendIndex("matter-3", items, false);

    const hits = await retrieve("matter-3", new Float32Array([1, 0, 0, 0]), 5, "invoice payment terms net thirty");
    expect(hits[0]?.text).toBe("invoice payment terms net thirty");
  });

  it("evictLiveIndex drops both the in-memory cache and the persisted chunk list", async () => {
    const { appendIndex, evictLiveIndex, retrieve } = await import("./rag");
    await appendIndex("matter-4", [makeChunk({ text: "will be forgotten" })], false);
    evictLiveIndex("matter-4");
    // Give the fire-and-forget delete a tick to complete.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hits = await retrieve("matter-4", new Float32Array([1, 0, 0, 0]), 5, "will be forgotten");
    expect(hits).toHaveLength(0);
  });
});
