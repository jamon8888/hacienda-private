// Dependency-free WebCrypto AES-GCM vault for the browser engine. The key is derived from a
// passphrase via PBKDF2 (SHA-256, 200k iterations) — Argon2 would be nicer but pulls a native dep;
// PBKDF2 is acceptable and runs in-browser and under Node 24 webcrypto for tests. The Node service's
// `KeyVault` (services/mcp-server/src/vault.ts) is a separate AES-GCM implementation used only for
// offline rehydration; this class is the browser owner's vault.

const PBKDF2_ITERATIONS = 200_000;

async function getSubtle(): Promise<globalThis.SubtleCrypto> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && c.subtle) return c.subtle;
  // Node 24 fallback for test environments without a global webcrypto. Real browsers always hit
  // the branch above, so this import must never be bundled — webpack's resolve.alias doesn't
  // intercept "node:"-scheme specifiers (they resolve before alias matching), so it's excluded
  // from the build graph entirely instead.
  const { webcrypto } = await import(/* webpackIgnore: true */ "node:crypto");
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

export interface CipherBundle {
  iv: string;
  ct: string;
}

export class BrowserVault {
  constructor(private readonly key: CryptoKey) {}

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
