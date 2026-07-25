import { GLINER2_MODEL_SHA256, GLINER2_MODEL_URLS } from "./constants";
import { cachedFetchVerifiedBuffer } from "./model-cache";

interface Gliner2Model {
  loadBytes(weights: Uint8Array, tokenizer: Uint8Array, encoderConfig: Uint8Array): void;
  extractNer(text: string, labels: string[], threshold?: number): unknown;
}

interface Gliner2WasmModule {
  Gliner2Model: new () => Gliner2Model;
}

let model: Gliner2Model | undefined;

self.onmessage = async (event: MessageEvent<{ id: number; command: string; args: unknown[] }>) => {
  const { id, command, args } = event.data;
  try {
    if (command === "load") {
      const wasm = (await import("@xberg-io/xberg-wasm")) as unknown as Gliner2WasmModule;
      if (typeof wasm.Gliner2Model !== "function") throw new Error("GLiNER2 is unavailable in this WASM package");
      const [weights, tokenizer, encoderConfig] = await Promise.all([
        cachedFetchVerifiedBuffer(GLINER2_MODEL_URLS.weights, GLINER2_MODEL_SHA256.weights),
        cachedFetchVerifiedBuffer(GLINER2_MODEL_URLS.tokenizer, GLINER2_MODEL_SHA256.tokenizer),
        cachedFetchVerifiedBuffer(GLINER2_MODEL_URLS.encoderConfig, GLINER2_MODEL_SHA256.encoderConfig),
      ]);
      model = new wasm.Gliner2Model();
      model.loadBytes(new Uint8Array(weights), new Uint8Array(tokenizer), new Uint8Array(encoderConfig));
      self.postMessage({ id, ok: true });
      return;
    }
    if (!model) throw new Error("GLiNER2 model is not loaded");
    if (command !== "extract") throw new Error(`unknown GLiNER2 Worker command: ${command}`);
    const [text, labels, threshold] = args as [string, string[], number];
    self.postMessage({
      id,
      ok: true,
      result: model.extractNer(text, labels, threshold),
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
