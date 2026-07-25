import { API_BASE } from "./constants";
import { cachedFetchBuffer, type FetchProgress } from "./model-cache";

const MODEL_BASE = `${API_BASE}/models/gliner2/gliner2-guardrails-pii-multi`;
const MODEL_URLS = {
  weights: `${MODEL_BASE}/model.safetensors`,
  tokenizer: `${MODEL_BASE}/tokenizer.json`,
  encoderConfig: `${MODEL_BASE}/encoder_config/config.json`,
} as const;

interface Gliner2Session {
  loadBytes(weights: Uint8Array, tokenizer: Uint8Array, encoderConfig: Uint8Array): void;
  extractNer(
    text: string,
    labels: string[],
    threshold?: number,
  ): Array<{ start: number; end: number; text: string; label: string }>;
}

interface Gliner2WasmModule {
  Gliner2Model: new () => Gliner2Session;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

class Gliner2WorkerSession implements Gliner2Session {
  private readonly worker: Worker;
  readonly ready: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL("./gliner2-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) request.resolve(event.data.result);
      else request.reject(new Error(event.data.error ?? "GLiNER2 Worker request failed"));
    };
    this.worker.onerror = (event) => {
      for (const request of this.pending.values()) request.reject(new Error(event.message));
      this.pending.clear();
    };
    this.ready = this.request("load", []).then(() => undefined);
  }

  loadBytes(weights: Uint8Array, tokenizer: Uint8Array, encoderConfig: Uint8Array): void {
    void this.request(
      "load",
      [weights.buffer, tokenizer.buffer, encoderConfig.buffer],
      [weights.buffer, tokenizer.buffer, encoderConfig.buffer],
    );
  }

  extractNer(
    _text: string,
    _labels: string[],
    _threshold?: number,
  ): Array<{ start: number; end: number; text: string; label: string }> {
    throw new Error("GLiNER2 Worker sessions require asynchronous extraction");
  }

  async extract(
    text: string,
    labels: string[],
    threshold: number,
  ): Promise<Array<{ start: number; end: number; text: string; label: string }>> {
    return (await this.request("extract", [text, labels, threshold])) as Array<{
      start: number;
      end: number;
      text: string;
      label: string;
    }>;
  }

  private request(command: string, args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, command, args }, transfer);
    });
  }
}

let sessionPromise: Promise<Gliner2Session> | null = null;

export function resetGliner2Model(): void {
  sessionPromise = null;
}

export async function ensureGliner2Model(onProgress?: (progress: FetchProgress) => void): Promise<Gliner2Session> {
  sessionPromise ??= (async () => {
    if (typeof Worker !== "undefined" && typeof window !== "undefined") {
      const worker = new Gliner2WorkerSession();
      await worker.ready;
      return worker;
    }
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
  const model = await ensureGliner2Model();
  const spans =
    model instanceof Gliner2WorkerSession
      ? await model.extract(text, [...labels], threshold)
      : model.extractNer(text, [...labels], threshold);
  return spans.map((span) => ({ kind: span.label, start: span.start, end: span.end, text: span.text }));
}
