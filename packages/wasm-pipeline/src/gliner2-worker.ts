import { API_BASE } from "./constants";
import { cachedFetchBuffer } from "./model-cache";

interface Gliner2Model {
	loadBytes(weights: Uint8Array, tokenizer: Uint8Array, encoderConfig: Uint8Array): void;
	extractNer(text: string, labels: string[], threshold?: number): unknown;
}

interface Gliner2WasmModule {
	Gliner2Model: new () => Gliner2Model;
}

const BASE = `${API_BASE}/models/gliner2/gliner2-base`;
const urls = [
	`${BASE}/model.safetensors`,
	`${BASE}/tokenizer.json`,
	`${BASE}/encoder_config/config.json`,
];
const expectedSha256 = [
	"845fc4bd93c525b86124c58ab4f56c9eacf8587953086b14c501fab25957c007",
	"1b7fbabfb4c690bed84c6793bfecae9b8dfe205751b04f9ffd1e76a1e7df9c16",
	"9840a4db70bc007e6b65d336ebe2bddc53bc2ce210dc5757e50d5bb17122f7cd",
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
