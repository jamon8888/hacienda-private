import { createCipheriv, randomBytes, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { queryGraph } from "../src/graph-query.js";

// Seals a payload with the exact same wire format decryptBrowserVault/browser_vault.rs expect
// (PBKDF2-SHA256, 100k iterations, 16-byte salt, 12-byte-IV-prefixed AES-256-GCM ciphertext with
// the tag appended) — this is the "sender" side (analogous to redact.ts's sealVault running in
// the browser), used here only to build fixtures for these tests.
function sealForTest(plaintext: string, passphrase: string): { cipher: Uint8Array; salt: Uint8Array } {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, 100_000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { cipher: new Uint8Array(Buffer.concat([iv, enc, tag])), salt: new Uint8Array(salt) };
}

// Same fixture graph as crates/xberg/src/mcp/graph.rs's sample_graph test helper, so the query
// behavior can be compared directly against the native host's test expectations.
const SAMPLE_GRAPH = {
  nodes: [
    { id: "n1", type: "dirigeant", label: "Jean Dupont", attrs: {}, docId: "d1", chunkIndex: 0 },
    { id: "n2", type: "societe", label: "SASU Dupont Conseil", attrs: {}, docId: "d1", chunkIndex: 0 },
    { id: "n3", type: "actionnaire", label: "Marie Martin", attrs: {}, docId: "d1", chunkIndex: 1 },
  ],
  edges: [
    { id: "e1", type: "dirige", from: "n1", to: "n2", docId: "d1", chunkIndex: 0 },
    { id: "e2", type: "detient", from: "n3", to: "n2", docId: "d1", chunkIndex: 1 },
  ],
};

const PASSPHRASE = "correct horse battery staple";

function sealedSample(graph: typeof SAMPLE_GRAPH = SAMPLE_GRAPH) {
  return sealForTest(JSON.stringify(graph), PASSPHRASE);
}

describe("queryGraph", () => {
  it("fails closed with the wrong passphrase", () => {
    const sealed = sealedSample();
    expect(() => queryGraph(sealed, "wrong passphrase", {})).toThrow(/wrong passphrase|corrupted/);
  });

  it("rejects an empty passphrase", () => {
    const sealed = sealedSample();
    expect(() => queryGraph(sealed, "", {})).toThrow(/passphrase/);
  });

  it("filters by exact node type", () => {
    const sealed = sealedSample();
    const result = queryGraph(sealed, PASSPHRASE, { nodeType: "societe" });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].label).toBe("SASU Dupont Conseil");
    expect(result.edges).toHaveLength(0);
  });

  it("filters by a case-insensitive label substring", () => {
    const sealed = sealedSample();
    const result = queryGraph(sealed, PASSPHRASE, { labelContains: "dupont" });
    const labels = result.nodes.map((n) => n.label);
    expect(labels).toContain("Jean Dupont");
    expect(labels).toContain("SASU Dupont Conseil");
    expect(labels).toHaveLength(2);
  });

  it("treats % and _ in labelContains as literal characters, not LIKE wildcards", () => {
    const graph = {
      ...SAMPLE_GRAPH,
      nodes: [
        ...SAMPLE_GRAPH.nodes,
        { id: "n4", type: "capital_social", label: "100% libere", attrs: {}, docId: "d1", chunkIndex: 0 },
      ],
    };
    const sealed = sealedSample(graph);

    const percentResult = queryGraph(sealed, PASSPHRASE, { labelContains: "100%" });
    expect(percentResult.nodes).toHaveLength(1);
    expect(percentResult.nodes[0].label).toBe("100% libere");

    // A literal "_" (as opposed to LIKE's single-char wildcard) must not match "Dupont".
    const underscoreResult = queryGraph(sealed, PASSPHRASE, { labelContains: "du_ont" });
    expect(underscoreResult.nodes).toHaveLength(0);
  });

  it("traverses one hop from the company to reach both the director and the shareholder", () => {
    const sealed = sealedSample();
    const result = queryGraph(sealed, PASSPHRASE, { fromLabel: "SASU Dupont Conseil", maxHops: 1 });
    const labels = new Set(result.nodes.map((n) => n.label));
    expect(labels.has("SASU Dupont Conseil")).toBe(true);
    expect(labels.has("Jean Dupont")).toBe(true);
    expect(labels.has("Marie Martin")).toBe(true);
    expect(result.edges).toHaveLength(2);
  });

  it("reaches only direct neighbors at the minimum max_hops", () => {
    const sealed = sealedSample();
    const result = queryGraph(sealed, PASSPHRASE, { fromLabel: "Jean Dupont", maxHops: 1 });
    const labels = new Set(result.nodes.map((n) => n.label));
    expect(labels.has("Jean Dupont")).toBe(true);
    expect(labels.has("SASU Dupont Conseil")).toBe(true);
    expect(labels.has("Marie Martin")).toBe(false);
  });

  it("reaches nothing when traversing from an unknown label", () => {
    const sealed = sealedSample();
    const result = queryGraph(sealed, PASSPHRASE, { fromLabel: "Nobody Here", maxHops: 3 });
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it("clamps maxHops and limit to their documented ranges instead of erroring", () => {
    const sealed = sealedSample();
    expect(() => queryGraph(sealed, PASSPHRASE, { fromLabel: "Jean Dupont", maxHops: 999, limit: 999 })).not.toThrow();
    expect(() => queryGraph(sealed, PASSPHRASE, { fromLabel: "Jean Dupont", maxHops: 0, limit: 0 })).not.toThrow();
  });
});
