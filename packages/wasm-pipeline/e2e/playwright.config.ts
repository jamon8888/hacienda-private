import { defineConfig, devices } from "@playwright/test";

// E2E config: run the real wasm-pipeline library inside Chromium.
//
// Two web servers are started:
//   1. The Node MCP server on :8787 — serves /models and accepts /rag/mirror.
//   2. A Vite dev server on :8788 — hosts the browser harness page
//      (e2e/harness) with COOP/COEP and proxies /models,/rag to :8787.
//
// Specs navigate to the Vite harness (baseURL) and drive the library via
// `page.evaluate(() => window.XbergPipeline.*)`, so WebGPU/WebGL/WASM-SIMD/
// WebCrypto are the genuine browser implementations.
const HARNESS_PORT = Number(process.env["E2E_HARNESS_PORT"] ?? 8788);
const MCP_PORT = Number(process.env["E2E_MCP_PORT"] ?? 8787);
const dataDir = `${process.env["RUNNER_TEMP"] || "/tmp"}/xberg-e2e`;

export default defineConfig({
  testDir: "./",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? `http://localhost:${HARNESS_PORT}`,
    trace: "on-first-retry",
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=SharedArrayBuffer"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node ../../services/mcp-server/dist/index.js serve --port ${MCP_PORT} --data-dir ${dataDir}`,
      port: MCP_PORT,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `npx vite --config harness/vite.config.ts --port ${HARNESS_PORT} --strictPort`,
      port: HARNESS_PORT,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { E2E_MCP_TARGET: `http://localhost:${MCP_PORT}`, E2E_HARNESS_PORT: String(HARNESS_PORT) },
    },
  ],
});
