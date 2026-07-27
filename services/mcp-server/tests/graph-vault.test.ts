import { describe, expect, it } from "vitest";
import { decryptBrowserVault } from "../src/graph-vault.js";

// Same fixture vector as crates/xberg/src/text/browser_vault.rs's decrypts_browser_vault_format
// test — generated from the real sealVault/deriveKey WebCrypto calls in
// packages/wasm-pipeline/src/redact.ts, with fixed (non-random) salt/IV so the output is
// reproducible. Passphrase: "correct horse battery staple". Plaintext (JSON):
// `[{"token":"{{C0_PERSON_1}}","original":"Jean Dupont","category":"PERSON","kind":"PERSON","start":10,"end":21}]`
// Keeping this identical to the Rust fixture proves both hosts agree on the wire format without
// maintaining two independently-generated vectors.
const SALT = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const CIPHER = new Uint8Array([
  100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 177, 198, 179, 252, 219, 132, 174, 161, 219, 146, 239,
  225, 228, 208, 250, 124, 126, 222, 129, 70, 93, 108, 31, 52, 250, 6, 9, 191, 47, 50, 149, 133, 247, 106, 39, 21, 221,
  63, 34, 193, 212, 202, 109, 144, 95, 189, 116, 38, 175, 102, 81, 36, 202, 97, 140, 32, 99, 178, 220, 25, 67, 219, 16,
  118, 165, 124, 33, 163, 19, 75, 26, 228, 197, 75, 97, 242, 241, 68, 29, 188, 70, 183, 181, 176, 165, 36, 233, 228,
  115, 221, 52, 247, 51, 101, 84, 63, 214, 26, 53, 166, 104, 205, 138, 157, 127, 45, 181, 153, 154, 135, 122, 194, 18,
  88, 181, 252, 42, 108, 3, 122, 122, 179, 34, 175, 216, 8,
]);

describe("decryptBrowserVault", () => {
  it("decrypts a browser vault sealed by redact.ts's sealVault (shared fixture with browser_vault.rs)", () => {
    const plaintext = decryptBrowserVault(CIPHER, SALT, "correct horse battery staple");
    const json = plaintext.toString("utf8");
    expect(json).toContain("Jean Dupont");
    expect(json).toContain("{{C0_PERSON_1}}");
  });

  it("fails closed with the wrong passphrase", () => {
    expect(() => decryptBrowserVault(CIPHER, SALT, "wrong passphrase")).toThrow(/wrong passphrase|corrupted/);
  });

  it("rejects a cipher too short to contain an IV and GCM tag", () => {
    expect(() => decryptBrowserVault(new Uint8Array([1, 2, 3]), SALT, "anything")).toThrow(/too short/);
  });

  it("rejects a salt that isn't exactly 16 bytes", () => {
    expect(() => decryptBrowserVault(CIPHER, new Uint8Array(8), "anything")).toThrow(/16 bytes/);
  });
});
