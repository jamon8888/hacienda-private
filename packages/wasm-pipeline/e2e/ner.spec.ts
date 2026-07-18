import { test, expect } from "./harness/fixture";

test("GLiNER detects EMAIL/PHONE entities", async ({ harness }) => {
  const kinds = await harness.evaluate(async () => {
    const { initWasm, detectPii, listPiiTypes, detectCapabilities, selectScenario } = window.XbergPipeline;
    await initWasm();
    const scenario = selectScenario(await detectCapabilities());
    const text = "Contact john.doe@example.com or call +1 555 0100 about matter Acme.";
    const entities = await detectPii(text, listPiiTypes(), scenario);
    return entities.map((e) => e.kind);
  });
  expect(kinds.some((k) => /EMAIL/i.test(k) || /PHONE/i.test(k))).toBeTruthy();
});
