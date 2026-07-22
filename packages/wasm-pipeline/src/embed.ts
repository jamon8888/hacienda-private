import { cachedFetchBuffer, cachedFetchJson, type FetchProgress } from "./model-cache";
import { E5_TOKENIZER_URL, E5_TOKENIZER_CONFIG_URL, EMBED_DIM, e5ModelUrl } from "./constants";
import type { ModelScenario } from "./scenario";

export interface EmbeddableChunk {
  text: string;
}

const DEFAULT_SCENARIO: ModelScenario = {
  executionProviders: ["webgpu", "wasm"],
  quant: "int8",
  numThreads: 4,
  chunkSize: 1024,
  deferPii: false,
  modelVariant: "e5-base",
};

interface TokenizerOutput {
  input_ids: number[];
  attention_mask: number[];
  token_type_ids?: number[];
}

type CallableTokenizer = ((text: string, options?: { return_tensor?: boolean }) => TokenizerOutput) &
  Record<string, unknown>;

interface OrtTensor {
  data: Float32Array | BigInt64Array;
  dims: number[];
  type: string;
}

let cachedSig: string | null = null;
let sessionPromise: Promise<OrtSessionHandle> | null = null;
let tokenizerPromise: Promise<CallableTokenizer> | null = null;
let warnedDefaultScenario = false;

interface OrtSessionHandle {
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
  outputNames: string[];
  inputNames: string[];
}

type Prefix = "query" | "passage";

export function resetEmbedSession(): void {
  cachedSig = null;
  sessionPromise = null;
}

export async function ensureEmbedSession(
  scenario: ModelScenario = DEFAULT_SCENARIO,
  onProgress?: (p: FetchProgress) => void,
): Promise<OrtSessionHandle> {
  const sig = JSON.stringify({
    ep: scenario.executionProviders,
    quant: scenario.quant,
    variant: scenario.modelVariant,
    numThreads: scenario.numThreads,
  });
  if (!sessionPromise || sig !== cachedSig) {
    cachedSig = sig;
    sessionPromise = (async () => {
      try {
        console.log("DEBUG2 import ort");
        // "/wasm" is the wasm-only bundle (no webgpu/webgl code); the bare "onnxruntime-web"
        // entry pulls in the full bundle instead, which shares its worker module with
        // webgpu/jsep and corrupts wasm init when that fails (see scenario.ts).
        const ort = await import("onnxruntime-web/wasm");
        console.log("DEBUG2 ort imported, numThreads=", scenario.numThreads);
        ort.env.wasm.numThreads = scenario.numThreads;
        // onnxruntime-web auto-detects its worker/wasm asset URLs from import.meta.url, which
        // this webpack build doesn't preserve as a real browser URL — it resolves to the
        // node_modules file:// source path instead, so every backend fails. Point it at a copy
        // of those assets under public/ort/ (served statically alongside the rest of the app)
        // instead of relying on that broken auto-detection.
        ort.env.wasm.wasmPaths = "/ort/";
        console.log("DEBUG2 fetching model", e5ModelUrl(scenario.modelVariant, scenario.quant));
        const buf = await cachedFetchBuffer(e5ModelUrl(scenario.modelVariant, scenario.quant), onProgress);
        console.log("DEBUG2 model bytes", buf.byteLength, "EPs", JSON.stringify(scenario.executionProviders));
        const session = await ort.InferenceSession.create(buf, {
          executionProviders: scenario.executionProviders,
          graphOptimizationLevel: "all",
        });
        console.log("DEBUG2 session created");
        return session as unknown as OrtSessionHandle;
      } catch (err) {
        // Don't cache a rejected promise: callers outside warmup's retry loop (e.g. embedQuery)
        // would otherwise fail forever even after the network recovers. Clear the memoized
        // state so the next call retries from scratch.
        if (sig === cachedSig) {
          cachedSig = null;
          sessionPromise = null;
        }
        throw err;
      }
    })();
  }
  return sessionPromise;
}

// Local tokenizer loading (no Hugging Face egress).
//
// The Node service (Plan 1 `services/mcp-server`) serves the e5 tokenizer assets from
// its model cache at `${API_BASE}/models/e5.tokenizer.json` (+ companion `tokenizer_config.json`).
// We fetch those JSON files directly from the same Node origin that serves `e5.onnx`, then build
// the tokenizer in-process with `@xenova/transformers`' `XLMRobertaTokenizer` constructor.
// `multilingual-e5-base` is XLM-RoBERTa based, and its `tokenizer_config.json` declares
// `tokenizer_class: "XLMRobertaTokenizer"`, so we construct that class directly from the JSON —
// no `from_pretrained(repoId)` call, and therefore no runtime request to huggingface.co / hf.co.
// `env.allowRemoteModels` is forced off as a belt-and-suspenders guard so the library can never
// fall back to a remote HF fetch.
async function getTokenizer(): Promise<CallableTokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      try {
        const { env, XLMRobertaTokenizer } = await import("@xenova/transformers");
        env.allowRemoteModels = false;
        env.allowLocalModels = false;

        const [tokenizerJSON, tokenizerConfig] = await Promise.all([
          cachedFetchJson(E5_TOKENIZER_URL),
          cachedFetchJson(E5_TOKENIZER_CONFIG_URL),
        ]);
        const tok = new XLMRobertaTokenizer(tokenizerJSON, tokenizerConfig);
        return tok as unknown as CallableTokenizer;
      } catch (err) {
        // Don't cache a rejected promise — clear so the next call retries the tokenizer fetch.
        tokenizerPromise = null;
        throw err;
      }
    })();
  }
  return tokenizerPromise;
}

