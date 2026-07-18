import { defineConfig } from "vite";

// Vite dev server that hosts the browser E2E harness for the wasm-pipeline.
//
// - Serves `e2e/harness/index.html` (which loads `main.ts` → `window.XbergPipeline`).
// - Sets COOP/COEP so the page is cross-origin isolated, enabling SharedArrayBuffer
//   and multi-threaded onnxruntime-web.
// - Proxies `/models` and `/rag` to the Node MCP server on :8787, so model fetches
//   and mirror uploads are same-origin from the harness page's perspective
//   (satisfying the local-first egress guard, which allows localhost).
const MCP_TARGET = process.env["E2E_MCP_TARGET"] ?? "http://localhost:8787";
const HARNESS_PORT = Number(process.env["E2E_HARNESS_PORT"] ?? 5178);

const crossOriginIsolation = {
  name: "cross-origin-isolation",
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      next();
    });
  },
};

export default defineConfig({
  root: __dirname,
  server: {
    port: HARNESS_PORT,
    strictPort: true,
    proxy: {
      "/models": { target: MCP_TARGET, changeOrigin: true },
      "/rag": { target: MCP_TARGET, changeOrigin: true },
    },
  },
  plugins: [crossOriginIsolation],
  // The harness imports @xberg-io/xberg-wasm; let Vite pre-bundle it.
  optimizeDeps: { exclude: ["@xberg-io/xberg-wasm", "onnxruntime-web"] },
});
