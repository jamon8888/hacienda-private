import type { WasmExtractionConfig } from "@xberg-io/xberg-wasm";
import { getWasm } from "./runtime";

export type WasmOcrStrategy = "tesseract";

export async function withTesseractOcr(
  base: WasmExtractionConfig,
  strategy: WasmOcrStrategy = "tesseract",
  language?: string[],
): Promise<WasmExtractionConfig> {
  const m = await getWasm();
  const ocr = new m.WasmOcrConfig(true, strategy, language ?? []);
  base.ocr = ocr;
  return base;
}

export async function defaultExtractionConfig(): Promise<WasmExtractionConfig> {
  const m = await getWasm();
  return new m.WasmExtractionConfig();
}
