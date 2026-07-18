import type { KeyVault } from "../vault.js";

// Owner-only decryption of a curtain-vault ciphertext. Returns UTF-8 plaintext. Never logs the
// plaintext — callers must treat the return value as sensitive.
export function decryptChunk(vault: KeyVault, cipher: Uint8Array): string {
  return vault.open(cipher).toString("utf8");
}
