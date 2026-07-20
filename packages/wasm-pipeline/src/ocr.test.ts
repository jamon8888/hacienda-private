import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it, expect, beforeAll } from "vitest";
import init from "@xberg-io/xberg-wasm";
import { defaultExtractionConfig } from "./ocr";
import type { ModelScenario } from "./scenario";

// Same Node-vs-browser wasm init story as edgevec (see search/spike.test.ts):
// the default init() does fetch(new URL(..., import.meta.url)), and Node's
// fetch doesn't support file:// URLs. Pre-warm with raw bytes once; runtime.ts's
// initWasm() then calls the browser-appropriate default() with no args, which
// is a no-op once the module-level wasm singleton is already set.
const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(require.resolve("@xberg-io/xberg-wasm/pkg/web/xberg_wasm_bg.wasm"));

beforeAll(async () => {
	await init({ module_or_path: wasmBytes });
}, 60_000);

const scenario: ModelScenario = {
	executionProviders: ["wasm"],
	quant: "int8",
	numThreads: 4,
	chunkSize: 1024,
	deferPii: false,
	modelVariant: "e5-base",
};

describe("ocr.ts defaultExtractionConfig", () => {
	it("keeps quality processing on and enables cache + acceleration", async () => {
		const cfg = await defaultExtractionConfig();
		expect(cfg.enableQualityProcessing).toBe(true);
		expect(cfg.useCache).toBe(true);
		expect(cfg.cacheNamespace).toBe("wasm-pipeline");
		expect(cfg.cacheTtlSecs).toBe(3600n);
		expect(cfg.useLayoutForMarkdown).toBe(true);
		expect(cfg.acceleration).toBeDefined();
	});

	it("sets maxConcurrentExtractions and tokenReduction from a scenario", async () => {
		const cfg = await defaultExtractionConfig(scenario);
		expect(cfg.maxConcurrentExtractions).toBe(scenario.numThreads);
		expect(cfg.tokenReduction).toBeDefined();
		expect(cfg.tokenReduction?.mode).toBe("balanced");
		expect(cfg.tokenReduction?.preserveImportantWords).toBe(true);
	});

	it("omits scenario-driven fields when no scenario is passed", async () => {
		const cfg = await defaultExtractionConfig();
		expect(cfg.maxConcurrentExtractions).toBeUndefined();
		expect(cfg.tokenReduction).toBeUndefined();
	});
});
