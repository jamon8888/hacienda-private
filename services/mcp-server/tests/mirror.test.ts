import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorStore } from "../src/mirror.js";

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

  it("loadMirror never throws even if edgevec is unavailable", async () => {
    const store = new MirrorStore(dir);
    store.saveMirror("m", Buffer.from("index-bytes"));
    const result = await store.loadMirror("m");
    expect(result.matter_id).toBe("m");
    expect(typeof result.loaded).toBe("boolean");
  });
});
