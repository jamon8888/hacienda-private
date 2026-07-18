import { test, expect } from "@playwright/test";
import { initWasm, detectPii, listPiiTypes, detectCapabilities, selectScenario } from "../src/index";

test("GLiNER detects EMAIL/PHONE entities", async () => {
  await initWasm();
  const scenario = selectScenario(await detectCapabilities());
  const text = "Contact john.doe@example.com or call +1 555 0100 about matter Acme.";
  const entities = await detectPii(text, listPiiTypes(), scenario);
  const kinds = entities.map((e) => e.kind);
  expect(kinds.some((k) => /EMAIL/i.test(k) || /PHONE/i.test(k))).toBeTruthy();
});
