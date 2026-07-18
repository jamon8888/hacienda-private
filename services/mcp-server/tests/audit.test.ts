import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type MetadataStore } from "../src/store.js";

let dir: string;
let store: MetadataStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xberg-audit-"));
  store = openStore(join(dir, "meta.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("audit log", () => {
  it("records and reads back an entry with the real actor", () => {
    const entry = store.recordAudit("owner", "ingest", "create_matter", "m-1");
    expect(entry.actor).toBe("owner");
    expect(entry.action).toBe("create_matter");
    expect(entry.matter_id).toBe("m-1");
    const rows = store.getAudit("m-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("owner");
  });

  it("records an entry with no matter", () => {
    const entry = store.recordAudit("owner", "read", "list_matters");
    expect(entry.matter_id).toBeNull();
    expect(store.getAudit()).toHaveLength(1);
  });
});
