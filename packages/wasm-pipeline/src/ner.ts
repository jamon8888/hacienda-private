import type { PiiEntity } from "@xberg-io/core";
import type { Gliner, IEntityResult, InitConfig, IONNXWebSettings, ITransformersSettings } from "gliner";
import { API_BASE, GLINER_TOKENIZER_REPO_ID, glinerModelUrl } from "./constants";
import { cachedFetchBuffer, withScopedFetchOverride, type FetchProgress } from "./model-cache";
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
		// `AutoTokenizer.from_pretrained(GLINER_TOKENIZER_REPO_ID)` joins this with the bare repo
		// id + "tokenizer.json" to build the request URL — see the ensurePiiModel() comment below.
		env.localModelPath = `${API_BASE}/models/`;
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
// `@xenova/transformers`, which always builds its request URL as `pathJoin(tokenizerPath,
// "tokenizer.json")`. Passing a full URL there (as this used to) double-appends into a broken
// path like ".../gliner-tokenizer.json/tokenizer.json" — and since the joined string is itself an
// absolute http(s) URL, transformers.js treats it as "remote" and refuses it outright under
// `allowRemoteModels = false`, regardless of it actually being our own local server. Passing the
// bare repo id `GLINER_TOKENIZER_REPO_ID` instead keeps requestURL a plain relative path, which
// takes the "local" branch and resolves via `env.localModelPath` (set in disableRemoteModels()
// above) to `${API_BASE}/models/gliner-pii/tokenizer.json` — matching manifest.json's
// "gliner-pii-tokenizer" entry, from the same HF repo the gliner-pii.{quant}.onnx model comes
// from. `env.allowRemoteModels = false` and `allowLocalModels: true` below stay as
// belt-and-suspenders guards against ever falling back to a real HF fetch.
//
// The GLiNER model binary is a separate story: gliner's `ONNXWebWrapper.init()` calls
// `ort.InferenceSession.create(modelPath, ...)` with a URL string, so `onnxruntime-web` does its
// own internal fetch that we can't observe or redirect. We pre-fetch the same URL ourselves via
// `cachedFetchBuffer` (for progress + Cache Storage), then run `model.initialize()` inside
// `withScopedFetchOverride` so the internal fetch is served from those same bytes instead of
// hitting the network a second time.
export function resetPiiModel(): void {
	cachedSig = null;
	modelPromise = null;
}

export async function ensurePiiModel(
	scenario: ModelScenario,
	onProgress?: (p: FetchProgress) => void,
): Promise<Gliner> {
	const sig = JSON.stringify({
		quant: scenario.quant,
		ep: scenario.executionProviders[0],
	});
	if (!modelPromise || sig !== cachedSig) {
		cachedSig = sig;
		modelPromise = (async () => {
			try {
				const { Gliner: GlinerClass } = await import("gliner");
				await disableRemoteModels();
				const transformersSettings: ITransformersSettings = {
					allowLocalModels: true,
					useBrowserCache: true,
				};
				const modelUrl = glinerModelUrl(scenario.quant);
				const onnxSettings: IONNXWebSettings = {
					modelPath: modelUrl,
					executionProvider: scenario.executionProviders[0],
				};
				const config: InitConfig = {
					tokenizerPath: GLINER_TOKENIZER_REPO_ID,
					onnxSettings,
					transformersSettings,
				};
				const model = new GlinerClass(config);
				const modelBytes = await cachedFetchBuffer(modelUrl, onProgress);
				await withScopedFetchOverride(modelUrl, modelBytes, () => model.initialize());
				return model;
			} catch (err) {
				// Don't cache a rejected promise: callers outside warmup's retry loop (e.g. detectPii)
				// would otherwise fail forever even after the network recovers. Clear the memoized
				// state so the next call retries from scratch.
				if (sig === cachedSig) {
					cachedSig = null;
					modelPromise = null;
				}
				throw err;
			}
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
	const model = await ensurePiiModel(scenario);
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
