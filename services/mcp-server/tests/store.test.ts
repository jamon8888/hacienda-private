import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.js";

describe("MetadataStore", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "store-"));
    dbPath = join(dir, "meta.sqlite");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates and lists matters", () => {
    const store = openStore(dbPath);
    const m = store.createMatter("Acme v Beta");
    expect(store.getMatters()).toHaveLength(1);
    expect(store.getMatter(m.id)?.name).toBe("Acme v Beta");
    store.close();
  });

  it("scopes folders under a matter", () => {
    const store = openStore(dbPath);
    const m = store.createMatter("M");
    const f = store.createFolder(m.id, "Discovery", "/docs");
    expect(store.getFolders(m.id)).toHaveLength(1);
    expect(f.matter_id).toBe(m.id);
    expect(() => store.createFolder("missing", "x")).toThrow();
    store.close();
  });

  it("tracks active consent", () => {
    const store = openStore(dbPath);
    const m = store.createMatter("M");
    store.grantConsent({ subject: "claude", matter_id: m.id, scope: "read" });
    expect(store.isConsentActive("claude", m.id, "read")).toBe(true);
    expect(store.isConsentActive("claude", m.id, "redact")).toBe(false);
    store.close();
  });
});
