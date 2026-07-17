import { test, expect } from "@playwright/test";
import { initWasm, embedChunks, embedQuery, detectCapabilities, selectScenario, EMBED_DIM } from "../src/index";

test("e5 embed returns 768-dim vectors, deterministic", async () => {
  await initWasm();
  const scenario = selectScenario(await detectCapabilities());
  const [v1] = await embedChunks([{ text: "The Acme invoice totals 100 dollars." }], scenario);
  expect(v1.length).toBe(EMBED_DIM);
  const [v2] = await embedChunks([{ text: "The Acme invoice totals 100 dollars." }], scenario);
  expect(Array.from(v1)).toEqual(Array.from(v2));
  const q = await embedQuery("invoice total", scenario);
  expect(q.length).toBe(EMBED_DIM);
});
