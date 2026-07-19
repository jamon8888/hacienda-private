import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectPii, resolveLocalOnnxWasmPaths, RUST_ALIGNED_PII_TYPES } from "./ner.js";

describe("RUST_ALIGNED_PII_TYPES", () => {
  it("matches the Rust EntityCategory taxonomy plus the two custom labels", () => {
    expect(RUST_ALIGNED_PII_TYPES).toEqual([
      "person", "organization", "location", "date", "time", "money", "percent", "email", "phone", "url",
      "ssn", "financial",
    ]);
  });
});

describe("resolveLocalOnnxWasmPaths", () => {
  it("resolves to a real local directory, never the onnxruntime-web CDN default", () => {
    const wasmPaths = resolveLocalOnnxWasmPaths();

    expect(wasmPaths).not.toMatch(/^https?:/);
    expect(wasmPaths).not.toContain("cdn.jsdelivr.net");
    expect(wasmPaths.endsWith("/")).toBe(true);

    // Strip the trailing slash convention (wasmPaths is concatenated with a
    // filename by gliner's ONNXWebWrapper) to check the directory on disk.
    const dir = wasmPaths.slice(0, -1);
    expect(existsSync(dir)).toBe(true);
  });
});

describe.skip("detectPii (real model — run manually, needs network)", () => {
  it("detects a person and organization", async () => {
    const entities = await detectPii(
      "Elon Musk founded SpaceX in Hawthorne, California.",
      process.env.GLINER_MODEL_PATH ?? "",
      process.env.GLINER_TOKENIZER_PATH ?? "",
    );
    const texts = entities.map((e) => e.text);
    expect(texts).toEqual(expect.arrayContaining([expect.stringContaining("Musk")]));
  });
});
