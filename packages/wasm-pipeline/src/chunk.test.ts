import { describe, it, expect } from "vitest";
import type { WasmExtractedDocument, WasmChunk } from "@xberg-io/xberg-wasm";
import { chunkExtraction, chunkPage, chunkCitation, chunkBoundingBox, toBoundingBox } from "./chunk";

function mockChunk(content: string, page: number, index: number): WasmChunk {
  return {
    content,
    metadata: { firstPage: page, lastPage: page, chunkIndex: index },
  } as unknown as WasmChunk;
}

function mockDocWithNodes(nodes: unknown[]): WasmExtractedDocument {
  return {
    content: "doc-body",
    chunks: [],
    document: { nodes } as unknown as WasmExtractedDocument["document"],
  } as unknown as WasmExtractedDocument;
}

function mockDocWithChunks(chunks: WasmChunk[]): WasmExtractedDocument {
  return { content: "doc-body", chunks } as unknown as WasmExtractedDocument;
}

function mockNode(page: number, box: { x0: number; y0: number; x1: number; y1: number }): unknown {
  return { page, bbox: box };
}

describe("chunkExtraction", () => {
  it("returns the document chunks unchanged", () => {
    const doc = mockDocWithChunks([mockChunk("a", 1, 0), mockChunk("b", 2, 1)]);
    const out = chunkExtraction(doc);
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toBe("a");
    expect(out[1]?.content).toBe("b");
  });

  it("returns empty array when document has no chunks", () => {
    const doc = mockDocWithChunks([]);
    expect(chunkExtraction(doc)).toEqual([]);
  });
});

describe("chunkPage / chunkCitation", () => {
  it("reads the first page from chunk metadata", () => {
    expect(chunkPage(mockChunk("x", 7, 3))).toBe(7);
  });

  it("builds a stable citation from doc id and chunk index", () => {
    expect(chunkCitation("folder-9", mockChunk("x", 7, 3))).toBe("folder-9#chunk-3");
  });
});

describe("toBoundingBox", () => {
  it("converts wasm corner coords to top-left + w/h", () => {
    expect(toBoundingBox({ x0: 10, y0: 20, x1: 110, y1: 70 } as never)).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 50,
    });
  });
});

describe("chunkBoundingBox", () => {
  it("picks the first node bbox on the chunk's page", () => {
    const doc = mockDocWithNodes([
      mockNode(1, { x0: 5, y0: 5, x1: 55, y1: 25 }),
      mockNode(2, { x0: 0, y0: 0, x1: 10, y1: 10 }),
    ]);
    expect(chunkBoundingBox(doc, mockChunk("x", 1, 0))).toEqual({ x: 5, y: 5, w: 50, h: 20 });
  });

  it("returns undefined when no node has a bbox or structure is absent", () => {
    const doc = mockDocWithNodes([mockNode(1, undefined as never)]);
    expect(chunkBoundingBox(doc, mockChunk("x", 1, 0))).toBeUndefined();
    expect(chunkBoundingBox({ content: "x" } as never, mockChunk("x", 1, 0))).toBeUndefined();
  });
});
