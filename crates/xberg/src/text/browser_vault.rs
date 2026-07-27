//! Decrypts the browser's PBKDF2/AES-256-GCM vault wire format
//! (`packages/wasm-pipeline/src/redact.ts`'s `sealVault`/`openVault`) — a
//! different scheme from [`super::redaction::rehydration`]'s scrypt-based one, which
//! protects a separate, native-only rehydration map produced by
//! `xberg extract --redact`. This module exists for the entity-graph
//! `graph_query` MCP tool, which needs to decrypt a graph payload sealed by
//! the browser at ingestion time.
//!
//! Wire format: two separate fields, matching how the mirror bundle already
//! carries `vault`/`vaultSalt` as parallel byte arrays (not a single
//! self-describing blob like [`super::redaction::rehydration`]'s):
//! - `salt`: 16 random bytes.
//! - `cipher`: a 12-byte AES-GCM IV, followed by ciphertext with a 16-byte
//!   GCM tag appended (WebCrypto's default tag placement/length).
//!
//! Key derivation: PBKDF2-HMAC-SHA256(passphrase, salt, 100,000 iterations),
//! 32-byte output — must stay in sync with `redact.ts`'s `deriveKey`. The
//! `decrypts_browser_vault_format` test pins this compatibility against a
//! fixture generated with the real WebCrypto calls `redact.ts` uses.
//! Changing these parameters breaks compatibility with existing
//! browser-sealed vaults.

use aes_gcm::aead::AeadInPlace;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::{Result, XbergError};

const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32;
/// Must stay in sync with `packages/wasm-pipeline/src/redact.ts`'s `deriveKey`.
const PBKDF2_ITERATIONS: u32 = 100_000;

fn derive_key(passphrase: &str, salt: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, PBKDF2_ITERATIONS, &mut *key);
    key
}

/// Decrypt a payload sealed by the browser's `sealVault`. `cipher` is the
/// 12-byte-IV-prefixed AES-256-GCM ciphertext (`SealedVault.cipher`); `salt`
/// is the matching `SealedVault.salt`. Returns the raw decrypted bytes
/// (typically UTF-8 JSON — the caller deserializes into whatever shape was
/// sealed), zeroized on drop since it holds sensitive plaintext (real entity
/// names, for the entity-graph use case).
pub fn decrypt_browser_vault(cipher: &[u8], salt: &[u8], passphrase: &str) -> Result<Zeroizing<Vec<u8>>> {
    if cipher.len() < IV_LEN + TAG_LEN {
        return Err(XbergError::validation(
            "browser vault cipher is too short to contain an IV and GCM tag",
        ));
    }
    let (iv, body) = cipher.split_at(IV_LEN);

    let key_bytes = derive_key(passphrase, salt);
    let gcm = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&*key_bytes));
    let nonce = Nonce::from_slice(iv);

    let mut buffer = Zeroizing::new(body.to_vec());
    gcm.decrypt_in_place(nonce, b"", &mut *buffer)
        .map_err(|_| XbergError::validation("failed to decrypt browser vault: wrong passphrase or corrupted data"))?;
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generated from the real `sealVault`/`deriveKey` WebCrypto calls in
    // packages/wasm-pipeline/src/redact.ts, with fixed (non-random) salt/IV
    // so the output is reproducible — see the plan's Step 0 spike. Passphrase:
    // "correct horse battery staple". Plaintext (JSON):
    // `[{"token":"{{C0_PERSON_1}}","original":"Jean Dupont","category":"PERSON","kind":"PERSON","start":10,"end":21}]`
    const SALT: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const CIPHER: [u8; 138] = [
        100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 177, 198, 179, 252, 219, 132, 174, 161, 219, 146,
        239, 225, 228, 208, 250, 124, 126, 222, 129, 70, 93, 108, 31, 52, 250, 6, 9, 191, 47, 50, 149, 133, 247, 106,
        39, 21, 221, 63, 34, 193, 212, 202, 109, 144, 95, 189, 116, 38, 175, 102, 81, 36, 202, 97, 140, 32, 99, 178,
        220, 25, 67, 219, 16, 118, 165, 124, 33, 163, 19, 75, 26, 228, 197, 75, 97, 242, 241, 68, 29, 188, 70, 183,
        181, 176, 165, 36, 233, 228, 115, 221, 52, 247, 51, 101, 84, 63, 214, 26, 53, 166, 104, 205, 138, 157, 127,
        45, 181, 153, 154, 135, 122, 194, 18, 88, 181, 252, 42, 108, 3, 122, 122, 179, 34, 175, 216, 8,
    ];

    #[test]
    fn decrypts_browser_vault_format() {
        let plaintext = decrypt_browser_vault(&CIPHER, &SALT, "correct horse battery staple")
            .expect("Rust decrypts a TS-sealed browser vault");
        let json = String::from_utf8(plaintext.to_vec()).expect("plaintext is valid UTF-8");
        assert!(json.contains("Jean Dupont"), "got {json}");
        assert!(json.contains("{{C0_PERSON_1}}"), "got {json}");
    }

    #[test]
    fn wrong_passphrase_fails_closed() {
        let err = decrypt_browser_vault(&CIPHER, &SALT, "wrong passphrase").unwrap_err();
        assert!(err.to_string().contains("wrong passphrase"), "got {err}");
    }

    #[test]
    fn truncated_cipher_is_rejected_before_attempting_decryption() {
        let err = decrypt_browser_vault(&[1, 2, 3], &SALT, "anything").unwrap_err();
        assert!(err.to_string().contains("too short"), "got {err}");
    }
}
