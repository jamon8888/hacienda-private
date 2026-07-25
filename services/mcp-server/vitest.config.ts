import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
