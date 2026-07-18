import { test, expect } from "./harness/fixture";

test("e5 embed returns 768-dim vectors, deterministic", async ({ harness }) => {
  const result = await harness.evaluate(async () => {
    const { initWasm, embedChunks, embedQuery, detectCapabilities, selectScenario, EMBED_DIM } = window.XbergPipeline;
    await initWasm();
    const scenario = selectScenario(await detectCapabilities());
    const [v1] = await embedChunks([{ text: "The Acme invoice totals 100 dollars." }], scenario);
    const [v2] = await embedChunks([{ text: "The Acme invoice totals 100 dollars." }], scenario);
    const q = await embedQuery("invoice total", scenario);
    return {
      dim: EMBED_DIM,
      v1len: v1?.length ?? 0,
      qlen: q.length,
      equal: JSON.stringify(Array.from(v1 ?? [])) === JSON.stringify(Array.from(v2 ?? [])),
    };
  });
  expect(result.v1len).toBe(result.dim);
  expect(result.qlen).toBe(result.dim);
  expect(result.equal).toBe(true);
});
