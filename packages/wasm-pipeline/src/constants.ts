interface ViteImportMeta {
  readonly env?: { readonly VITE_API_BASE?: string };
}

function resolveApiBase(): string {
  const meta = import.meta as unknown as ViteImportMeta;
  const viteValue = meta.env && meta.env.VITE_API_BASE;
  const procValue = typeof process !== "undefined" && process.env && process.env["API_BASE"];
  const envValue = viteValue || procValue || null;
  if (envValue) return envValue;
  // The mcp-server serves the API and the static UI from the same origin, on whatever port it's
  // actually running on — not necessarily 8787. Falling back to a hardcoded port broke
  // pushMirror/model downloads for every deployment on a different port; the browser's own
  // origin is the correct default in the environment this code actually runs in (a page the
  // server served).
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "http://localhost:8787";
}

export const API_BASE = resolveApiBase();
export const MODEL_MANIFEST_URL = `${API_BASE}/models/manifest.json`;

export const E5_TOKENIZER_URL = `${API_BASE}/models/e5.tokenizer.json`;
export const E5_TOKENIZER_CONFIG_URL = `${API_BASE}/models/e5.tokenizer_config.json`;

export const GRANITE_EMBED_DIM = 384;
export const GRANITE_EMBEDDING_IDENTITY =
  "ibm-granite/granite-embedding-97m-multilingual-r2@835ad14087e140460703cf0fae09f97d469d65c2;bf16->f32;modernbert-384;cls;normalize=true";
export const GRANITE_EMBEDDING_MANIFEST_NAMES = {
  model: "granite-embedding-97m-multilingual-r2.weights",
  tokenizer: "granite-embedding-97m-multilingual-r2.tokenizer",
  config: "granite-embedding-97m-multilingual-r2.config",
} as const;
export const GRANITE_EMBEDDING_FALLBACK_FILES = {
  model: "granite/granite-embedding-97m-multilingual-r2/model.safetensors",
  tokenizer: "granite/granite-embedding-97m-multilingual-r2/tokenizer.json",
  config: "granite/granite-embedding-97m-multilingual-r2/config.json",
} as const;
export const GRANITE_EMBEDDING_FALLBACK_SHA256 = {
  model: "f3ea88b230492811046145513710e76b4cc8c2ad49e8708da0e7247e548903be",
  tokenizer: "4f2842d568e2724370aec203652a42ac783c7937f8347a1a2cc7506d71f1582f",
  config: "de948b0bdc6f356afad7a84b276d8dd7e7fe10fb9add1bb5e610621c28e41ebc",
} as const;

// GLiNER2 Guardrails PII Multi model artifacts (Candle/WASM NER backend). Shared between
// gliner2.ts (main-thread loading path) and gliner2-worker.ts (dedicated-worker path) so both
// verify the same pinned digests instead of drifting independently.
export const GLINER2_MODEL_BASE = `${API_BASE}/models/gliner2/gliner2-guardrails-pii-multi`;
export const GLINER2_MODEL_URLS = {
  weights: `${GLINER2_MODEL_BASE}/model.safetensors`,
  tokenizer: `${GLINER2_MODEL_BASE}/tokenizer.json`,
  encoderConfig: `${GLINER2_MODEL_BASE}/encoder_config/config.json`,
} as const;
export const GLINER2_MODEL_SHA256 = {
  weights: "82ee0ed2483aa7eae3483e95b8622139f5bc7697de3294aec4d0d7088bdb7658",
  tokenizer: "f6df10ec83bea993035b2dd7c39345a3d4fcf23421c2adb6cb4ffc1e6d1bc4b5",
  encoderConfig: "f27dd63cc43a248d2566f0b6ad7a115db353676ce0561dcbca45bac766464c1a",
} as const;

// Bare repo-id (not a full URL): `@xenova/transformers`' `AutoTokenizer.from_pretrained()` always
// appends "/tokenizer.json" itself, so this is joined with `env.localModelPath` (see ner.ts) to
// produce `${API_BASE}/models/gliner-pii/tokenizer.json` — matching manifest.json's
// "gliner-pii-tokenizer" entry, from the same onnx-community/gliner_small-v2.1 HF repo the
// gliner-pii.{quant}.onnx model itself comes from.
export const GLINER_TOKENIZER_REPO_ID = "gliner-pii";

export const EMBED_DIM = GRANITE_EMBED_DIM;

export type Quant = "int8" | "int4" | "fp32";
export type E5Variant = "e5-base" | "e5-small";

export function e5ModelUrl(variant: E5Variant, quant: Quant): string {
  // smallVariantsServed is gated OFF in scenario.ts; default path is e5-base.
  const name = variant === "e5-small" ? "e5-small" : "e5";
  return `${API_BASE}/models/${name}.${quant}.onnx`;
}

export function glinerModelUrl(quant: Quant): string {
  return `${API_BASE}/models/gliner-pii.${quant}.onnx`;
}
