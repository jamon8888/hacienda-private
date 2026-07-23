// packages/node-pipeline/src/gliner-catalog.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GLINER2_ARTIFACT_FILES,
  buildGliner2ManifestEntries,
  GLINER_MODEL_DEFINITIONS,
  gliner2ArtifactPaths,
  parseGlinerChecksums,
  buildGlinerManifestEntries,
  loadGliner2ManifestEntries,
} from "./gliner-catalog.js";

describe("gliner-catalog", () => {
  it("keeps the native GLiNER2 artifact layout explicit without requiring model bytes", () => {
    expect(gliner2ArtifactPaths("/cache/gliner2/base")).toEqual({
      modelDir: "/cache/gliner2/base",
      weightsPath: "/cache/gliner2/base/model.safetensors",
      tokenizerPath: "/cache/gliner2/base/tokenizer.json",
      encoderConfigPath: "/cache/gliner2/base/encoder_config/config.json",
    });
    expect(GLINER2_ARTIFACT_FILES.encoderConfig).toBe("encoder_config/config.json");
  });

  it("builds three pinned Candle entries from deployment-provided checksums", () => {
    const entries = buildGliner2ManifestEntries({
      [GLINER2_ARTIFACT_FILES.weights]: "a".repeat(64),
      [GLINER2_ARTIFACT_FILES.tokenizer]: "b".repeat(64),
      [GLINER2_ARTIFACT_FILES.encoderConfig]: "c".repeat(64),
    });
    expect(entries.map((entry) => entry.name)).toEqual([
      "gliner2-guardrails-pii-multi.weights",
      "gliner2-guardrails-pii-multi.tokenizer",
      "gliner2-guardrails-pii-multi.encoder-config",
    ]);
    expect(entries[2]?.file).toBe("gliner2/gliner2-guardrails-pii-multi/encoder_config/config.json");
  });

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

  it("ships the pinned GLiNER2 manifest entries for the native model cache", () => {
    const entries = loadGliner2ManifestEntries();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.name)).toEqual([
      "gliner2-guardrails-pii-multi.weights",
      "gliner2-guardrails-pii-multi.tokenizer",
      "gliner2-guardrails-pii-multi.encoder-config",
    ]);
    expect(entries.every((entry) => entry.url.startsWith("https://huggingface.co/fastino/GLiNER2-Guardrails-PII-Multi/"))).toBe(true);
    expect(entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  });
});
