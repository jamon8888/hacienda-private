import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { pack, unpack, writeBlob, readBlob, deleteBlob, type PersistedIndex } from "./persist";

function sample(): PersistedIndex {
  return {
    dim: 4,
    sparseDim: 100,
    chunks: [
      {
        id: 0,
        docId: "doc-1",
        chunkIndex: 0,
        text: "Acme Corp signed clause 9",
        page: 1,
        citation: "m1#c0",
        bbox: { x: 1, y: 2, w: 3, h: 4 },
        vector: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        sparseIndices: new Uint32Array([1, 5]),
        sparseValues: new Float32Array([1.0, 0.5]),
      },
      {
        id: 1,
        docId: "doc-1",
        chunkIndex: 1,
        text: "unrelated cooking recipe",
        vector: new Float32Array([-0.1, -0.2, -0.3, -0.4]),
        // no page, no citation, no bbox, no sparse — exercises the optional paths
      },
    ],
  };
}

describe("persist.ts binary pack/unpack round-trip", () => {
  it("pack -> unpack reproduces the same vectors and metadata", () => {
    const index = sample();
    const blob = pack(index);
    const restored = unpack(blob);

    expect(restored.dim).toBe(index.dim);
    expect(restored.sparseDim).toBe(index.sparseDim);
    expect(restored.chunks.length).toBe(2);

    expect(Array.from(restored.chunks[0]!.vector)).toEqual(Array.from(index.chunks[0]!.vector));
    expect(restored.chunks[0]!.docId).toBe("doc-1");
    expect(restored.chunks[0]!.text).toBe("Acme Corp signed clause 9");
    expect(restored.chunks[0]!.page).toBe(1);
    expect(restored.chunks[0]!.citation).toBe("m1#c0");
    expect(restored.chunks[0]!.bbox).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(Array.from(restored.chunks[0]!.sparseIndices!)).toEqual([1, 5]);
    expect(Array.from(restored.chunks[0]!.sparseValues!)).toEqual([1.0, 0.5]);

    expect(Array.from(restored.chunks[1]!.vector)).toEqual(Array.from(index.chunks[1]!.vector));
    expect(restored.chunks[1]!.page).toBeUndefined();
    expect(restored.chunks[1]!.citation).toBeUndefined();
    expect(restored.chunks[1]!.bbox).toBeUndefined();
    expect(restored.chunks[1]!.sparseIndices).toBeUndefined();
  });

  it("round-trips through IndexedDB (write -> read -> unpack) and forget deletes it", async () => {
    const index = sample();
    const blob = pack(index);

    await writeBlob("matter-1", blob);
    const read = await readBlob("matter-1");
    expect(read).not.toBeNull();
    const restored = unpack(read as Uint8Array);
    expect(restored.chunks.length).toBe(2);

    await deleteBlob("matter-1");
    const afterDelete = await readBlob("matter-1");
    expect(afterDelete).toBeNull();
  });

  it("returns null for a matter that was never persisted", async () => {
    const read = await readBlob("never-persisted-matter");
    expect(read).toBeNull();
  });
});
