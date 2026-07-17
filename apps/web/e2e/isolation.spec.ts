import { test, expect } from "@playwright/test";

test("COOP/COEP headers present on UI, wasm, and models routes", async ({ request }) => {
  for (const path of ["/", "/wasm/xberg_wasm_bg.wasm", "/models/e5.int8.onnx"]) {
    const res = await request.get(path);
    expect(res.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
  }
});

test("SharedArrayBuffer is available in page context", async ({ page }) => {
  await page.goto("/");
  const has = await page.evaluate(() => typeof SharedArrayBuffer !== "undefined");
  expect(has).toBeTruthy();
});
