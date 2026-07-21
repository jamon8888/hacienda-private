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

export function resetWasm(): void {
  wasmMod = null;
}

export async function getWasm(): Promise<XbergWasm> {
  if (!wasmMod) await initWasm();
  return wasmMod as XbergWasm;
}

export async function extractDocument(
  file: File | Uint8Array,
  config?: WasmExtractionConfig,
): Promise<WasmExtractionResult> {
  const m = await getWasm();
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  const mimeType = (file instanceof File ? file.type : "") || "application/octet-stream";
  const filename = file instanceof File ? file.name : undefined;
  const input = m.WasmExtractInput.fromBytes(bytes, mimeType, filename);
  const cfg = config ?? new m.WasmExtractionConfig();
  return m.extract(input, cfg);
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
