// Dependency-free WebCrypto AES-GCM vault for the browser engine. The key is derived from a
// passphrase via PBKDF2 (SHA-256, 200k iterations) — Argon2 would be nicer but pulls a native dep;
// PBKDF2 is acceptable and runs in-browser and under Node 24 webcrypto for tests. The Node service's
// `KeyVault` (services/mcp-server/src/vault.ts) is a separate AES-GCM implementation used only for
// offline rehydration; this class is the browser owner's vault.

const PBKDF2_ITERATIONS = 200_000;

async function getSubtle(): Promise<globalThis.SubtleCrypto> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && c.subtle) return c.subtle;
  // Node 24 fallback for test environments without a global webcrypto.
  const { webcrypto } = await import("crypto");
  if (webcrypto?.subtle) return webcrypto.subtle as unknown as globalThis.SubtleCrypto;
  throw new Error("no WebCrypto SubtleCrypto available");
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Base64-encoded AES-GCM output: the IV and ciphertext for a single value. */
export interface CipherBundle {
  iv: string;
  ct: string;
}

/**
 * Dependency-free WebCrypto AES-GCM vault for the browser engine.
 *
 * Keys are derived from a passphrase via PBKDF2 (SHA-256). This is the browser
 * owner's vault, distinct from the Node service's offline-rehydration vault.
 */
export class BrowserVault {
  constructor(private readonly key: CryptoKey) {}

  /**
   * Derive an AES-GCM key from a passphrase and salt via PBKDF2.
   *
   * @param passphrase - The user passphrase.
   * @param salt - Per-vault random salt.
   * @returns A non-extractable AES-GCM `CryptoKey`.
   */
  static async deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const subtle = await getSubtle();
    const baseKey = await subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return subtle.deriveKey(
      { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  /**
   * Encrypt plaintext bytes with a fresh random IV.
   *
   * @param plaintext - The bytes to encrypt.
   * @returns A base64 {@link CipherBundle} (IV + ciphertext).
   */
  async encrypt(plaintext: Uint8Array): Promise<CipherBundle> {
    const subtle = await getSubtle();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const buf = await subtle.encrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      this.key,
      plaintext as unknown as BufferSource,
    );
    return { iv: toBase64(iv), ct: toBase64(new Uint8Array(buf)) };
  }

  /**
   * Decrypt a {@link CipherBundle} back into plaintext bytes.
   *
   * @param bundle - The base64 IV + ciphertext to decrypt.
   * @returns The decrypted bytes.
   */
  async decrypt(bundle: CipherBundle): Promise<Uint8Array> {
    const subtle = await getSubtle();
    const iv = fromBase64(bundle.iv);
    const ct = fromBase64(bundle.ct);
    const buf = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      this.key,
      ct as unknown as BufferSource,
    );
    return new Uint8Array(buf);
  }

  /**
   * Decrypt an IV-prefixed base64 ciphertext blob to a UTF-8 string.
   *
   * @param cipherB64 - Base64 of `IV(12 bytes) || ciphertext`.
   * @returns The decrypted plaintext string.
   * @throws Error if the input is shorter than the 12-byte IV.
   */
  async rehydrate(cipherB64: string): Promise<string> {
    const bytes = fromBase64(cipherB64);
    if (bytes.length < 12) throw new Error("ciphertext too short");
    const iv = bytes.subarray(0, 12);
    const ct = bytes.subarray(12);
    const subtle = await getSubtle();
    const buf = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      this.key,
      ct as unknown as BufferSource,
    );
    return new TextDecoder().decode(buf);
  }
}
