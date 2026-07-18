// @ts-check

/**
 * Next.js config for the Xberg thin-client UI.
 *
 * - `transpilePackages` covers the workspace packages consumed as TS source
 *   (`@xberg-io/core`, and — once Plan 2 lands — `@xberg-io/wasm-pipeline`).
 * - COOP/COEP headers are required so the browser engine (ORT-Web WASM threads /
 *   SharedArrayBuffer, WebGPU→WebGL→WASM-SIMD chain) can run cross-origin isolated.
 *
 * NOTE (deviation): `@xberg-io/wasm-pipeline` (Plan 2) is developed on a parallel
 * branch and is not present in this baseline. To keep `next build` + `tsc` green,
 * `@xberg-io/wasm-pipeline` is aliased (here and in tsconfig `paths`) to the local
 * typed engine adapter at `lib/engine/`. When the real workspace package is present,
 * remove the webpack alias below + the tsconfig path and add it to `transpilePackages`
 * and to `dependencies` as `workspace:*`.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  transpilePackages: ["@xberg-io/core", "@xberg-io/wasm-pipeline", "@xberg-io/wasm-pipeline-real"],
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@": resolve(__dirname, "."),
      "@xberg-io/wasm-pipeline": resolve(__dirname, "lib/engine/index.ts"),
      "@xberg-io/wasm-pipeline-real": resolve(__dirname, "../packages/wasm-pipeline/src/index.ts"),
    };

    // The browser-only wasm-pipeline pulls @xenova/transformers (for the XLM-R
    // tokenizer). That package's CJS graph static-resolves onnxruntime-node, a
    // native .node binary that webpack cannot parse. We only ever load the
    // browser builds (onnxruntime-web, dynamic import), so drop the native
    // node binding from the graph.
    config.resolve.alias = {
      ...config.resolve.alias,
      "onnxruntime-node": resolve(__dirname, "onnxruntime-node-stub.mjs"),
      "crypto": false,
    };

    // onnxruntime-web (and gliner's copy) resolve to their *node* entry via the
    // `exports` map when webpack applies the `node` condition, which pulls a native
    // ESM build that cannot be parsed for the browser. Force the browser/import
    // conditions so the browser ESM bundle is selected instead.
    config.resolve.conditionNames = ["browser", "import", "require"];

    // The ORT browser bundle references its .wasm + worker assets via new URL(...);
    // keep webpack from trying to parse those as JS modules.
    config.module = config.module ?? {};
    config.module.rules = config.module.rules ?? [];
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });
    // The onnxruntime-web ESM bundles are .mjs files that webpack would otherwise
    // try to parse as CommonJS scripts; treat them as ESM (javascript/auto).
    config.module.rules.push({
      test: /\.mjs$/,
      include: /onnxruntime/,
      type: "javascript/auto",
    });
    config.resolve.fullySpecified = false;

    return config;
  },
};

export default nextConfig;
