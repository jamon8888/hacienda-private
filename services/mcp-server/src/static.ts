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
    const pkg = require.resolve("@xberg-io/xberg-wasm/package.json");
    return dirname(pkg);
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
