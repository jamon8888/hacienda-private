import { describe, it, expect } from "vitest";
import { BrowserVault } from "./vault";

describe("BrowserVault (WebCrypto AES-GCM)", () => {
	const passphrase = "correct horse battery staple";
	const salt = new TextEncoder().encode("a-16-byte-salt!"); // 16 bytes

	it("round-trips plaintext via encrypt/decrypt", async () => {
		const key = await BrowserVault.deriveKey(passphrase, salt);
		const vault = new BrowserVault(key);
		const plaintext = new TextEncoder().encode("Jane Doe, Attorney at Acme");
		const bundle = await vault.encrypt(plaintext);
		const out = await vault.decrypt(bundle);
		expect(new TextDecoder().decode(out)).toBe("Jane Doe, Attorney at Acme");
	});

	it("rehydrate decrypts a base64 ct+iv blob", async () => {
		const key = await BrowserVault.deriveKey(passphrase, salt);
		const vault = new BrowserVault(key);
		const bundle = await vault.encrypt(new TextEncoder().encode("secret value"));
		const ivBytes = new Uint8Array(
			atob(bundle.iv)
				.split("")
				.map((c) => c.charCodeAt(0)),
		);
		const ctBytes = new Uint8Array(
			atob(bundle.ct)
				.split("")
				.map((c) => c.charCodeAt(0)),
		);
		const combined = new Uint8Array(ivBytes.length + ctBytes.length);
		combined.set(ivBytes, 0);
		combined.set(ctBytes, ivBytes.length);
		const b64 = btoa(String.fromCharCode(...combined));
		expect(await vault.rehydrate(b64)).toBe("secret value");
	});

	it("throws on wrong passphrase (GCM auth failure)", async () => {
		const key = await BrowserVault.deriveKey(passphrase, salt);
		const vault = new BrowserVault(key);
		const bundle = await vault.encrypt(new TextEncoder().encode("plaintext"));
		const wrongKey = await BrowserVault.deriveKey("wrong passphrase", salt);
		const wrongVault = new BrowserVault(wrongKey);
		await expect(wrongVault.decrypt(bundle)).rejects.toThrow();
	});
});
