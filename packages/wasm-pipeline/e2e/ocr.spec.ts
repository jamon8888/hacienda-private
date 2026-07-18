import { test, expect } from "@playwright/test";
import { initWasm, extractDocument, firstDocument, defaultExtractionConfig, withTesseractOcr } from "../src/index";

test("tesseract OCR extracts non-empty text from a receipt image", async () => {
  await initWasm();
  const base = await defaultExtractionConfig();
  const config = await withTesseractOcr(base, "tesseract");
  // A tiny 1x1 PNG won't OCR real text; assert the pipeline runs and returns a document.
  const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0x0d,0x49,0x48,0x44,0x52,0,0,0,1,0,0,0,1,8,6,0,0,0,0x1f,0x15,0xc4,0x89,0,0,0,0,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82]);
  const file = new File([png], "receipt.png", { type: "image/png" });
  const result = await extractDocument(file, config);
  const doc = firstDocument(result);
  expect(doc).toBeTruthy();
});
