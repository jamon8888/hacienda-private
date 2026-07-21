import { describe, it, expect } from "vitest";
import { openVault } from "@xberg-io/wasm-pipeline-real";
import { mergeIntoAccumulator, type MirrorPiiSpan, type MirrorChunk } from "./mirror-merge";

const PASS = "correct horse battery staple";

function entry(token: string, original: string, start: number) {
  return { token, original, category: "PERSON", kind: "PERSON", start, end: start + original.length };
}
function span(docId: string, token: string, start: number): MirrorPiiSpan {
  return { doc_id: docId, kind: "PERSON", start, end: start + 5, token };
}
function chunk(docId: string, i: number): MirrorChunk {
  return { doc_id: docId, chunk_index: i, text: `redacted ${docId} ${i}`, score: 1, citation: `${docId}#chunk-${i}` };
}

describe("mergeIntoAccumulator", () => {
  it("keeps both documents' pii + chunks and reseals a vault holding all entries", async () => {
    const a = await mergeIntoAccumulator(
      undefined,
      { entries: [entry("{{PERSON_1}}", "Alice", 0)], pii: [span("docA", "{{PERSON_1}}", 0)], chunks: [chunk("docA", 0)] },
      PASS,
    );
    const b = await mergeIntoAccumulator(
      a,
      { entries: [entry("{{PERSON_1}}", "Bob", 3)], pii: [span("docB", "{{PERSON_1}}", 3)], chunks: [chunk("docB", 0)] },
      PASS,
    );

    expect(b.pii.map((p) => p.doc_id).sort()).toEqual(["docA", "docB"]);
    expect(b.chunks.map((c) => c.doc_id).sort()).toEqual(["docA", "docB"]);

    const entries = await openVault(
      { cipher: Uint8Array.from(b.vaultCipher), salt: Uint8Array.from(b.vaultSalt) },
      PASS,
    );
    expect(entries.map((e) => e.original).sort()).toEqual(["Alice", "Bob"]);
  });
});
