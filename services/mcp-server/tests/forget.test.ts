import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type MetadataStore } from "../src/store.js";
import { MirrorStore, SHARED_EMBEDDING_IDENTITY } from "../src/mirror.js";

describe("forget lifecycle", () => {
  let dir: string;
  let dbPath: string;
  let mirrorsDir: string;
  let store: MetadataStore;
  let mirror: MirrorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forget-"));
    dbPath = join(dir, "meta.sqlite");
    mirrorsDir = join(dir, "mirrors");
  });

  afterEach(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("wipes matter rows, mirror files, and records a forget audit", async () => {
    store = openStore(dbPath);
    mirror = new MirrorStore(mirrorsDir);

    const matter = store.createMatter("Acme v Beta");
    const folder = store.createFolder(matter.id, "Discovery");
    store.recordIngest(folder.id, matter.id);
    store.grantConsent({ subject: "*", matter_id: matter.id, scope: "read" });
    store.recordRedaction("d1", matter.id, ["e1"]);

    const bundle = {
      version: 2,
      embedding_identity: SHARED_EMBEDDING_IDENTITY,
      index: [1, 2, 3],
      vault: [4, 5, 6],
      vaultSalt: [7, 8],
      pii: [{ doc_id: "d1", kind: "PER", start: 0, end: 3, token: "t1" }],
      chunks: [{ doc_id: "d1", chunk_index: 0, text: "redacted", score: 0.9, citation: "d1#0" }],
    };
    mirror.saveMirror(matter.id, Buffer.from(JSON.stringify(bundle)));

    const idxPath = join(mirrorsDir, encodeURIComponent(matter.id), "index.bin");
    const jsonPath = join(mirrorsDir, encodeURIComponent(matter.id), "meta.json");
    expect(existsSync(idxPath)).toBe(true);

    const forgotten = store.forgetMatter(matter.id);
    mirror.forget(matter.id);

    expect(forgotten).toEqual({ matters: 1, folders: 1, consents: 1, ingests: 1, redactions: 1, audits: 0 });
    expect(store.getMatter(matter.id)).toBeUndefined();
    expect(existsSync(idxPath)).toBe(false);
    expect(existsSync(jsonPath)).toBe(false);

    await expect(mirror.loadMirror(matter.id)).rejects.toThrow();
    expect(() => mirror.listPii(matter.id, "d1")).toThrow();
  });

  it("throws not_found when forgetting a missing matter", () => {
    store = openStore(dbPath);
    expect(() => store.forgetMatter("nope")).toThrow();
  });

  it("records audit rows on forget", () => {
    store = openStore(dbPath);
    mirror = new MirrorStore(mirrorsDir);
    const matter = store.createMatter("M");
    store.recordAudit("mcp:read", "read", "rag_query", matter.id);
    const forgotten = store.forgetMatter(matter.id);
    expect(forgotten.audits).toBe(1);
    expect(store.getMatter(matter.id)).toBeUndefined();
  });
});
