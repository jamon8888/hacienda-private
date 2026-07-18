import { test, expect } from "./harness/fixture";

test("initWasm resolves and capabilities return a profile", async ({ harness }) => {
  const result = await harness.evaluate(async () => {
    const { initWasm, detectCapabilities, selectScenario } = window.XbergPipeline;
    await initWasm();
    const profile = await detectCapabilities();
    const scenario = selectScenario(profile);
    return { profile, chunkSizeType: typeof scenario.chunkSize, eps: scenario.executionProviders };
  });
  expect(result.profile).toBeTruthy();
  expect(result.chunkSizeType).toBe("number");
  // Running in a real browser, wasm is always an available execution provider.
  expect(result.eps).toContain("wasm");
});
