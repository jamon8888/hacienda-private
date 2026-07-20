import type { WasmExtractionConfig } from "@xberg-io/xberg-wasm";
import { getWasm } from "./runtime";
import type { ModelScenario } from "./scenario";

export type WasmOcrStrategy = "tesseract";

export async function withTesseractOcr(
	base: WasmExtractionConfig,
	strategy: WasmOcrStrategy = "tesseract",
	language?: string[],
): Promise<WasmExtractionConfig> {
	const m = await getWasm();
	const ocr = new m.WasmOcrConfig(true, strategy, language ?? []);
	base.ocr = ocr;
	return base;
}

// Best-quality + real perf levers (verified against crates/xberg-wasm/src/lib.rs
// and crates/xberg/src/text/quality_processor.rs): enableQualityProcessing only
// adds a quality_score + light normalization and is never worth disabling for
// speed. useCache/cacheNamespace/cacheTtlSecs turn on the Rust-side extraction
// cache; maxConcurrentExtractions and tokenReduction are the real, quality-safe
// speed levers.
export async function defaultExtractionConfig(scenario?: ModelScenario): Promise<WasmExtractionConfig> {
	const m = await getWasm();
	const cfg = new m.WasmExtractionConfig();

	cfg.enableQualityProcessing = true;
	cfg.useLayoutForMarkdown = true;
	cfg.useCache = true;
	cfg.cacheNamespace = "wasm-pipeline";
	cfg.cacheTtlSecs = 3600n;

	// WasmExecutionProviderType (this xberg-wasm build) is { Auto, Cpu, CoreMl,
	// Cuda, TensorRt } -- there is no WebGPU option for extraction acceleration
	// here (CoreMl/Cuda/TensorRt are native-only and irrelevant in wasm). Auto
	// lets the engine pick the best available path instead of forcing CPU.
	cfg.acceleration = new m.WasmAccelerationConfig(m.WasmExecutionProviderType.Auto, 0);

	if (scenario) {
		cfg.maxConcurrentExtractions = scenario.numThreads;
		cfg.tokenReduction = new m.WasmTokenReductionOptions("balanced", true);
	}

	return cfg;
}
