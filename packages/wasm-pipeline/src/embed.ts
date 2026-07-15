import { E5_MODEL_URL, E5_TOKENIZER_REPO, EMBED_DIM } from "./constants";

export interface EmbeddableChunk {
  text: string;
}

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

let sessionPromise: Promise<OrtSessionHandle> | null = null;
let tokenizerPromise: Promise<CallableTokenizer> | null = null;

interface OrtSessionHandle {
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
  outputNames: string[];
  inputNames: string[];
}

type Prefix = "query" | "passage";

async function getSession(): Promise<OrtSessionHandle> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import("onnxruntime-web");
      const resp = await fetch(E5_MODEL_URL);
      const buf = await resp.arrayBuffer();
      const session = await ort.InferenceSession.create(buf, {
        executionProviders: ["webgpu", "wasm"],
        graphOptimizationLevel: "all",
      });
      return session as unknown as OrtSessionHandle;
    })();
  }
  return sessionPromise;
}

async function getTokenizer(): Promise<CallableTokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const { AutoTokenizer } = await import("@xenova/transformers");
      // TODO(plan-mismatch): The plan serves a single `/models/e5.tokenizer.json`
      // from Node, but transformers.js `AutoTokenizer` requires a full tokenizer
      // directory (tokenizer.json + config + special_tokens_map). Until Node
      // serves a directory, we pull the matching tokenizer from the HF repo
      // `Xenova/multilingual-e5-base` (same weights as the served e5.onnx).
      const tok = await AutoTokenizer.from_pretrained(E5_TOKENIZER_REPO);
      return tok as unknown as CallableTokenizer;
    })();
  }
  return tokenizerPromise;
}

async function embedOne(text: string, prefix: Prefix): Promise<Float32Array> {
  const [session, tok] = await Promise.all([getSession(), getTokenizer()]);
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

export async function embedChunks(chunks: EmbeddableChunk[]): Promise<Float32Array[]> {
  return Promise.all(chunks.map((c) => embedOne(c.text, "passage")));
}

export async function embedQuery(text: string): Promise<Float32Array> {
  return embedOne(text, "query");
}
