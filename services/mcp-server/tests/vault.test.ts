import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { KeyVault } from "../src/vault.js";

describe("KeyVault", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips seal/open with the same key", () => {
    const key = randomBytes(32);
    const vault = new KeyVault({ key });
    const secret = new TextEncoder().encode("curtain-origin-123");
    const sealed = vault.seal(secret);
    expect(sealed).not.toEqual(Buffer.from(secret));
    const opened = vault.open(sealed);
    expect(opened.toString("utf8")).toBe("curtain-origin-123");
  });

  it("throws when opened with a different key", () => {
    const vaultA = new KeyVault({ key: randomBytes(32) });
    const vaultB = new KeyVault({ key: randomBytes(32) });
    const sealed = vaultA.seal(new TextEncoder().encode("x"));
    expect(() => vaultB.open(sealed)).toThrow();
  });

  it("persists and reloads a generated key from vaultKeyPath", () => {
    const keyPath = join(dir, "vault.key");
    const first = new KeyVault({ vaultKeyPath: keyPath });
    const second = new KeyVault({ vaultKeyPath: keyPath });
    const sealed = first.seal(new TextEncoder().encode("persist"));
    expect(second.open(sealed).toString("utf8")).toBe("persist");
  });
});
