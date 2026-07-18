import { test, expect } from "@playwright/test";
import { initWasm, detectCapabilities, selectScenario } from "../src/index";

test("initWasm resolves and capabilities return a profile", async () => {
  await initWasm();
  const profile = await detectCapabilities();
  expect(profile).toBeTruthy();
  const scenario = selectScenario(profile);
  expect(scenario).toBeTruthy();
  expect(typeof scenario.chunkSize).toBe("number");
});
