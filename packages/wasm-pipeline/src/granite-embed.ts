import { GRANITE_EMBEDDING_IDENTITY, GRANITE_EMBED_DIM } from "./constants";
import { cachedFetchVerifiedBuffer, type FetchProgress } from "./model-cache";
import { resolveGraniteArtifacts } from "./model-manifest";

interface GraniteWasmModule {
  default: (input?: unknown) => Promise<unknown>;
  GraniteEmbeddingModel: new () => {
    loadBytes(weights: Uint8Array, tokenizer: Uint8Array, config: Uint8Array): void;
    embedDocuments(texts: string[]): number[][];
    embedQuery(text: string): number[];
    identity(): unknown;
  };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

let worker: Worker | null = null;
let directModel: InstanceType<GraniteWasmModule["GraniteEmbeddingModel"]> | null = null;
let loadPromise: Promise<void> | null = null;
let sequence = 0;
const pending = new Map<number, Pending>();

function workerFor(): Worker | undefined {
  if (typeof Worker === "undefined") return undefined;
  if (!worker) {
    worker = new Worker(new URL("./granite-embed-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        id: number;
        ok: boolean;
        error?: string;
        [key: string]: unknown;
      };
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(message);
      else request.reject(new Error(message.error ?? "Granite worker request failed"));
    };
    worker.onerror = (event) => {
      for (const request of pending.values()) request.reject(new Error(event.message || "Granite worker failed"));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function callWorker(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<Record<string, unknown>> {
  const instance = workerFor();
  if (!instance) return Promise.reject(new Error("worker unavailable"));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as Record<string, unknown>),
      reject,
    });
    instance.postMessage({ ...message, id }, transfer);
  });
}

async function loadDirect(weights: ArrayBuffer, tokenizer: ArrayBuffer, config: ArrayBuffer): Promise<void> {
  const wasm = (await import("@xberg-io/xberg-wasm")) as unknown as GraniteWasmModule;
  await wasm.default();
  directModel = new wasm.GraniteEmbeddingModel();
  directModel.loadBytes(new Uint8Array(weights), new Uint8Array(tokenizer), new Uint8Array(config));
}

export async function ensureGraniteEmbedder(onProgress?: (progress: FetchProgress) => void): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const artifacts = await resolveGraniteArtifacts();
      const [weights, tokenizer, config] = await Promise.all([
        cachedFetchVerifiedBuffer(artifacts.model.url, artifacts.model.sha256, onProgress),
        cachedFetchVerifiedBuffer(artifacts.tokenizer.url, artifacts.tokenizer.sha256),
        cachedFetchVerifiedBuffer(artifacts.config.url, artifacts.config.sha256),
      ]);
      const instance = workerFor();
      if (instance) {
        await callWorker({ op: "load", weights, tokenizer, config }, [weights, tokenizer, config]);
      } else {
        await loadDirect(weights, tokenizer, config);
      }
    })().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  await loadPromise;
}

export async function embedChunks(
  chunks: { text: string }[],
  onProgress?: (progress: FetchProgress) => void,
): Promise<Float32Array[]> {
  await ensureGraniteEmbedder(onProgress);
  if (directModel)
    return directModel.embedDocuments(chunks.map((chunk) => chunk.text)).map((vector) => new Float32Array(vector));
  const result = await callWorker({
    op: "documents",
    texts: chunks.map((chunk) => chunk.text),
  });
  return (result["vectors"] as number[][]).map((vector) => new Float32Array(vector));
}

export async function embedQuery(text: string, onProgress?: (progress: FetchProgress) => void): Promise<Float32Array> {
  await ensureGraniteEmbedder(onProgress);
  if (directModel) return new Float32Array(directModel.embedQuery(text));
  const result = await callWorker({ op: "query", text });
  return new Float32Array(result["vector"] as number[]);
}

export function graniteEmbeddingIdentity(): string {
  return GRANITE_EMBEDDING_IDENTITY;
}

export function graniteEmbeddingDimension(): number {
  return GRANITE_EMBED_DIM;
}

export function resetGraniteEmbedder(): void {
  worker?.terminate();
  worker = null;
  directModel = null;
  loadPromise = null;
  for (const request of pending.values()) request.reject(new Error("Granite embedder reset"));
  pending.clear();
}
