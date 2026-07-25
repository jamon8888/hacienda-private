import { API_BASE } from "./constants";
import { cachedFetchBuffer } from "./model-cache";

interface Gliner2Model {
	loadBytes(weights: Uint8Array, tokenizer: Uint8Array, encoderConfig: Uint8Array): void;
	extractNer(text: string, labels: string[], threshold?: number): unknown;
}

interface Gliner2WasmModule {
	Gliner2Model: new () => Gliner2Model;
}

const BASE = `${API_BASE}/models/gliner2/gliner2-guardrails-pii-multi`;
const urls = [
	`${BASE}/model.safetensors`,
	`${BASE}/tokenizer.json`,
	`${BASE}/encoder_config/config.json`,
];
const expectedSha256 = [
	"82ee0ed2483aa7eae3483e95b8622139f5bc7697de3294aec4d0d7088bdb7658",
	"f6df10ec83bea993035b2dd7c39345a3d4fcf23421c2adb6cb4ffc1e6d1bc4b5",
	"f27dd63cc43a248d2566f0b6ad7a115db353676ce0561dcbca45bac766464c1a",
];
let model: Gliner2Model | undefined;

async function sha256(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

self.onmessage = async (event: MessageEvent<{ id: number; command: string; args: unknown[] }>) => {
		const { id, command, args } = event.data;
		try {
			if (command === "load") {
				const wasm = (await import("@xberg-io/xberg-wasm")) as unknown as Gliner2WasmModule;
				if (typeof wasm.Gliner2Model !== "function") throw new Error("GLiNER2 is unavailable in this WASM package");
				const bytes = await Promise.all(urls.map((url) => cachedFetchBuffer(url)));
				for (let index = 0; index < bytes.length; index++) {
					if (await sha256(bytes[index]!) !== expectedSha256[index]) {
						throw new Error(`GLiNER2 artifact integrity check failed for ${urls[index]}`);
					}
				}
				model = new wasm.Gliner2Model();
				model.loadBytes(...bytes.map((bytes) => new Uint8Array(bytes)) as [Uint8Array, Uint8Array, Uint8Array]);
				self.postMessage({ id, ok: true });
				return;
			}
			if (!model) throw new Error("GLiNER2 model is not loaded");
			if (command !== "extract") throw new Error(`unknown GLiNER2 Worker command: ${command}`);
			const [text, labels, threshold] = args as [string, string[], number];
			self.postMessage({ id, ok: true, result: model.extractNer(text, labels, threshold) });
		} catch (error) {
			self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
};
