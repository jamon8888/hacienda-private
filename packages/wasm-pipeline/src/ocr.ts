import type { WasmExtractionConfig } from "@xberg-io/xberg-wasm";
import { getWasm } from "./runtime";

/** Supported OCR engine strategies. Currently only Tesseract is wired up. */
export type WasmOcrStrategy = "tesseract";

/**
 * Enable Tesseract OCR on an existing extraction config.
 *
 * @param base - The extraction config to mutate and return.
 * @param strategy - OCR engine strategy (defaults to `"tesseract"`).
 * @param language - Optional Tesseract language codes (e.g. `["eng", "fra"]`).
 * @returns The same config with its `ocr` field populated.
 */
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

/**
 * Create a fresh default WASM extraction config.
 *
 * @returns A new {@link WasmExtractionConfig} with engine defaults.
 */
export async function defaultExtractionConfig(): Promise<WasmExtractionConfig> {
  const m = await getWasm();
  return new m.WasmExtractionConfig();
}
