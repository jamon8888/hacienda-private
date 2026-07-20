import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveUiDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.XBERG_WEB_APP_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    resolve(process.cwd(), "apps/web/out"),
    resolve(process.cwd(), "apps/web/.next/standalone"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/out"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/.next/standalone"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function resolveWasmPackageDir(): string | null {
  try {
    // Resolve the package's main entry (pkg/web/xberg_wasm.js), not its root — the wasm binary
    // and JS glue live under pkg/web/, not at the package root alongside package.json.
    const entry = require.resolve("@xberg-io/xberg-wasm");
    return dirname(entry);
  } catch {
    return null;
  }
}

export function resolveOnnxRuntimeWebDistDir(): string | null {
  try {
    // onnxruntime-web's own dist/*.mjs bundles self-locate their companion .wasm/worker
    // assets relative to their own `import.meta.url` at *runtime* — that only resolves
    // correctly if the browser fetches the .mjs file from a real served URL rather than
    // webpack bundling it (bundling bakes in the build machine's disk path instead). The
    // app's webpack config externalizes "onnxruntime-web" to a native `import()` of this
    // route instead of bundling it.
    // Its `exports` map doesn't expose "./package.json" as a subpath, so resolve the main
    // entry (dist/ort.node.min.js) and take its containing directory instead.
    const entry = require.resolve("onnxruntime-web");
    return dirname(entry);
  } catch {
    return null;
  }
}

export function resolveEmbedPdfiumDir(): string | null {
  try {
    // The PDF viewer's default config points pdfium.wasm at jsdelivr's CDN — a real
    // egress leak for a "no document content leaves the device" app (the WASM binary
    // itself isn't document content, but every PDF view would silently phone home).
    // Same fix as onnxruntime-web: serve @embedpdf/pdfium's own dist/ locally instead.
    const entry = require.resolve("@embedpdf/pdfium");
    return dirname(entry);
  } catch {
    return null;
  }
}

export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Xberg Document Intelligence</title></head>
<body>
  <h1>Xberg Document Intelligence</h1>
  <p>The browser UI (apps/web) is built in a later plan. The Node service is running.</p>
  <ul>
    <li><a href="/models/e5.onnx">/models/e5.onnx</a></li>
    <li><a href="/models/gliner-pii.onnx">/models/gliner-pii.onnx</a></li>
    <li><a href="/wasm/">/wasm/</a> (xberg wasm package, when installed)</li>
  </ul>
</body>
</html>`;
