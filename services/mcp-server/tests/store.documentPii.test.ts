import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../src/store.js";

let dirs: string[] = [];
let stores: MetadataStore[] = [];
function makeStore(): MetadataStore {
  const dir = mkdtempSync(join(tmpdir(), "xberg-pii-"));
  dirs.push(dir);
  const store = new MetadataStore(join(dir, "meta.sqlite"));
  stores.push(store);
  return store;
}
afterEach(() => {
  // Close DB handles before removing their files — better-sqlite3 holds an
  // open handle (WAL mode), which makes rmSync fail with EPERM on Windows
  // if the store isn't closed first. See store.test.ts/tools.test.ts/
  // store.documents.test.ts for the same pattern.
  for (const s of stores) s.close();
  stores = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("document_pii", () => {
  it("inserts and lists PII entities for a document", () => {
    const store = makeStore();
    const matter = store.createMatter("Acme v Doe");
    const folder = store.createFolder(matter.id, "Discovery");
    const doc = store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/a.txt",
      content_hash: "h1",
      ingested_via: "mcp",
    });

    const inserted = store.insertPiiEntities(doc.id, [
      { kind: "person", start: 0, end: 9, text: "Jane Doe" },
      { kind: "email", start: 20, end: 38, text: "jane@example.com" },
    ]);

    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.reviewed).toBe(false);

    const listed = store.getPiiByDocument(doc.id);
    expect(listed.map((e) => e.kind)).toEqual(["person", "email"]);
  });

  it("returns an empty array for a document with no PII", () => {
    const store = makeStore();
    const matter = store.createMatter("Acme v Doe");
    const folder = store.createFolder(matter.id, "Discovery");
    const doc = store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/clean.txt",
      content_hash: "h2",
      ingested_via: "mcp",
    });

    expect(store.getPiiByDocument(doc.id)).toEqual([]);
  });
});
