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
  transpilePackages: ["@xberg-io/core", "@xberg-io/wasm-pipeline"],
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@": resolve(__dirname, "."),
      "@xberg-io/wasm-pipeline": resolve(__dirname, "lib/engine/index.ts"),
    };
    return config;
  },
};

export default nextConfig;
