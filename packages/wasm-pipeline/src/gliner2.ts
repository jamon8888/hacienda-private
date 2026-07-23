import { API_BASE } from "./constants";
import { cachedFetchBuffer, type FetchProgress } from "./model-cache";

const MODEL_BASE = `${API_BASE}/models/gliner2/gliner2-base`;
const MODEL_URLS = {
	weights: `${MODEL_BASE}/model.safetensors`,
	tokenizer: `${MODEL_BASE}/tokenizer.json`,
	encoderConfig: `${MODEL_BASE}/encoder_config/config.json`,
} as const;

interface Gliner2Session {
	loadBytes(weights: Uint8Array, tokenizer: Uint8Array, encoderConfig: Uint8Array): void;
	extractNer(text: string, labels: string[], threshold?: number): Array<{ start: number; end: number; text: string; label: string }>;
}

interface Gliner2WasmModule {
	Gliner2Model: new () => Gliner2Session;
}

let sessionPromise: Promise<Gliner2Session> | null = null;

export function resetGliner2Model(): void {
	sessionPromise = null;
}

export async function ensureGliner2Model(onProgress?: (progress: FetchProgress) => void): Promise<Gliner2Session> {
	sessionPromise ??= (async () => {
		const wasm = (await import("@xberg-io/xberg-wasm")) as unknown as Gliner2WasmModule;
		if (typeof wasm.Gliner2Model !== "function") {
			throw new Error("GLiNER2 is unavailable in this WASM package; regenerate xberg-wasm first");
		}
		const [weights, tokenizer, encoderConfig] = await Promise.all([
			cachedFetchBuffer(MODEL_URLS.weights, onProgress),
			cachedFetchBuffer(MODEL_URLS.tokenizer, onProgress),
			cachedFetchBuffer(MODEL_URLS.encoderConfig, onProgress),
		]);
		const model = new wasm.Gliner2Model();
		model.loadBytes(new Uint8Array(weights), new Uint8Array(tokenizer), new Uint8Array(encoderConfig));
		return model;
	})().catch((error) => {
		sessionPromise = null;
		throw error;
	});
	return sessionPromise;
}

export async function detectGliner2(
	text: string,
	labels: readonly string[],
	threshold = 0.5,
): Promise<Array<{ kind: string; start: number; end: number; text: string }>> {
	const spans = (await ensureGliner2Model()).extractNer(text, [...labels], threshold);
	return spans.map((span) => ({ kind: span.label, start: span.start, end: span.end, text: span.text }));
}
