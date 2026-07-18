import type {
  WasmExtractionConfig,
  WasmExtractionResult,
  WasmExtractedDocument,
  WasmChunk,
  WasmChunkingConfig,
  WasmOcrConfig,
} from "@xberg-io/xberg-wasm";

/** The lazily-imported `@xberg-io/xberg-wasm` module namespace. */
export type XbergWasm = typeof import("@xberg-io/xberg-wasm");

let wasmMod: XbergWasm | null = null;

/**
 * Load and initialize the Xberg WASM module exactly once.
 *
 * Dynamically imports `@xberg-io/xberg-wasm`, runs its default init (which
 * instantiates the WebAssembly binary), and caches the module for reuse.
 */
export async function initWasm(): Promise<void> {
  const mod = (await import("@xberg-io/xberg-wasm")) as XbergWasm;
  await mod.default();
  wasmMod = mod;
}

/**
 * Return the initialized Xberg WASM module, initializing it on first use.
 *
 * @returns The cached {@link XbergWasm} module namespace.
 */
export async function getWasm(): Promise<XbergWasm> {
  if (!wasmMod) await initWasm();
  return wasmMod as XbergWasm;
}

/**
 * Extract a document from a browser `File` or raw bytes via the WASM engine.
 *
 * @param file - The input document as a `File` or `Uint8Array`.
 * @param config - Optional extraction configuration; a default is used if omitted.
 * @returns The raw WASM extraction result (one or more documents).
 */
export async function extractDocument(
  file: File | Uint8Array,
  config?: WasmExtractionConfig,
): Promise<WasmExtractionResult> {
  const m = await getWasm();
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  const cfg = config ?? new m.WasmExtractionConfig();
  return m.extract(bytes, cfg);
}

/**
 * Return the first extracted document from a result, if any.
 *
 * @param result - A WASM extraction result.
 * @returns The first document, or `undefined` when the result is empty.
 */
export function firstDocument(result: WasmExtractionResult): WasmExtractedDocument | undefined {
  return result.results[0];
}

/**
 * Convenience accessor for the plain-text content of the first document.
 *
 * @param result - A WASM extraction result.
 * @returns The first document's text content, or an empty string if none.
 */
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
