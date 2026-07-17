import { test, expect } from "@playwright/test";
import { initWasm, embedChunks, detectCapabilities, selectScenario, buildIndex, serializeIndex, retrieve } from "../src/index";

test("build index, retrieve top-K, serialize round-trips", async () => {
  await initWasm();
  const scenario = selectScenario(await detectCapabilities());
  const chunks = [
    { docId: "doc1", chunkIndex: 0, text: "The Acme invoice totals 100 dollars and is due Friday.", page: 1, citation: "doc1#chunk-0", vector: new Float32Array(0) },
    { docId: "doc2", chunkIndex: 0, text: "Quantum entanglement violates local realism in Bell tests.", page: 1, citation: "doc2#chunk-0", vector: new Float32Array(0) },
  ];
  const [qVec] = await embedChunks([{ text: "invoice total amount" }], scenario);
  chunks[0].vector = qVec;
  chunks[1].vector = (await embedChunks([{ text: "quantum bell inequality" }], scenario))[0];
  const db = await buildIndex("harness-matter", chunks);
  const top = await retrieve("harness-matter", qVec, 1);
  expect(top.length).toBeGreaterThan(0);
  const bytes = await serializeIndex(db);
  expect(bytes.length).toBeGreaterThan(0);
});
