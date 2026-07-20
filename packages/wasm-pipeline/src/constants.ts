interface ViteImportMeta {
  readonly env?: { readonly VITE_API_BASE?: string };
}

function resolveApiBase(): string {
  // Access import.meta.env via a direct property chain (not through an intermediate
  // variable) — bundlers that statically analyze import.meta (webpack) only recognize
  // property access/destructuring off the literal `import.meta`, and warn on anything else.
  const viteValue = (import.meta as unknown as ViteImportMeta).env?.VITE_API_BASE;
  const procValue =
    typeof process !== "undefined" && process.env && process.env["API_BASE"];
  const envValue = viteValue || procValue || null;
  if (envValue) return envValue;
  // services/mcp-server always serves this package's model/tokenizer/vendor routes from the
  // same origin as the page that loaded it — hardcoding "localhost" broke fetches whenever the
  // app was reached via 127.0.0.1 or a LAN IP (the browser CORS-blocks the cross-origin fetch;
  // the server sends no CORS headers). Fall back to the page's own origin instead.
  return typeof window !== "undefined" ? window.location.origin : "http://localhost:8787";
}

export const API_BASE = resolveApiBase();

export const E5_TOKENIZER_URL = `${API_BASE}/models/e5.tokenizer.json`;
export const E5_TOKENIZER_CONFIG_URL = `${API_BASE}/models/e5.tokenizer_config.json`;

// gliner's AutoTokenizer.from_pretrained(tokenizerPath) never treats `tokenizerPath` as a
// literal URL — even a full "http://..." string just gets inserted as the `{model}` segment of
// transformers.js's hub URL template, always prefixed with `env.remoteHost` (default
// "https://huggingface.co/"). So this is a *bare model id*, not a URL — ner.ts additionally
// overrides `env.remoteHost`/`env.remotePathTemplate` to repoint that template at our own
// server instead of huggingface.co, producing `${API_BASE}/models/gliner-tokenizer/tokenizer.json`
// (see ner.ts's configureOrtEnv doc comment).
export const GLINER_TOKENIZER_MODEL_ID = "gliner-tokenizer";

// @xenova/transformers bundles its own onnxruntime-web usage and, merely on import, sets the
// shared `ort.env.wasm.wasmPaths` global to its jsdelivr CDN default. Since our webpack config
// externalizes the bare "onnxruntime-web" specifier for every importer (see next.config.mjs),
// @xenova/transformers and our own embed.ts/ner.ts end up sharing the same module singleton —
// so that CDN default leaks into our own onnxruntime-web sessions unless explicitly overridden
// back to the copy served locally by services/mcp-server's `/vendor/onnxruntime-web/*` route.
export const ONNXRUNTIME_WEB_WASM_PATHS = `${API_BASE}/vendor/onnxruntime-web/`;

export const EMBED_DIM = 768;

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
