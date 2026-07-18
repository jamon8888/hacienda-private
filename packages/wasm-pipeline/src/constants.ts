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

/** Base URL of the Node service that serves model artifacts and the API. */
export const API_BASE = resolveApiBase();

/** Local URL for the e5 tokenizer JSON served by the Node service. */
export const E5_TOKENIZER_URL = `${API_BASE}/models/e5.tokenizer.json`;
/** Local URL for the e5 tokenizer config JSON served by the Node service. */
export const E5_TOKENIZER_CONFIG_URL = `${API_BASE}/models/e5.tokenizer_config.json`;

/** Local URL for the GLiNER tokenizer JSON served by the Node service. */
export const GLINER_TOKENIZER_URL = `${API_BASE}/models/gliner-tokenizer.json`;

/** Embedding dimensionality of multilingual-e5-base. */
export const EMBED_DIM = 768;

/** Supported ONNX model quantization levels. */
export type Quant = "int8" | "int4" | "fp32";
/** Supported e5 model size variants. */
export type E5Variant = "e5-base" | "e5-small";

/**
 * Build the local URL for an e5 ONNX model of a given variant and quantization.
 *
 * @param variant - The e5 size variant.
 * @param quant - The quantization level.
 * @returns The `${API_BASE}/models/...onnx` URL for the model.
 */
export function e5ModelUrl(variant: E5Variant, quant: Quant): string {
  // smallVariantsServed is gated OFF in scenario.ts; default path is e5-base.
  const name = variant === "e5-small" ? "e5-small" : "e5";
  return `${API_BASE}/models/${name}.${quant}.onnx`;
}

/**
 * Build the local URL for the GLiNER PII ONNX model of a given quantization.
 *
 * @param quant - The quantization level.
 * @returns The `${API_BASE}/models/gliner-pii.<quant>.onnx` URL.
 */
export function glinerModelUrl(quant: Quant): string {
  return `${API_BASE}/models/gliner-pii.${quant}.onnx`;
}
