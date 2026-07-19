import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFolder, hashBytes } from "./walk.js";

let dirs: string[] = [];
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "xberg-walk-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.txt"), "hello");
  writeFileSync(join(dir, "b.png"), "not a document");
  writeFileSync(join(dir, ".hidden.txt"), "skip me");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "c.md"), "# nested");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "config"), "skip this dir");
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("walkFolder", () => {
  it("recursively finds supported files, skipping hidden files/dirs and unsupported extensions", async () => {
    const dir = makeFixture();
    const files = await walkFolder(dir);
    const relPaths = files.map((f) => f.path.replace(dir, "").replace(/\\/g, "/")).sort();

    expect(relPaths).toEqual(["/a.txt", "/sub/c.md"]);
    expect(files.every((f) => f.contentHash.length === 64)).toBe(true);
  });

  it("hashBytes is stable for identical content", () => {
    const a = hashBytes(Buffer.from("hello"));
    const b = hashBytes(Buffer.from("hello"));
    const c = hashBytes(Buffer.from("world"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
