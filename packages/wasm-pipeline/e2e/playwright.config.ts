import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8787",
    trace: "on-first-retry",
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=SharedArrayBuffer"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ../../services/mcp-server/dist/index.js serve --port 8787 --data-dir ${process.env.RUNNER_TEMP || "/tmp"}/xberg-e2e`,
    port: 8787,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
