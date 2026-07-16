interface ViteImportMeta {
  readonly env?: { readonly VITE_API_BASE?: string };
}

function resolveApiBase(): string {
  const meta = import.meta as unknown as ViteImportMeta;
  const viteValue = meta.env && meta.env.VITE_API_BASE;
  const procValue =
    typeof process !== "undefined" && process.env && process.env["API_BASE"];
  const envValue = viteValue || procValue || null;
  return envValue ?? "http://localhost:8787";
}

export const API_BASE = resolveApiBase();

export const E5_MODEL_URL = `${API_BASE}/models/e5.onnx`;
export const E5_TOKENIZER_URL = `${API_BASE}/models/e5.tokenizer.json`;
export const E5_TOKENIZER_CONFIG_URL = `${API_BASE}/models/e5.tokenizer_config.json`;

export const GLINER_MODEL_URL = `${API_BASE}/models/gliner-pii.onnx`;
export const GLINER_TOKENIZER_URL = `${API_BASE}/models/gliner-tokenizer.json`;

export const EMBED_DIM = 768;
