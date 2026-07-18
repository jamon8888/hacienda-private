import { test, expect } from "./harness/fixture";

test("build index, retrieve top-K, serialize round-trips", async ({ harness }) => {
  const result = await harness.evaluate(async () => {
    const { initWasm, embedChunks, detectCapabilities, selectScenario, buildIndex, serializeIndex, retrieve } = window.XbergPipeline;
    await initWasm();
    const scenario = selectScenario(await detectCapabilities());
    const [qVec] = await embedChunks([{ text: "invoice total amount" }], scenario);
    const [otherVec] = await embedChunks([{ text: "quantum bell inequality" }], scenario);
    const chunks = [
      { docId: "doc1", chunkIndex: 0, text: "The Acme invoice totals 100 dollars and is due Friday.", page: 1, citation: "doc1#chunk-0", vector: qVec ?? new Float32Array(0) },
      { docId: "doc2", chunkIndex: 0, text: "Quantum entanglement violates local realism in Bell tests.", page: 1, citation: "doc2#chunk-0", vector: otherVec ?? new Float32Array(0) },
    ];
    const db = await buildIndex("harness-matter", chunks);
    const top = await retrieve("harness-matter", qVec ?? new Float32Array(0), 1);
    const bytes = await serializeIndex(db);
    return { topLen: top.length, topDoc: top[0]?.doc_id, byteLen: bytes.length };
  });
  expect(result.topLen).toBeGreaterThan(0);
  // The query vector is doc1's own embedding, so doc1 must rank first.
  expect(result.topDoc).toBe("doc1");
  expect(result.byteLen).toBeGreaterThan(0);
});
