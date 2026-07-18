import { expect } from "@playwright/test";

export async function expectIsolated(page: import("@playwright/test").Page) {
  const isolated = await page.evaluate(
    () => (window as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated === true,
  );
  expect(isolated, "page must be cross-origin isolated for WebGPU/WASM").toBeTruthy();
}
