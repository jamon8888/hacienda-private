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

type CallableTokenizer = ((
  text: string,
  options?: { return_tensor?: boolean },
) => TokenizerOutput) & Record<string, unknown>;

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

async function getSession(scenario: ModelScenario = DEFAULT_SCENARIO): Promise<OrtSessionHandle> {
  const sig = JSON.stringify({
    ep: scenario.executionProviders,
    quant: scenario.quant,
    variant: scenario.modelVariant,
    numThreads: scenario.numThreads,
  });
  if (!sessionPromise || sig !== cachedSig) {
    cachedSig = sig;
    sessionPromise = (async () => {
      const ort = await import("onnxruntime-web");
      ort.env.wasm.numThreads = scenario.numThreads;
      const resp = await fetch(e5ModelUrl(scenario.modelVariant, scenario.quant));
      const buf = await resp.arrayBuffer();
      const session = await ort.InferenceSession.create(buf, {
        executionProviders: scenario.executionProviders,
        graphOptimizationLevel: "all",
      });
      return session as unknown as OrtSessionHandle;
    })();
  }
  return sessionPromise;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch local tokenizer asset ${url}: ${res.status}`);
  }
  return res.json();
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
      const { env, XLMRobertaTokenizer } = await import("@xenova/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = false;

      const [tokenizerJSON, tokenizerConfig] = await Promise.all([
        fetchJson(E5_TOKENIZER_URL),
        fetchJson(E5_TOKENIZER_CONFIG_URL),
      ]);
      const tok = new XLMRobertaTokenizer(tokenizerJSON, tokenizerConfig);
      return tok as unknown as CallableTokenizer;
    })();
  }
  return tokenizerPromise;
}


async function embedOne(text: string, prefix: Prefix, scenario: ModelScenario = DEFAULT_SCENARIO): Promise<Float32Array> {
  const [session, tok] = await Promise.all([getSession(scenario), getTokenizer()]);
  const prefixed = prefix === "query" ? `query: ${text}` : `passage: ${text}`;
  const enc = tok(prefixed, { return_tensor: false });
  const inputIds = enc.input_ids;
  const attn = enc.attention_mask;
  const seqLen = inputIds.length;

  const ort = await import("onnxruntime-web");
  const ids = BigInt64Array.from(inputIds.map((x: number) => BigInt(x)));
  const mask = BigInt64Array.from(attn.map((x: number) => BigInt(x)));
  const types = new BigInt64Array(seqLen);
  const feeds: Record<string, OrtTensor> = {
    input_ids: new ort.Tensor("int64", ids, [1, seqLen]) as unknown as OrtTensor,
    attention_mask: new ort.Tensor("int64", mask, [1, seqLen]) as unknown as OrtTensor,
    token_type_ids: new ort.Tensor("int64", types, [1, seqLen]) as unknown as OrtTensor,
  };

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

// TODO(plan3 task 6): thread real selectScenario() into query.ts; remove DEFAULT_SCENARIO default
export async function embedChunks(chunks: EmbeddableChunk[], scenario: ModelScenario = DEFAULT_SCENARIO): Promise<Float32Array[]> {
  if (scenario === DEFAULT_SCENARIO && !warnedDefaultScenario) {
    warnedDefaultScenario = true;
    console.warn("[wasm-pipeline] embed called without a ModelScenario — using DEFAULT_SCENARIO; callers should pass selectScenario() output (see plan task 4-5)");
  }
  return Promise.all(chunks.map((c) => embedOne(c.text, "passage", scenario)));
}

// TODO(plan3 task 6): thread real selectScenario() into query.ts; remove DEFAULT_SCENARIO default
export async function embedQuery(text: string, scenario: ModelScenario = DEFAULT_SCENARIO): Promise<Float32Array> {
  if (scenario === DEFAULT_SCENARIO && !warnedDefaultScenario) {
    warnedDefaultScenario = true;
    console.warn("[wasm-pipeline] embed called without a ModelScenario — using DEFAULT_SCENARIO; callers should pass selectScenario() output (see plan task 4-5)");
  }
  return embedOne(text, "query", scenario);
}
