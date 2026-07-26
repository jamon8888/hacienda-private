import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRedaction, sealVault, type RedactionEntry } from "@xberg-io/wasm-pipeline-real";

// Same fake edgevec used by packages/wasm-pipeline/src/rag.test.ts — reviewAndRepush rebuilds the
// matter's retrieval index via replaceDocChunks, which needs a working (fake) EdgeVec underneath.
vi.mock("edgevec", () => {
  class FakeEdgeVecConfig {
    metric = "cosine";
    constructor(public readonly dim: number) {}
  }
  class FakeEdgeVec {
    dense: Array<{ vector: Float32Array; metadata: Record<string, unknown> }> = [];
    sparse: unknown[] = [];
    initSparseStorage(): void {}
    enableBQ(): void {}
    hasBQ(): boolean {
      return true;
    }
    insertWithMetadata(vector: Float32Array, metadata: Record<string, unknown>): number {
      this.dense.push({ vector, metadata });
      return this.dense.length;
    }
    insertSparse(): number {
      this.sparse.push({});
      return this.sparse.length - 1;
    }
    getAllMetadata(id: number): Record<string, unknown> | undefined {
      return this.dense[id - 1]?.metadata;
    }
    save_stream(): { next_chunk(): Uint8Array | null } {
      return { next_chunk: () => null };
    }
    static load(): Promise<unknown> {
      return Promise.reject(new Error("load() should never be called"));
    }
  }
  return {
    default: vi.fn(async () => undefined),
    EdgeVec: FakeEdgeVec,
    EdgeVecConfig: FakeEdgeVecConfig,
  };
});

const idbStore = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => idbStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  update: vi.fn(async (key: string, updater: (old: unknown) => unknown) => {
    idbStore.set(key, updater(idbStore.get(key)));
  }),
  del: vi.fn(async (key: string) => {
    idbStore.delete(key);
  }),
}));

const fetchMock = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
vi.stubGlobal("fetch", fetchMock);

const PASS = "correct horse battery staple";
const DOC_ID = "doc-1";

async function buildDocMirror(text: string, pii: { kind: string; start: number; end: number }[]) {
  const { redacted, entries } = buildRedaction(
    text,
    pii.map((p) => ({ ...p, text: text.slice(p.start, p.end) })),
    "C0",
    DOC_ID,
  );
  const sealed = await sealVault(entries, PASS);
  const chunk = {
    doc_id: DOC_ID,
    chunk_index: 0,
    text: redacted,
    page: 1,
    citation: `${DOC_ID}#0`,
    score: 1,
  };
  const pii_spans = entries.map((e: RedactionEntry) => ({
    doc_id: DOC_ID,
    kind: e.kind,
    start: e.start,
    end: e.end,
    token: e.token,
  }));
  const mirror = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      index: [],
      vault: Array.from(sealed.cipher),
      vaultSalt: Array.from(sealed.salt),
      pii: pii_spans,
      chunks: [chunk],
    }),
  );
  return { mirror, entries };
}

