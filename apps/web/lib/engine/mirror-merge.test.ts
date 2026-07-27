import { describe, it, expect } from "vitest";
import { openVault, openPayload, type EntityGraph } from "@xberg-io/wasm-pipeline-real";
import { mergeIntoAccumulator, type MirrorPiiSpan, type MirrorChunk } from "./mirror-merge";

const PASS = "correct horse battery staple";

function entry(token: string, original: string, start: number) {
  return { token, original, category: "PERSON", kind: "PERSON", start, end: start + original.length };
}
function span(docId: string, token: string, start: number): MirrorPiiSpan {
  return { doc_id: docId, kind: "PERSON", start, end: start + 5, token };
}
function chunk(docId: string, i: number): MirrorChunk {
  return { doc_id: docId, chunk_index: i, text: `redacted ${docId} ${i}`, score: 1, citation: `${docId}#chunk-${i}` };
}

describe("mergeIntoAccumulator", () => {
  it("keeps both documents' pii + chunks and reseals a vault holding all entries", async () => {
    const a = await mergeIntoAccumulator(
      undefined,
      {
        entries: [entry("{{PERSON_1}}", "Alice", 0)],
        pii: [span("docA", "{{PERSON_1}}", 0)],
        chunks: [chunk("docA", 0)],
      },
      PASS,
    );
    const b = await mergeIntoAccumulator(
      a,
      {
        entries: [entry("{{PERSON_1}}", "Bob", 3)],
        pii: [span("docB", "{{PERSON_1}}", 3)],
        chunks: [chunk("docB", 0)],
      },
      PASS,
    );

    expect(b.pii.map((p) => p.doc_id).sort()).toEqual(["docA", "docB"]);
    expect(b.chunks.map((c) => c.doc_id).sort()).toEqual(["docA", "docB"]);

    const entries = await openVault(
      { cipher: Uint8Array.from(b.vaultCipher), salt: Uint8Array.from(b.vaultSalt) },
      PASS,
    );
    expect(entries.map((e) => e.original).sort()).toEqual(["Alice", "Bob"]);
  });

  it("replaces one document's contribution instead of duplicating it, when replaceDocId is given", async () => {
    const a = await mergeIntoAccumulator(
      undefined,
      {
        entries: [{ ...entry("{{PERSON_1}}", "Alice", 0), docId: "docA" }],
        pii: [span("docA", "{{PERSON_1}}", 0)],
        chunks: [chunk("docA", 0)],
      },
      PASS,
    );
    const b = await mergeIntoAccumulator(
      a,
      {
        entries: [{ ...entry("{{PERSON_1}}", "Bob", 3) }],
        pii: [span("docB", "{{PERSON_1}}", 3)],
        chunks: [chunk("docB", 0)],
      },
      PASS,
    );

    // Re-review docA: its corrected contribution should replace the stale copy, not sit
    // alongside it — otherwise a re-redaction would duplicate the document in the matter mirror.
    const corrected = await mergeIntoAccumulator(
      b,
      {
        entries: [{ ...entry("{{PERSON_1}}", "Alicia", 0), docId: "docA" }],
        pii: [span("docA", "{{PERSON_1}}", 0)],
        chunks: [chunk("docA", 0)],
      },
      PASS,
      "docA",
    );

    expect(corrected.pii.filter((p) => p.doc_id === "docA")).toHaveLength(1);
    expect(corrected.pii.map((p) => p.doc_id).sort()).toEqual(["docA", "docB"]);
    expect(corrected.chunks.map((c) => c.doc_id).sort()).toEqual(["docA", "docB"]);

    const entries = await openVault(
      { cipher: Uint8Array.from(corrected.vaultCipher), salt: Uint8Array.from(corrected.vaultSalt) },
      PASS,
    );
    expect(entries.map((e) => e.original).sort()).toEqual(["Alicia", "Bob"]);
  });

  it("evicts a legacy vault entry with no docId of its own, by backfilling from prior.pii", async () => {
    // Simulates a matter ingested before RedactionEntry.docId existed: the vault entry has no
    // docId, but prior.pii (which always carried doc_id) can still identify which doc it belongs to.
    const legacy = await mergeIntoAccumulator(
      undefined,
      {
        entries: [entry("{{PERSON_1}}", "Alice", 0)], // no docId — pre-existing shape
        pii: [span("docA", "{{PERSON_1}}", 0)],
        chunks: [chunk("docA", 0)],
      },
      PASS,
    );

    const corrected = await mergeIntoAccumulator(
      legacy,
      {
        entries: [{ ...entry("{{PERSON_1}}", "Alicia", 0), docId: "docA" }],
        pii: [span("docA", "{{PERSON_1}}", 0)],
        chunks: [chunk("docA", 0)],
      },
      PASS,
      "docA",
    );

    expect(corrected.pii).toHaveLength(1);
    const entries = await openVault(
      { cipher: Uint8Array.from(corrected.vaultCipher), salt: Uint8Array.from(corrected.vaultSalt) },
      PASS,
    );
    // Only the corrected entry should remain — the legacy one must be evicted, not duplicated.
    expect(entries.map((e) => e.original)).toEqual(["Alicia"]);
  });

  it("refuses to backfill a legacy docId when two documents' entries share the same token", async () => {
    // Tokens are chunk-scoped, not document-scoped — two different documents' chunk-0 first
    // PERSON span both mint "{{C0_PERSON_1}}". Neither legacy entry carries its own docId (as if
    // sealed before RedactionEntry.docId existed), so the backfill can't tell them apart and must
    // refuse to resolve the token rather than risk evicting the wrong document's data.
    const merged = await mergeIntoAccumulator(
      undefined,
      {
        entries: [entry("{{C0_PERSON_1}}", "Alice", 0), entry("{{C0_PERSON_1}}", "Bob", 0)],
        pii: [span("docA", "{{C0_PERSON_1}}", 0), span("docB", "{{C0_PERSON_1}}", 0)],
        chunks: [chunk("docA", 0), chunk("docB", 0)],
      },
      PASS,
    );

    // Re-review docA: since the token is ambiguous (shared with docB), neither legacy entry
    // should be evicted by the backfill — docB's data must never be silently dropped.
    const corrected = await mergeIntoAccumulator(
      merged,
      {
        entries: [{ ...entry("{{C0_PERSON_1}}", "Alicia", 0), docId: "docA" }],
        pii: [span("docA", "{{C0_PERSON_1}}", 0)],
        chunks: [chunk("docA", 0)],
      },
      PASS,
      "docA",
    );

    const entries = await openVault(
      { cipher: Uint8Array.from(corrected.vaultCipher), salt: Uint8Array.from(corrected.vaultSalt) },
      PASS,
    );
    expect(entries.map((e) => e.original).sort()).toEqual(["Alice", "Alicia", "Bob"]);
  });

  function graphOf(docId: string, label: string): EntityGraph {
    return {
      nodes: [{ id: `${docId}:n1`, type: "societe", label, attrs: {}, docId, chunkIndex: 0, start: 0, end: 5 }],
      edges: [],
    };
  }

  async function openGraph(acc: { graph?: { cipher: number[]; salt: number[] } }): Promise<EntityGraph> {
    return openPayload<EntityGraph>(
      { cipher: Uint8Array.from(acc.graph!.cipher), salt: Uint8Array.from(acc.graph!.salt) },
      PASS,
    );
  }

  it("merges a new document's entity graph into the matter's sealed cumulative graph", async () => {
    const a = await mergeIntoAccumulator(
      undefined,
      { entries: [], pii: [], chunks: [], graph: graphOf("docA", "SASU Dupont") },
      PASS,
    );
    expect(a.graph).toBeDefined();
    expect((await openGraph(a)).nodes.map((n) => n.label)).toEqual(["SASU Dupont"]);

    const b = await mergeIntoAccumulator(
      a,
      { entries: [], pii: [], chunks: [], graph: graphOf("docB", "SCI Martin") },
      PASS,
    );
    const merged = await openGraph(b);
    expect(merged.nodes.map((n) => n.label).sort()).toEqual(["SASU Dupont", "SCI Martin"]);
  });

  it("leaves the matter graph untouched when a merge doesn't produce a new one (e.g. a PII-only re-review)", async () => {
    const a = await mergeIntoAccumulator(
      undefined,
      { entries: [], pii: [], chunks: [], graph: graphOf("docA", "SASU Dupont") },
      PASS,
    );

    // Re-review docA's PII with no re-extraction: must not drop docA's already-extracted entities.
    const reviewed = await mergeIntoAccumulator(a, { entries: [], pii: [], chunks: [] }, PASS, "docA");
    expect(reviewed.graph).toEqual(a.graph);
    expect((await openGraph(reviewed)).nodes.map((n) => n.label)).toEqual(["SASU Dupont"]);
  });

  it("replaces a document's own graph contribution instead of duplicating it, when replaceDocId is given", async () => {
    const a = await mergeIntoAccumulator(
      undefined,
      { entries: [], pii: [], chunks: [], graph: graphOf("docA", "SASU Dupont") },
      PASS,
    );
    const b = await mergeIntoAccumulator(
      a,
      { entries: [], pii: [], chunks: [], graph: graphOf("docB", "SCI Martin") },
      PASS,
    );

    // Re-extraction for docA (e.g. re-ingest) with a corrected label — its prior nodes must be
    // dropped, not kept alongside the new ones.
    const corrected = await mergeIntoAccumulator(
      b,
      { entries: [], pii: [], chunks: [], graph: graphOf("docA", "SASU Dupont Conseil") },
      PASS,
      "docA",
    );
    const merged = await openGraph(corrected);
    expect(merged.nodes.map((n) => n.label).sort()).toEqual(["SASU Dupont Conseil", "SCI Martin"]);
  });
});
