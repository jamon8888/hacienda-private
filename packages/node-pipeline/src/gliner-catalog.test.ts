// packages/node-pipeline/src/gliner-catalog.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GLINER_MODEL_DEFINITIONS, parseGlinerChecksums, buildGlinerManifestEntries } from "./gliner-catalog.js";

describe("gliner-catalog", () => {
  it("parses the copied checksum manifest and finds every declared model file", () => {
    const text = readFileSync(join(import.meta.dirname, "gliner-models.sha256"), "utf8");
    const checksums = parseGlinerChecksums(text);

    for (const def of GLINER_MODEL_DEFINITIONS) {
      expect(checksums[def.modelFile], `missing checksum for ${def.modelFile}`).toBeTruthy();
      expect(checksums[def.tokenizerFile], `missing checksum for ${def.tokenizerFile}`).toBeTruthy();
    }
  });

  it("builds one manifest entry per model + tokenizer file, named for local caching", () => {
    const checksums = {
      "models/gliner_small-v2.5/span/fp32/model.onnx": "a".repeat(64),
      "models/gliner_small-v2.5/span/fp32/tokenizer.json": "b".repeat(64),
      "models/gliner_medium-v2.5/span/fp32/model.onnx": "c".repeat(64),
      "models/gliner_medium-v2.5/span/fp32/tokenizer.json": "d".repeat(64),
      "models/gliner_large-v2.5/span/fp32/model.onnx": "e".repeat(64),
      "models/gliner_large-v2.5/span/fp32/tokenizer.json": "f".repeat(64),
    };
    const entries = buildGlinerManifestEntries(checksums);

    expect(entries).toHaveLength(6);
    const balanced = entries.find((e) => e.name === "gliner_medium-v2.5.model");
    expect(balanced?.sha256).toBe("c".repeat(64));
    expect(balanced?.file).toBe("gliner/gliner_medium-v2.5/model.onnx");
    expect(balanced?.url).toBe(
      "https://huggingface.co/xberg-io/gliner-models/resolve/main/models/gliner_medium-v2.5/span/fp32/model.onnx",
    );
  });

  it("throws when a declared model file has no checksum entry", () => {
    expect(() => buildGlinerManifestEntries({})).toThrow(/missing checksum/i);
  });
});
