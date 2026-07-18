// Browser E2E harness entry point.
//
// Vite bundles this module and the accompanying index.html serves it. It imports
// the entire wasm-pipeline public API and attaches it to `window.XbergPipeline`
// so Playwright specs can drive the real library inside a Chromium page context
// via `page.evaluate(() => window.XbergPipeline.<fn>(...))`.
//
// Because this runs in the browser (not the Playwright Node worker), WebGPU /
// WebGL / WASM-SIMD / WebCrypto are the genuine browser implementations, which is
// exactly what these E2E tests are meant to exercise.
import * as pipeline from "../../src/index";

declare global {
  interface Window {
    XbergPipeline: typeof pipeline;
    __xbergReady: boolean;
  }
}

window.XbergPipeline = pipeline;
window.__xbergReady = true;
