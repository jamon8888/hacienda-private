import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build wasm-pipeline and xberg-wasm before tests to ensure the alias target exists
execSync("pnpm --filter wasm-pipeline build", { stdio: "inherit", cwd: resolve(__dirname, "..") });
execSync("pnpm --filter xberg-wasm build:wasm:web", { stdio: "inherit", cwd: resolve(__dirname, "..") });

export default defineConfig({
  resolve: {
    alias: {
      "@xberg-io/node-pipeline": resolve(__dirname, "../../packages/node-pipeline/src/index.ts"),
      "@xberg-io/xberg-wasm": resolve(__dirname, "../../crates/xberg-wasm/pkg/web/xberg_wasm.js"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/._*"],
  },
});