async function embedOne(
  text: string,
  prefix: Prefix,
  scenario: ModelScenario = DEFAULT_SCENARIO,
): Promise<Float32Array> {
  const [session, tok] = await Promise.all([ensureEmbedSession(scenario), getTokenizer()]);
  const prefixed = prefix === "query" ? `query: ${text}` : `passage: ${text}`;
  const enc = tok(prefixed, { return_tensor: false });
  const inputIds = enc.input_ids;
  const attn = enc.attention_mask;
  const seqLen = inputIds.length;

  const ort = await import("onnxruntime-web/wasm");
  const ids = BigInt64Array.from(inputIds.map((x: number) => BigInt(x)));
  const mask = BigInt64Array.from(attn.map((x: number) => BigInt(x)));
  const types = new BigInt64Array(seqLen);
  const allFeeds: Record<string, OrtTensor> = {
    input_ids: new ort.Tensor("int64", ids, [1, seqLen]) as unknown as OrtTensor,
    attention_mask: new ort.Tensor("int64", mask, [1, seqLen]) as unknown as OrtTensor,
    token_type_ids: new ort.Tensor("int64", types, [1, seqLen]) as unknown as OrtTensor,
  };
  // Not every e5 ONNX export declares a token_type_ids input — only feed names the session
  // actually asks for, or ort rejects the run with "invalid input 'token_type_ids'".
  const feeds: Record<string, OrtTensor> = Object.fromEntries(
    Object.entries(allFeeds).filter(([name]) => session.inputNames.includes(name)),
  );

  const out = await session.run(feeds);
  const values = Object.values(out);
  const outTensor = values[0];
  if (!outTensor) throw new Error("e5 session produced no output");
  const data = outTensor.data as Float32Array;
  const dims = outTensor.dims;
  const seq = dims[1] ?? seqLen;
  const hidden = EMBED_DIM;

  const vec = new Float32Array(hidden);
  let count = 0;
  for (let i = 0; i < seq; i++) {
    if (attn[i] === 1) {
      count++;
      for (let d = 0; d < hidden; d++) {
        vec[d] = (vec[d] ?? 0) + (data[i * hidden + d] ?? 0);
      }
    }
  }
  for (let d = 0; d < hidden; d++) {
    vec[d] = (vec[d] ?? 0) / Math.max(count, 1);
  }

  let norm = 0;
  for (let d = 0; d < hidden; d++) {
    norm += (vec[d] ?? 0) * (vec[d] ?? 0);
  }
  const denom = Math.sqrt(norm) || 1;
  for (let d = 0; d < hidden; d++) {
    vec[d] = (vec[d] ?? 0) / denom;
  }
  return vec;
}

// DEFAULT_SCENARIO is a defensive fallback; ingest.ts and query.ts now pass a real selectScenario() output.
export async function embedChunks(
  chunks: EmbeddableChunk[],
  scenario: ModelScenario = DEFAULT_SCENARIO,
): Promise<Float32Array[]> {
  if (scenario === DEFAULT_SCENARIO && !warnedDefaultScenario) {
    warnedDefaultScenario = true;
    console.warn(
      "[wasm-pipeline] embed called without a ModelScenario — using DEFAULT_SCENARIO; callers should pass selectScenario() output (see plan task 4-5)",
    );
  }
  return Promise.all(chunks.map((c) => embedOne(c.text, "passage", scenario)));
}

// DEFAULT_SCENARIO is a defensive fallback; ingest.ts and query.ts now pass a real selectScenario() output.
export async function embedQuery(text: string, scenario: ModelScenario = DEFAULT_SCENARIO): Promise<Float32Array> {
  if (scenario === DEFAULT_SCENARIO && !warnedDefaultScenario) {
    warnedDefaultScenario = true;
    console.warn(
      "[wasm-pipeline] embed called without a ModelScenario — using DEFAULT_SCENARIO; callers should pass selectScenario() output (see plan task 4-5)",
    );
  }
  return embedOne(text, "query", scenario);
}
