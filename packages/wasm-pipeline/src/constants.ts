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

export const E5_TOKENIZER_URL = `${API_BASE}/models/e5.tokenizer.json`;
export const E5_TOKENIZER_CONFIG_URL = `${API_BASE}/models/e5.tokenizer_config.json`;

// Shared Rust-owned dense embedder (IBM Granite ModernBERT, 384 dimensions).
// The three files are served by the MCP model manifest and are verified before
// entering the WASM worker. Keep the revision in the URL-independent identity
// so a cache generation cannot silently mix model files.
export const GRANITE_EMBEDDING_MODEL_URL =
	`${API_BASE}/models/granite/granite-embedding-97m-multilingual-r2/model.safetensors`;
export const GRANITE_EMBEDDING_TOKENIZER_URL =
	`${API_BASE}/models/granite/granite-embedding-97m-multilingual-r2/tokenizer.json`;
export const GRANITE_EMBEDDING_CONFIG_URL =
	`${API_BASE}/models/granite/granite-embedding-97m-multilingual-r2/config.json`;
export const GRANITE_EMBEDDING_MODEL_SHA256 =
	"f3ea88b230492811046145513710e76b4cc8c2ad49e8708da0e7247e548903be";
export const GRANITE_EMBEDDING_TOKENIZER_SHA256 =
	"4f2842d568e2724370aec203652a42ac783c7937f8347a1a2cc7506d71f1582f";
export const GRANITE_EMBEDDING_CONFIG_SHA256 =
	"de948b0bdc6f356afad7a84b276d8dd7e7fe10fb9add1bb5e610621c28e41ebc";
export const GRANITE_EMBED_DIM = 384;
export const GRANITE_EMBEDDING_IDENTITY =
	"ibm-granite/granite-embedding-97m-multilingual-r2@835ad14087e140460703cf0fae09f97d469d65c2;bf16->f32;modernbert-384;cls;normalize=true";

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
