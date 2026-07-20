import { describe, it, expect } from "vitest";
import { buildVocabulary, buildSparse, tokenize } from "./hybrid";

describe("hybrid.ts sparse/BM25 query builder", () => {
  const chunks = [
    { text: "Acme Corp signed clause 9" },
    { text: "unrelated cooking recipe" },
  ];

  it("tokenizes lowercase and splits on non-word chars", () => {
    expect(tokenize("Acme Corp!")).toEqual(["acme", "corp"]);
  });

  it("buildSparse returns aligned indices/values/dim against the built vocabulary", () => {
    const vocab = buildVocabulary(chunks);
    const sparse = buildSparse("Acme Corp", vocab);

    expect(sparse.dim).toBe(vocab.dim);
    expect(sparse.indices.length).toBe(2);
    expect(sparse.values.length).toBe(2);
    // indices must be sorted ascending (EdgeVec insertSparse/hybridSearch requirement)
    expect(sparse.indices[0]).toBeLessThan(sparse.indices[1] as number);
    // both "acme" and "corp" are in the vocabulary, at their assigned ids
    expect(Array.from(sparse.indices)).toEqual(
      [vocab.terms.get("acme"), vocab.terms.get("corp")].sort((a, b) => (a as number) - (b as number)),
    );
  });

  it("empty query yields an empty sparse leg (dense-only fallback)", () => {
    const vocab = buildVocabulary(chunks);
    const sparse = buildSparse("", vocab);
    expect(sparse.indices.length).toBe(0);
    expect(sparse.values.length).toBe(0);
  });

  it("drops out-of-vocabulary terms without crashing", () => {
    const vocab = buildVocabulary(chunks);
    const sparse = buildSparse("Acme zzzznotintext", vocab);
    expect(sparse.indices.length).toBe(1);
    expect(sparse.indices[0]).toBe(vocab.terms.get("acme"));
  });
});
