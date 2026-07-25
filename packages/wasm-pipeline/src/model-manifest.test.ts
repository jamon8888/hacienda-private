import { beforeEach, describe, expect, it, vi } from "vitest";
import { GRANITE_EMBEDDING_FALLBACK_FILES, GRANITE_EMBEDDING_FALLBACK_SHA256, MODEL_MANIFEST_URL } from "./constants";
import { resetModelManifestCache, resolveGraniteArtifacts } from "./model-manifest";

describe("resolveGraniteArtifacts", () => {
  beforeEach(() => {
    resetModelManifestCache();
    vi.unstubAllGlobals();
  });

  it("prefers the MCP model manifest when Granite entries are present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        expect(String(input)).toBe(MODEL_MANIFEST_URL);
        return {
          ok: true,
          clone: function () {
            return this;
          },
          json: async () => ({
            models: [
              {
                name: "granite-embedding-97m-multilingual-r2.weights",
                file: "granite/custom/model.safetensors",
                sha256: "a".repeat(64),
              },
              {
                name: "granite-embedding-97m-multilingual-r2.tokenizer",
                file: "granite/custom/tokenizer.json",
                sha256: "b".repeat(64),
              },
              {
                name: "granite-embedding-97m-multilingual-r2.config",
                file: "granite/custom/config.json",
                sha256: "c".repeat(64),
              },
            ],
          }),
        };
      }),
    );

    const artifacts = await resolveGraniteArtifacts();

    expect(artifacts.model.url).toContain("/models/granite/custom/model.safetensors");
    expect(artifacts.model.sha256).toBe("a".repeat(64));
    expect(artifacts.tokenizer.url).toContain("/models/granite/custom/tokenizer.json");
    expect(artifacts.config.sha256).toBe("c".repeat(64));
  });

  it("falls back to the pinned Granite defaults when the manifest is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const artifacts = await resolveGraniteArtifacts();

    expect(artifacts.model.url).toContain(`/models/${GRANITE_EMBEDDING_FALLBACK_FILES.model}`);
    expect(artifacts.model.sha256).toBe(GRANITE_EMBEDDING_FALLBACK_SHA256.model);
    expect(artifacts.tokenizer.sha256).toBe(GRANITE_EMBEDDING_FALLBACK_SHA256.tokenizer);
    expect(artifacts.config.sha256).toBe(GRANITE_EMBEDDING_FALLBACK_SHA256.config);
  });
});
