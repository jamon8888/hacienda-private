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

export const GLINER_TOKENIZER_URL = `${API_BASE}/models/gliner-tokenizer.json`;

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
