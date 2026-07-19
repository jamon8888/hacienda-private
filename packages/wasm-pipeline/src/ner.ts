import type { PiiEntity } from "@xberg-io/core";
import type { Gliner, IEntityResult, InitConfig, IONNXWebSettings, ITransformersSettings } from "gliner";
import { GLINER_TOKENIZER_URL, glinerModelUrl } from "./constants";
import type { ModelScenario } from "./scenario";

// DEFAULT_SCENARIO is a defensive fallback; ingest.ts and query.ts now pass a real selectScenario() output.
const DEFAULT_SCENARIO: ModelScenario = {
	executionProviders: ["webgpu", "wasm"],
	quant: "int8",
	numThreads: 4,
	chunkSize: 1024,
	deferPii: false,
	modelVariant: "e5-base",
};
let warnedDefaultScenario = false;

// Remote-model guard: gliner's `initialize()` calls `AutoTokenizer.from_pretrained(tokenizerPath)`
// via `@xenova/transformers`. Turn off remote fetching up-front so it can never fall back to
// huggingface.co / hf.co. `env` only exists in the browser/Node transformers build; guard the import.
async function disableRemoteModels(): Promise<void> {
	try {
		const { env } = await import("@xenova/transformers");
		env.allowRemoteModels = false;
	} catch {
		// transformers runtime unavailable here (e.g. typecheck-only) — no-op.
	}
}

const PII_TYPES = ["person", "organization", "location", "email", "phone", "date", "ssn", "financial"] as const;

export function listPiiTypes(): readonly string[] {
	return PII_TYPES;
}

let cachedSig: string | null = null;
let modelPromise: Promise<Gliner> | null = null;

// Local tokenizer loading (no Hugging Face egress).
//
// gliner's `initialize()` calls `AutoTokenizer.from_pretrained(tokenizerPath)` internally via
// `@xenova/transformers`. We point `tokenizerPath` at the Node-served local tokenizer JSON
// (`${API_BASE}/models/gliner-tokenizer.json`) rather than an HF repo id, so no runtime request
// to huggingface.co / hf.co is made. We also disable remote model loading in transformers.js
// (`env.allowRemoteModels = false`) and tell gliner to only use local models, as belt-and-suspenders
// guards so the library can never fall back to a remote HF fetch.
//
// NOTE (cross-plan dependency): this requires Plan 1's `services/mcp-server` ModelCache to serve a
// GLiNER tokenizer file at `/models/gliner-tokenizer.json` (standard transformers tokenizer.json
// layout). If the Node service serves it under a different name, update `GLINER_TOKENIZER_URL`.
async function getModel(scenario: ModelScenario): Promise<Gliner> {
	const sig = JSON.stringify({
		quant: scenario.quant,
		ep: scenario.executionProviders[0],
	});
	if (!modelPromise || sig !== cachedSig) {
		cachedSig = sig;
		modelPromise = (async () => {
			const { Gliner: GlinerClass } = await import("gliner");
			await disableRemoteModels();
			const transformersSettings: ITransformersSettings = {
				allowLocalModels: true,
				useBrowserCache: false,
			};
			const onnxSettings: IONNXWebSettings = {
				modelPath: glinerModelUrl(scenario.quant),
				executionProvider: scenario.executionProviders[0],
			};
			const config: InitConfig = {
				tokenizerPath: GLINER_TOKENIZER_URL,
				onnxSettings,
				transformersSettings,
			};
			const model = new GlinerClass(config);
			await model.initialize();
			return model;
		})();
	}
	return modelPromise;
}

export async function detectPii(
	text: string,
	types: readonly string[] = PII_TYPES,
	scenario: ModelScenario = DEFAULT_SCENARIO,
): Promise<PiiEntity[]> {
	if (scenario === DEFAULT_SCENARIO && !warnedDefaultScenario) {
		warnedDefaultScenario = true;
		console.warn(
			"[wasm-pipeline] detectPii called without a ModelScenario — using DEFAULT_SCENARIO; callers should pass selectScenario() output (see plan task 4-5)",
		);
	}
	const model = await getModel(scenario);
	const result = await model.inference({
		texts: [text],
		entities: [...types],
		flatNer: true,
		threshold: 0.5,
	});
	const ents = result[0] ?? [];
	return ents.map((e: IEntityResult) => ({
		kind: e.label,
		start: e.start,
		end: e.end,
		text: e.spanText,
	}));
}
