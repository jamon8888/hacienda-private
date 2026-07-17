import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@xberg-io/wasm-pipeline": resolve(rootDir, "lib/engine/index.ts"),
      "@xberg-io/wasm-pipeline-real": resolve(rootDir, "../../packages/wasm-pipeline/src/index.ts"),
      "@": rootDir,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".next", "e2e/**"],
  },
});
