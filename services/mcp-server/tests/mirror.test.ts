import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/error.js";
import { MirrorStore, SHARED_EMBEDDING_IDENTITY } from "../src/mirror.js";

describe("MirrorStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mirror-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves and reports mirror status", () => {
    const store = new MirrorStore(dir);
    const body = Buffer.from(new Uint8Array([1, 2, 3, 4, 5]));
    const status = store.saveMirror("matter-1", body);
    expect(status.bytes).toBe(5);
    expect(status.synced_at).not.toBeNull();
    const loaded = store.status("matter-1");
    expect(loaded?.bytes).toBe(5);
  });

  it("rejects empty payloads", () => {
    const store = new MirrorStore(dir);
    expect(() => store.saveMirror("m", Buffer.alloc(0))).toThrow();
  });

  it.each(["", ".", ".."])("rejects unsafe matter ID %j without filesystem side effects", (matterId) => {
    const mirrorsDir = join(dir, "mirrors");
    const store = new MirrorStore(mirrorsDir);
    const mirrorsEntries = readdirSync(mirrorsDir);
    const parentEntries = readdirSync(dir);

    expect(() => store.saveMirror(matterId, Buffer.from("bytes"))).toThrowError(
      expect.objectContaining<Partial<AppError>>({
        code: "bad_request",
      }),
    );
    expect(readdirSync(mirrorsDir)).toEqual(mirrorsEntries);
    expect(readdirSync(dir)).toEqual(parentEntries);
  });

  it.each(["", ".", ".."])("rejects unsafe matter ID %j in every operation", async (matterId) => {
    const store = new MirrorStore(dir);
    const isBadRequest = (error: unknown): boolean => error instanceof AppError && error.code === "bad_request";
    const additions = { pii: [], chunks: [] };

    expect(() => store.appendMirror(matterId, additions)).toThrowError(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(() => store.status(matterId)).toThrowError(expect.objectContaining({ code: "bad_request" }));
    await expect(store.loadMirror(matterId)).rejects.toSatisfy(isBadRequest);
    expect(() => store.listPii(matterId, "doc")).toThrowError(expect.objectContaining({ code: "bad_request" }));
    expect(() => store.retrieve(matterId, "query")).toThrowError(expect.objectContaining({ code: "bad_request" }));
    expect(() => store.loadCipher(matterId, "doc:token")).toThrowError(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(() => store.getSealedGraph(matterId)).toThrowError(expect.objectContaining({ code: "bad_request" }));
    expect(() => store.forget(matterId)).toThrowError(expect.objectContaining({ code: "bad_request" }));
  });

  it("loadMirror never throws even if edgevec is unavailable", async () => {
    const store = new MirrorStore(dir);
    store.saveMirror("m", Buffer.from("index-bytes"));
    const result = await store.loadMirror("m");
    expect(result.matter_id).toBe("m");
    expect(typeof result.loaded).toBe("boolean");
  });

  it("rejects a bundle with the wrong embedding identity", async () => {
    const store = new MirrorStore(dir);
    store.saveMirror(
      "m",
      Buffer.from(
        JSON.stringify({
          version: 2,
          embedding_identity: "wrong-identity",
          index: [1, 2, 3],
          vault: [4, 5, 6],
          vaultSalt: [7, 8],
          pii: [],
          chunks: [],
        }),
      ),
    );

    const result = await store.loadMirror("m");
    expect(result.loaded).toBe(false);
    expect(result.reason).toContain("unexpected bundle shape");
  });

  it("rejects a bundle with a malformed graph field", async () => {
    const store = new MirrorStore(dir);
    store.saveMirror(
      "m",
      Buffer.from(
        JSON.stringify({
          version: 2,
          embedding_identity: SHARED_EMBEDDING_IDENTITY,
          index: [1, 2, 3],
          vault: [4, 5, 6],
          vaultSalt: [7, 8],
          pii: [],
          chunks: [],
          graph: { cipher: "not-an-array", salt: [1] },
        }),
      ),
    );

    const result = await store.loadMirror("m");
    expect(result.loaded).toBe(false);
    expect(result.reason).toContain("malformed graph");
  });

  it.each([
    ["a negative number", [-1, 2]],
    ["a fractional number", [1.5, 2]],
    ["a value above 255", [256, 2]],
    ["a null element", [null, 2]],
  ])("rejects a graph cipher/salt containing %s", async (_label, badBytes) => {
    const store = new MirrorStore(dir);
    store.saveMirror(
      "m",
      Buffer.from(
        JSON.stringify({
          version: 2,
          embedding_identity: SHARED_EMBEDDING_IDENTITY,
          index: [1, 2, 3],
          vault: [4, 5, 6],
          vaultSalt: [7, 8],
          pii: [],
          chunks: [],
          graph: { cipher: badBytes, salt: [1, 2] },
        }),
      ),
    );

    const result = await store.loadMirror("m");
    expect(result.loaded).toBe(false);
    expect(result.reason).toContain("malformed graph");
  });

  it("rejects a bundle with graph explicitly set to null without throwing an uncaught TypeError", async () => {
    const store = new MirrorStore(dir);
    store.saveMirror(
      "m",
      Buffer.from(
        JSON.stringify({
          version: 2,
          embedding_identity: SHARED_EMBEDDING_IDENTITY,
          index: [1, 2, 3],
          vault: [4, 5, 6],
          vaultSalt: [7, 8],
          pii: [],
          chunks: [],
          graph: null,
        }),
      ),
    );

    const result = await store.loadMirror("m");
    expect(result.loaded).toBe(true);
  });

  it("accepts and round-trips a bundle carrying a sealed entity graph", async () => {
    const store = new MirrorStore(dir);
    store.saveMirror(
      "m",
      Buffer.from(
        JSON.stringify({
          version: 2,
          embedding_identity: SHARED_EMBEDDING_IDENTITY,
          index: [1, 2, 3],
          vault: [4, 5, 6],
          vaultSalt: [7, 8],
          pii: [],
          chunks: [],
          graph: { cipher: [10, 20, 30], salt: [40, 50] },
        }),
      ),
    );

    const result = await store.loadMirror("m");
    expect(result.loaded).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, "m", "bundle.json"), "utf8")) as {
      graph?: { cipher: number[]; salt: number[] };
    };
    expect(raw.graph).toEqual({ cipher: [10, 20, 30], salt: [40, 50] });
    expect(store.getSealedGraph("m")).toEqual({
      cipher: new Uint8Array([10, 20, 30]),
      salt: new Uint8Array([40, 50]),
    });
  });

  it("omitting graph is unaffected — existing bundles without it still load", async () => {
    const store = new MirrorStore(dir);
    store.saveMirror("m", bundle("no graph here"));
    const result = await store.loadMirror("m");
    expect(result.loaded).toBe(true);
    expect(store.getSealedGraph("m")).toBeNull();
  });

  function bundle(text: string) {
    return Buffer.from(
      JSON.stringify({
        version: 2,
        embedding_identity: SHARED_EMBEDDING_IDENTITY,
        index: [1, 2, 3],
        vault: [4, 5, 6],
        vaultSalt: [7, 8],
        pii: [],
        chunks: [{ doc_id: "d1", chunk_index: 0, text, score: 1, citation: "d1#0" }],
      }),
    );
  }

  it("re-saving a mirror invalidates the cached bundle", () => {
    const store = new MirrorStore(dir);
    store.saveMirror("m", bundle("first"));
    expect(store.retrieve("m", "q")[0]?.text).toBe("first");
    store.saveMirror("m", bundle("second"));
    expect(store.retrieve("m", "q")[0]?.text).toBe("second");
  });

  it("serves the bundle from disk after loadMirror overwrites the raw index file", async () => {
    const store = new MirrorStore(dir);
    store.saveMirror("m", bundle("hello"));
    await store.loadMirror("m");
    // Simulate a restart: fresh instance, empty in-memory cache, same mirrorsDir on disk.
    const restarted = new MirrorStore(dir);
    expect(restarted.retrieve("m", "q")[0]?.text).toBe("hello");
  });

  it("forget is idempotent for a matter with no mirror", () => {
    const store = new MirrorStore(dir);
    expect(() => store.forget("never-ingested")).not.toThrow();
  });

  it("re-save is atomic: no leftover staging/stale directories and only the new content is served", () => {
    const store = new MirrorStore(dir);
    store.saveMirror("m", bundle("first"));
    store.saveMirror("m", bundle("second"));
    store.saveMirror("m", bundle("third"));
    expect(store.retrieve("m", "q")[0]?.text).toBe("third");

    // Only the final per-matter directory should remain — no .staging-*/.stale-* siblings.
    const entries = readdirSync(dir);
    expect(entries).toEqual(["m"]);
  });

  it("a first-time save (no prior directory) is a single atomic rename", () => {
    const store = new MirrorStore(dir);
    const status = store.saveMirror("brand-new", Buffer.from("bytes"));
    expect(status.bytes).toBe(5);

    expect(existsSync(join(dir, encodeURIComponent("brand-new"), "index.bin"))).toBe(true);
    expect(readdirSync(dir).some((e) => e.includes(".staging-"))).toBe(false);
  });
});
