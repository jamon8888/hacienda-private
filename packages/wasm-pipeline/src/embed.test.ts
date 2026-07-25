import { describe, expect, it } from "vitest";
import {
  GRANITE_EMBED_DIM,
  GRANITE_EMBEDDING_IDENTITY,
  GRANITE_EMBEDDING_FALLBACK_SHA256,
} from "./constants";
import { graniteEmbeddingDimension, graniteEmbeddingIdentity } from "./embed";

describe("shared Granite embedding contract", () => {
  it("uses the pinned 384-dimensional identity for both hosts", () => {
    expect(graniteEmbeddingDimension()).toBe(GRANITE_EMBED_DIM);
    expect(graniteEmbeddingIdentity()).toBe(GRANITE_EMBEDDING_IDENTITY);
    expect(GRANITE_EMBEDDING_FALLBACK_SHA256.model).toMatch(/^[0-9a-f]{64}$/);
    expect(GRANITE_EMBEDDING_FALLBACK_SHA256.tokenizer).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
