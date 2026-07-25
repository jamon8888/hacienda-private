import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorStore, SHARED_EMBEDDING_IDENTITY } from "../src/mirror.js";

let dirs: string[] = [];
function makeMirror(): MirrorStore {
  const dir = mkdtempSync(join(tmpdir(), "xberg-mirror-"));
  dirs.push(dir);
  return new MirrorStore(dir);
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("MirrorStore.appendMirror", () => {
  it("creates a bundle on first append with empty index/vault", async () => {
    const mirror = makeMirror();
    mirror.appendMirror("m1", {
      pii: [{ doc_id: "d1", kind: "person", start: 0, end: 8, token: "PERSON_1" }],
      chunks: [{ doc_id: "d1", chunk_index: 0, text: "redacted chunk", score: 1, citation: "d1#0" }],
    });

    await mirror.loadMirror("m1");
    expect(mirror.listPii("m1", "d1")).toHaveLength(1);
    expect(mirror.retrieve("m1", "", 8)).toHaveLength(1);
  });

  it("preserves vault salt when appending to an existing browser mirror bundle", async () => {
    const mirror = makeMirror();
    mirror.saveMirror(
      "m1",
      Buffer.from(
        JSON.stringify({
          version: 2,
          embedding_identity: SHARED_EMBEDDING_IDENTITY,
          index: [1],
          vault: [2],
          vaultSalt: [3, 4],
          pii: [],
          chunks: [],
        }),
      ),
    );

    mirror.appendMirror("m1", {
      pii: [{ doc_id: "d1", kind: "person", start: 0, end: 8, token: "PERSON_1" }],
      chunks: [{ doc_id: "d1", chunk_index: 0, text: "redacted chunk", score: 1, citation: "d1#0" }],
    });

    await mirror.loadMirror("m1");
    const bundle = JSON.parse(readFileSync(join(dirs[0]!, "m1", "bundle.json"), "utf8")) as { vaultSalt: number[] };
    expect(bundle.vaultSalt).toEqual([3, 4]);
  });

  it("merges a second document's data without dropping the first", async () => {
    const mirror = makeMirror();
    mirror.appendMirror("m1", {
      pii: [{ doc_id: "d1", kind: "person", start: 0, end: 8, token: "PERSON_1" }],
      chunks: [{ doc_id: "d1", chunk_index: 0, text: "first doc", score: 1, citation: "d1#0" }],
    });
    mirror.appendMirror("m1", {
      pii: [{ doc_id: "d2", kind: "email", start: 0, end: 10, token: "EMAIL_1" }],
      chunks: [{ doc_id: "d2", chunk_index: 0, text: "second doc", score: 1, citation: "d2#0" }],
    });

    await mirror.loadMirror("m1");
    expect(mirror.listPii("m1", "d1")).toHaveLength(1);
    expect(mirror.listPii("m1", "d2")).toHaveLength(1);
    expect(mirror.retrieve("m1", "", 8)).toHaveLength(2);
  });
});
