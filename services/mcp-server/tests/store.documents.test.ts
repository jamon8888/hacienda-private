import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../src/store.js";

let dirs: string[] = [];
let stores: MetadataStore[] = [];
function makeStore(): MetadataStore {
  const dir = mkdtempSync(join(tmpdir(), "xberg-docs-"));
  dirs.push(dir);
  const store = new MetadataStore(join(dir, "meta.sqlite"));
  stores.push(store);
  return store;
}
afterEach(() => {
  // Close DB handles before removing their files — better-sqlite3 holds an
  // open handle (WAL mode), which makes rmSync fail with EPERM on Windows
  // if the store isn't closed first. See store.test.ts/tools.test.ts/
  // forget.test.ts for the same pattern.
  for (const s of stores) s.close();
  stores = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("documents", () => {
  it("creates a document and finds it by content hash", () => {
    const store = makeStore();
    const matter = store.createMatter("Acme v Doe");
    const folder = store.createFolder(matter.id, "Discovery", "/tmp/discovery");

    const doc = store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/discovery/a.txt",
      content_hash: "abc123",
      ingested_via: "mcp",
    });

    expect(doc.status).toBe("processing");
    expect(store.findDocumentByHash(folder.id, "abc123")?.id).toBe(doc.id);
    expect(store.findDocumentByHash(folder.id, "not-there")).toBeUndefined();
  });

  it("updates document status and rolls up into folder aggregates", () => {
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

    store.updateDocumentStatus(doc.id, "done", { pages: 3, chunk_count: 5, pii_count: 2 });
    store.updateFolderStatus(folder.id, "done");

    const folders = store.getFolders(matter.id);
    expect(folders).toHaveLength(1);
    expect(folders[0]?.status).toBe("done");
    expect(folders[0]?.document_count).toBe(1);
    expect(folders[0]?.pii_count).toBe(2);

    const docs = store.getDocumentsByFolder(folder.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.status).toBe("done");
    expect(docs[0]?.pages).toBe(3);
  });

  it("records an error status with a message", () => {
    const store = makeStore();
    const matter = store.createMatter("Acme v Doe");
    const folder = store.createFolder(matter.id, "Discovery");
    const doc = store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/bad.pdf",
      content_hash: "h2",
      ingested_via: "mcp",
    });

    store.updateDocumentStatus(doc.id, "error", { error_message: "corrupt PDF" });

    const docs = store.getDocumentsByFolder(folder.id);
    expect(docs[0]?.status).toBe("error");
    expect(docs[0]?.error_message).toBe("corrupt PDF");
  });
});
