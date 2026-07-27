import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { AppError } from "./error.js";

// Decrypts the browser's PBKDF2/AES-256-GCM entity-graph vault wire format
// (packages/wasm-pipeline/src/redact.ts's sealVault/deriveKey) — a direct port of the native
// host's crates/xberg/src/text/browser_vault.rs, which this repo already proved against the
// real WebCrypto output (see that module's decrypts_browser_vault_format test). Kept in sync
// with that module's constants and control flow so the two are easy to diff against each other.
//
// Wire format: two separate byte arrays (matching how the mirror bundle already carries
// vault/vaultSalt as parallel arrays, not one self-describing blob):
// - salt: 16 random bytes.
// - cipher: a 12-byte AES-GCM IV, followed by ciphertext with a 16-byte GCM tag appended
//   (WebCrypto's default tag placement/length).
//
// Key derivation: PBKDF2-HMAC-SHA256(passphrase, salt, 100_000 iterations), 32-byte output —
// must stay in sync with redact.ts's deriveKey. Changing these parameters breaks compatibility
// with existing browser-sealed graphs.
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PBKDF2_ITERATIONS = 100_000;

/**
 * Decrypt a payload sealed by the browser's `sealVault`/`sealPayload`. `cipher` is the
 * 12-byte-IV-prefixed AES-256-GCM ciphertext (`SealedVault.cipher`); `salt` is the matching
 * `SealedVault.salt`. Returns the raw decrypted bytes (typically UTF-8 JSON — the caller
 * deserializes into whatever shape was sealed).
 */
export function decryptBrowserVault(cipher: Uint8Array, salt: Uint8Array, passphrase: string): Buffer {
  if (salt.length !== SALT_LEN) {
    throw new AppError("bad_request", `browser vault salt must be exactly ${SALT_LEN} bytes, got ${salt.length}`);
  }
  if (cipher.length < IV_LEN + TAG_LEN) {
    throw new AppError("bad_request", "browser vault cipher is too short to contain an IV and GCM tag");
  }

  const iv = Buffer.from(cipher.subarray(0, IV_LEN));
  const body = Buffer.from(cipher.subarray(IV_LEN));
  const tag = body.subarray(body.length - TAG_LEN);
  const ciphertext = body.subarray(0, body.length - TAG_LEN);

  const key = pbkdf2Sync(passphrase, Buffer.from(salt), PBKDF2_ITERATIONS, KEY_LEN, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new AppError("bad_request", "failed to decrypt entity graph: wrong passphrase or corrupted data");
  }
}
