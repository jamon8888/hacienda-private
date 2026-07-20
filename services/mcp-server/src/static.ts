import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
    const pkg = require.resolve("@xberg-io/xberg-wasm/package.json");
    return dirname(pkg);
  } catch {
    return null;
  }
}

// The PDF viewer's default config points pdfium.wasm at jsdelivr's CDN — a real egress leak for a
// "no document content leaves the device" app (the WASM binary itself isn't document content, but
// every PDF view would silently phone home). Serve @embedpdf/pdfium's own dist/ locally instead so
// the browser loads it from a same-origin route with no external request.
export function resolveEmbedPdfiumDir(): string | null {
  try {
    const entry = require.resolve("@embedpdf/pdfium");
    // Walk up from the resolved entry to the package root (where package.json lives),
    // so the served root is `.../pdfium` and `/vendor/embedpdf/dist/pdfium.wasm` maps correctly.
    let dir = dirname(entry);
    while (dir && dir !== dirname(dir)) {
      if (existsSync(join(dir, "package.json"))) return dir;
      dir = dirname(dir);
    }
    return null;
  } catch {
    return null;
  }
}

// Matches the opening <head> tag, tolerant of attributes and case (e.g. <head lang="en">).
const HEAD_TAG = /<head(?=[\s>])[^>]*>/i;

/** Insert `window.__XBERG_TOKEN__` so the same-origin UI can read the session token. */
export function injectToken(html: string, token: string): string {
  const safe = JSON.stringify(token).replace(/</g, "\\u003c");
  const tag = `<script>window.__XBERG_TOKEN__=${safe};</script>`;
  const match = HEAD_TAG.exec(html);
  if (match) {
    const insertAt = match.index + match[0].length;
    return html.slice(0, insertAt) + tag + html.slice(insertAt);
  }
  return tag + html;
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
