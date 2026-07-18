// @ts-check

/**
 * Next.js config for the Xberg thin-client UI.
 *
 * - `transpilePackages` covers the workspace packages consumed as TS source
 *   (`@xberg-io/core`, `@xberg-io/wasm-pipeline`).
 * - `output: "export"` static-exports the UI for the Node MCP server to serve from
 *   `public/`; static export doesn't support `headers()`, so the COOP/COEP headers
 *   ORT-Web threads/SharedArrayBuffer need are not currently set anywhere — revisit
 *   if cross-origin isolation turns out to be required at runtime.
 * - `@xberg-io/wasm-pipeline` still resolves to the local `lib/engine/` adapter
 *   (not the real workspace package directly) so the UI keeps one seam; the
 *   adapter itself imports the real package via the `@xberg-io/wasm-pipeline-real`
 *   alias below.
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
      "@xberg-io/wasm-pipeline-real": resolve(__dirname, "../../packages/wasm-pipeline/src/index.ts"),
    };

    // The browser-only wasm-pipeline pulls @xenova/transformers (for the XLM-R
    // tokenizer). That package's CJS graph static-resolves onnxruntime-node, a
    // native .node binary that webpack cannot parse. We only ever load the
    // browser builds (onnxruntime-web, dynamic import), so drop the native
    // node binding from the graph.
    config.resolve.alias = {
      ...config.resolve.alias,
      "onnxruntime-node": resolve(__dirname, "onnxruntime-node-stub.mjs"),
      crypto: false,
      "node:crypto": false,
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