describe("reviewAndRepush", () => {
  beforeEach(() => {
    idbStore.clear();
    fetchMock.mockClear();
  });

  it("un-redacts a rejected span and pushes the corrected mirror", async () => {
    const text = "Hello Alice, meet Bob.";
    const { mirror } = await buildDocMirror(text, [
      { kind: "PERSON", start: 6, end: 11 }, // Alice
      { kind: "PERSON", start: 18, end: 21 }, // Bob
    ]);

    const { reviewAndRepush } = await import("./adapter");
    // rejectedKeys are tokens (PiiEntity.text), not "kind-start-end" — Alice is chunk 0's first
    // PERSON span, so buildRedaction mints it as {{C0_PERSON_1}}.
    const result = await reviewAndRepush(
      DOC_ID,
      mirror,
      { matterId: "matter-1", scopeToken: "token", passphrase: PASS },
      { rejectedKeys: ["{{C0_PERSON_1}}"], newSpans: [] },
    );

    const decoded = JSON.parse(new TextDecoder().decode(result.mirror)) as {
      chunks: { text: string }[];
    };
    expect(decoded.chunks[0]?.text).toContain("Alice");
    expect(decoded.chunks[0]?.text).not.toContain("Bob");
    // Only Bob's span survives the rejection — Alice is un-redacted, not just re-tokenized.
    expect(result.pii).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not un-redact a same-named span in a different chunk (token, not kind-start-end, disambiguates)", async () => {
    // Two chunks each have a PERSON span at the exact same local offset (6,11) — with a
    // "kind-start-end" key these would collide; with tokens (chunk-prefixed) they can't.
    const { buildRedaction: buildRedactionFn, sealVault: sealVaultFn } = await import("@xberg-io/wasm-pipeline-real");
    const textA = "Hello Alice.";
    const textB = "Hello Bobby.";
    const a = buildRedactionFn(textA, [{ kind: "PERSON", start: 6, end: 11, text: "Alice" }], "C0", DOC_ID);
    const b = buildRedactionFn(textB, [{ kind: "PERSON", start: 6, end: 11, text: "Bobby" }], "C1", DOC_ID);
    const sealed = await sealVaultFn([...a.entries, ...b.entries], PASS);
    const mirror = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        index: [],
        vault: Array.from(sealed.cipher),
        vaultSalt: Array.from(sealed.salt),
        pii: [...a.entries, ...b.entries].map((e) => ({
          doc_id: DOC_ID,
          kind: e.kind,
          start: e.start,
          end: e.end,
          token: e.token,
        })),
        chunks: [
          { doc_id: DOC_ID, chunk_index: 0, text: a.redacted, page: 1, citation: `${DOC_ID}#0`, score: 1 },
          { doc_id: DOC_ID, chunk_index: 1, text: b.redacted, page: 1, citation: `${DOC_ID}#1`, score: 1 },
        ],
      }),
    );

    const { reviewAndRepush } = await import("./adapter");
    // Only reject chunk 0's span ({{C0_PERSON_1}}) — chunk 1's {{C1_PERSON_1}} should survive.
    const result = await reviewAndRepush(
      DOC_ID,
      mirror,
      { matterId: "matter-1b", scopeToken: "token", passphrase: PASS },
      { rejectedKeys: ["{{C0_PERSON_1}}"], newSpans: [] },
    );

    const decoded = JSON.parse(new TextDecoder().decode(result.mirror)) as {
      chunks: { text: string }[];
    };
    expect(decoded.chunks[0]?.text).toContain("Alice");
    expect(decoded.chunks[1]?.text).not.toContain("Bobby");
    expect(result.pii).toHaveLength(1);
  });

  it("redacts a missed span found in the reconstructed original text", async () => {
    const text = "Hello Alice, meet Bob.";
    const { mirror } = await buildDocMirror(text, [{ kind: "PERSON", start: 6, end: 11 }]); // only Alice detected

    const { reviewAndRepush } = await import("./adapter");
    const result = await reviewAndRepush(
      DOC_ID,
      mirror,
      { matterId: "matter-2", scopeToken: "token", passphrase: PASS },
      { rejectedKeys: [], newSpans: [{ text: "Bob", kind: "PERSON" }] },
    );

    const decoded = JSON.parse(new TextDecoder().decode(result.mirror)) as {
      chunks: { text: string }[];
    };
    expect(decoded.chunks[0]?.text).not.toContain("Bob");
    expect(decoded.chunks[0]?.text).not.toContain("Alice");
    expect(result.unappliedSpans).toEqual([]);
  });

  it("reports a missed span it could not find anywhere in the document", async () => {
    const text = "Hello Alice.";
    const { mirror } = await buildDocMirror(text, [{ kind: "PERSON", start: 6, end: 11 }]);

    const { reviewAndRepush } = await import("./adapter");
    const result = await reviewAndRepush(
      DOC_ID,
      mirror,
      { matterId: "matter-3", scopeToken: "token", passphrase: PASS },
      { rejectedKeys: [], newSpans: [{ text: "Nonexistent Name", kind: "PERSON" }] },
    );

    expect(result.unappliedSpans).toEqual(["Nonexistent Name"]);
  });
});
