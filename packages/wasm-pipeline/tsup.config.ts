import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/gliner2-worker.ts"],
	format: ["esm"],
	dts: false,
	clean: true,
	sourcemap: true,
	target: "es2022",
	external: ["@xberg-io/xberg-wasm", "@xberg-io/core", "onnxruntime-web", "gliner", "edgevec", "zod"],
});
