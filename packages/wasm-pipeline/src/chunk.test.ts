import { describe, it, expect } from "vitest";
import type { WasmExtractedDocument, WasmChunk } from "@xberg-io/xberg-wasm";
import { chunkExtraction, chunkPage, chunkCitation } from "./chunk";

function mockChunk(content: string, page: number, index: number): WasmChunk {
  return {
    content,
    metadata: { firstPage: page, lastPage: page, chunkIndex: index },
  } as unknown as WasmChunk;
}

function mockDoc(chunks: WasmChunk[]): WasmExtractedDocument {
  return { content: "doc-body", chunks } as unknown as WasmExtractedDocument;
}

describe("chunkExtraction", () => {
  it("returns the document chunks unchanged", () => {
    const doc = mockDoc([mockChunk("a", 1, 0), mockChunk("b", 2, 1)]);
    const out = chunkExtraction(doc);
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toBe("a");
    expect(out[1]?.content).toBe("b");
  });

  it("returns empty array when document has no chunks", () => {
    const doc = mockDoc([]);
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
