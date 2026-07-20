import type {
	WasmExtractionConfig,
	WasmExtractionResult,
	WasmExtractedDocument,
	WasmChunk,
	WasmChunkingConfig,
	WasmOcrConfig,
} from "@xberg-io/xberg-wasm";

export type XbergWasm = typeof import("@xberg-io/xberg-wasm");

let wasmMod: XbergWasm | null = null;

export async function initWasm(): Promise<void> {
	const mod = (await import("@xberg-io/xberg-wasm")) as XbergWasm;
	await mod.default();
	wasmMod = mod;
}

export async function getWasm(): Promise<XbergWasm> {
	if (!wasmMod) await initWasm();
	return wasmMod as XbergWasm;
}

// JS-side content-hash cache: the wasm extract_bytes path may bypass xberg's
// own Rust-side cache (see ocr.ts's useCache/cacheNamespace), so a repeat
// extraction of identical bytes within one browser session still costs a
// full extraction without this. Keyed on content hash only -- correct as
// long as a given caller passes the same *effective* config for the same
// bytes across calls, which holds for this pipeline's actual call pattern
// (ingestFolder always derives config deterministically from language +
// scenario). A future caller that re-extracts the same bytes with a
// meaningfully different config would need a config-aware cache key; this
// does not attempt to fingerprint the opaque WasmExtractionConfig instance.
const extractionCache = new Map<string, WasmExtractionResult>();

async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function extractDocument(
	file: File | Uint8Array,
	config?: WasmExtractionConfig,
): Promise<WasmExtractionResult> {
	const m = await getWasm();
	const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
	const cfg = config ?? new m.WasmExtractionConfig();

	const cacheKey = await hashBytes(bytes);
	const cached = extractionCache.get(cacheKey);
	if (cached) return cached;

	const result = await m.extract(bytes, cfg);
	extractionCache.set(cacheKey, result);
	return result;
}

export function firstDocument(result: WasmExtractionResult): WasmExtractedDocument | undefined {
	return result.results[0];
}

export function extractText(result: WasmExtractionResult): string {
	const doc = firstDocument(result);
	return doc ? doc.content : "";
}

export type {
	WasmExtractionConfig,
	WasmExtractionResult,
	WasmExtractedDocument,
	WasmChunk,
	WasmChunkingConfig,
	WasmOcrConfig,
};
