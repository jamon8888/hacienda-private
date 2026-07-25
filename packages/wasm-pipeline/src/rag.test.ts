import { beforeEach, describe, expect, it, vi } from "vitest";

const loadMock = vi.fn();

vi.mock("edgevec", () => {
  class FakeEdgeVecConfig {
    metric = "cosine";

    constructor(public readonly dim: number) {}
  }

  class FakeEdgeVec {
    insertWithMetadata(): void {}
    async save(): Promise<void> {}
    search(): Array<{ id: number; score: number }> {
      return [];
    }
    getAllMetadata(): Record<string, unknown> | undefined {
      return undefined;
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

describe("rag retrieve", () => {
  beforeEach(() => {
    loadMock.mockReset();
  });

  it("reopens the saved index and maps query hits back to cited chunks", async () => {
    const fakeDb = {
      search: vi.fn(() => [
        { id: 9, score: 0.98 },
        { id: 4, score: 0.55 },
      ]),
      getAllMetadata: vi.fn((id: number) => {
        if (id === 9) {
          return {
            doc_id: "doc-1",
            chunk_index: 3,
            text: "Granite retrieval hit",
            page: 7,
            citation: "doc-1:3",
            bbox: JSON.stringify({ x: 1, y: 2, w: 3, h: 4 }),
          };
        }
        return {
          doc_id: "doc-2",
          chunk_index: 0,
          text: "Fallback hit",
          citation: "doc-2:0",
        };
      }),
    };
    loadMock.mockResolvedValue(fakeDb);

    const { retrieve } = await import("./rag");
    const hits = await retrieve(
      "matter-42",
      new Float32Array([0.1, 0.2, 0.3]),
      2,
    );

    expect(loadMock).toHaveBeenCalledWith("edgevec:matter-42");
    expect(fakeDb.search).toHaveBeenCalledWith(
      new Float32Array([0.1, 0.2, 0.3]),
      2,
    );
    expect(hits).toEqual([
      {
        doc_id: "doc-1",
        chunk_index: 3,
        text: "Granite retrieval hit",
        page: 7,
        bbox: { x: 1, y: 2, w: 3, h: 4 },
        score: 0.98,
        citation: "doc-1:3",
      },
      {
        doc_id: "doc-2",
        chunk_index: 0,
        text: "Fallback hit",
        page: undefined,
        bbox: undefined,
        score: 0.55,
        citation: "doc-2:0",
      },
    ]);
  });
});
