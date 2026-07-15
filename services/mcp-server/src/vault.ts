import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./error.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export interface KeyVaultOptions {
  key?: Buffer;
  vaultKeyPath?: string;
  passphrase?: string;
}

export class KeyVault {
  private readonly key: Buffer;

  constructor(opts: KeyVaultOptions = {}) {
    if (opts.key) {
      this.key = opts.key;
      if (this.key.length !== KEY_LEN) {
        throw new AppError("store", "vault key must be 32 bytes");
      }
      return;
    }

    if (opts.passphrase && opts.vaultKeyPath) {
      this.key = KeyVault.deriveFromPassphrase(opts.passphrase, opts.vaultKeyPath);
      return;
    }

    if (opts.vaultKeyPath && existsSync(opts.vaultKeyPath)) {
      const raw = readFileSync(opts.vaultKeyPath, "utf8").trim();
      this.key = Buffer.from(raw, "base64");
      return;
    }

    this.key = randomBytes(KEY_LEN);
    if (opts.vaultKeyPath) {
      KeyVault.persistKey(this.key, opts.vaultKeyPath);
    }
  }

  private static persistKey(key: Buffer, vaultKeyPath: string): void {
    mkdirSync(dirname(vaultKeyPath), { recursive: true });
    writeFileSync(vaultKeyPath, key.toString("base64"), { mode: 0o600 });
    try {
      chmodSync(vaultKeyPath, 0o600);
    } catch {
      // best-effort hardening; ignore on platforms without POSIX perms
    }
  }

  private static deriveFromPassphrase(passphrase: string, vaultKeyPath: string): Buffer {
    let salt: Buffer;
    if (existsSync(vaultKeyPath)) {
      salt = Buffer.from(readFileSync(vaultKeyPath, "utf8").trim(), "base64");
    } else {
      salt = randomBytes(16);
      mkdirSync(dirname(vaultKeyPath), { recursive: true });
      writeFileSync(vaultKeyPath, salt.toString("base64"), { mode: 0o600 });
    }
    return pbkdf2Sync(passphrase, salt, 200_000, KEY_LEN, "sha256");
  }

  seal(plaintext: Uint8Array): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]);
  }

  open(data: Uint8Array): Buffer {
    const buf = Buffer.from(data);
    if (buf.length < IV_LEN + TAG_LEN) {
      throw new AppError("store", "vault ciphertext too short");
    }
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch {
      throw new AppError("store", "vault decrypt failed (wrong key or tampered)");
    }
  }
}
