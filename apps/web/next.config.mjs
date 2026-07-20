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
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  transpilePackages: ["@xberg-io/core", "@xberg-io/wasm-pipeline", "@xberg-io/wasm-pipeline-real"],
  webpack(config, { webpack }) {
    // @xenova/transformers' getFile() branches on `typeof process !== 'undefined' &&
    // process?.release?.name === 'node'` to decide whether it's running in Node (and can set
    // a `User-Agent` request header) or a browser (plain fetch, no custom headers). webpack's
    // `process` polyfill for the browser bundle reports `release.name === 'node'` regardless,
    // so this always takes the Node branch — and setting `User-Agent` via fetch() is a
    // forbidden header operation in browsers, which makes Chrome reject the *entire* request
    // with a bare "TypeError: Failed to fetch" (this is what broke GLiNER's tokenizer fetch,
    // which goes through this function; our own direct `fetch()` calls elsewhere don't).
    // Force the check to read as non-Node at build time.
    config.plugins = config.plugins ?? [];
    config.plugins.push(new webpack.DefinePlugin({ "process.release": JSON.stringify({}) }));

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
    };

    // gliner's own exports map lists "require" before "import" as keys — condition
    // *priority* is decided by each package's own key order, not by conditionNames'
    // order — so forcing "require" into conditionNames (needed elsewhere) makes it
    // resolve to its CJS build. webpack doesn't wrap that CJS build in a shim in this
    // bundling context, so it executes with no `exports`/`require` global and throws
    // "exports is not defined" (or similar) at runtime. Force it to its ESM entry
    // directly instead.
    config.resolve.conditionNames = ["browser", "import", "require"];
    config.resolve.alias = {
      ...config.resolve.alias,
      "@hugeicons/core-free-icons": require.resolve("@hugeicons/core-free-icons", {
        paths: [__dirname],
      }).replace(/cjs/, "esm"),
      gliner: require
        .resolve("gliner", { paths: [resolve(__dirname, "../../packages/wasm-pipeline")] })
        .replace(/\.cjs$/, ".mjs"),
    };

    // onnxruntime-web's .mjs bundles self-locate their companion .wasm/worker assets
    // relative to their own `import.meta.url` at runtime. Bundling them through webpack
    // breaks that in two ways: (1) webpack bakes `import.meta.url` in as the *build
    // machine's disk path* (`file:///C:/Users/.../onnxruntime-web/dist/...`) since this
    // isn't a real ESM output target, so any Worker/asset URL resolved from it is a local
    // path the browser refuses to fetch cross-origin; (2) webpack's static `new URL(x,
    // import.meta.url)` asset-rewriting still partially matches onnxruntime-web's
    // deliberately bundler-proofed `let u = URL; new u(...)` construction and substitutes
    // a broken polyfill, throwing "e.replace is not a function". Both gliner (which imports
    // subpaths like "onnxruntime-web/webgpu" for its own ONNX session, not just the bare
    // specifier) and our own wasm-pipeline hit this — externalize every onnxruntime-web
    // subpath so ANY importer gets a genuine native `import()` of the copy served at runtime
    // by services/mcp-server's `/vendor/onnxruntime-web/*` route, with real import.meta.url
    // semantics, instead of a webpack-bundled copy. Mapping matches the package's own
    // exports map (each subpath's "default"/plain browser ESM bundle filename).
    const ONNXRUNTIME_WEB_SUBPATH_FILES = {
      "onnxruntime-web": "ort.bundle.min.mjs",
      "onnxruntime-web/all": "ort.all.bundle.min.mjs",
      "onnxruntime-web/wasm": "ort.wasm.bundle.min.mjs",
      "onnxruntime-web/webgl": "ort.webgl.min.mjs",
      "onnxruntime-web/webgpu": "ort.webgpu.bundle.min.mjs",
    };
    const externalizeOnnxRuntimeWeb = ({ request }, callback) => {
      const file = ONNXRUNTIME_WEB_SUBPATH_FILES[request];
      if (file) {
        return callback(null, `import /vendor/onnxruntime-web/${file}`);
      }
      callback();
    };
    config.externals = Array.isArray(config.externals)
      ? [...config.externals, externalizeOnnxRuntimeWeb]
      : config.externals
        ? [config.externals, externalizeOnnxRuntimeWeb]
        : [externalizeOnnxRuntimeWeb];
    // externalsType "import" emits a native `await import(...)` at each call site — webpack
    // needs to be told the output target actually supports that syntax (it doesn't infer it
    // from Next's browserslist config here). Without `asyncFunction`, webpack assumes the
    // target can't run `async`/`await` and downlevel-warns even though every browser target
    // we ship to supports it natively.
    config.output = {
      ...config.output,
      environment: { ...config.output?.environment, dynamicImport: true, asyncFunction: true },
    };

    // The ORT browser bundle references its .wasm + worker assets via new URL(...);
    // keep webpack from trying to parse those as JS modules.
    config.module = config.module ?? {};
    config.module.rules = config.module.rules ?? [];
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });
    config.resolve.fullySpecified = false;

    return config;
  },
};

export default nextConfig;
