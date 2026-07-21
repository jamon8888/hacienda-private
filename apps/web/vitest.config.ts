import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // @ts-expect-error -- `oxc` is a valid Vite 8/Rolldown config key at runtime (it configures
  // the JSX transform used for .tsx test files), but the bundled Vite types here haven't
  // caught up yet. Without it, oxc falls back to this project's tsconfig `jsx: "preserve"`
  // (required by Next.js) and leaves JSX untransformed, breaking every .test.tsx file.
  oxc: {
    jsx: "automatic",
  },
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
