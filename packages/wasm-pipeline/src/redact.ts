import type { PiiEntity } from "@xberg-io/core";

export interface RedactionEntry {
	token: string;
	original: string;
	category: string;
	kind: string;
	start: number;
	end: number;
}

export interface RedactionSpan {
	kind: string;
	start: number;
	end: number;
}

export interface RedactTextResult {
	redacted: string;
	tokens: RedactionToken[];
}

export interface RedactionToken {
	token: string;
	start: number;
	end: number;
	kind: string;
}

export interface SealedVault {
	cipher: Uint8Array;
	salt: Uint8Array;
}

export interface RedactionResult {
	redacted: string;
	entries: RedactionEntry[];
	sealed: SealedVault;
}

function normalizeCategory(kind: string): string {
	const cat = kind
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cat === "" ? "UNKNOWN" : cat;
}

export function buildRedaction(
	text: string,
	pii: PiiEntity[],
	prefix?: string,
): { redacted: string; entries: RedactionEntry[] } {
	const sorted = [...pii].sort((a, b) => a.start - b.start);
	const entries: RedactionEntry[] = [];
	const counters = new Map<string, number>();
	let prevEnd = text.length;
	const accepted: PiiEntity[] = [];
	for (const e of [...sorted].reverse()) {
		if (e.start < 0 || e.end > text.length || e.start >= e.end) continue;
		if (e.end > prevEnd) continue;
		accepted.push(e);
		prevEnd = e.start;
	}
	accepted.reverse();

	for (const e of accepted) {
		const cat = normalizeCategory(e.kind);
		const n = (counters.get(cat) ?? 0) + 1;
		counters.set(cat, n);
		const token = `{{${prefix ? `${prefix}_` : ""}${cat}_${n}}}`;
		entries.push({
			token,
			original: text.slice(e.start, e.end),
			category: cat,
			kind: e.kind,
			start: e.start,
			end: e.end,
		});
	}

	let result = text;
	for (const en of [...entries].reverse()) {
		result = result.slice(0, en.start) + en.token + result.slice(en.end);
	}
	return { redacted: result, entries };
}

export function rehydrate(redacted: string, entries: RedactionEntry[]): string {
	let out = redacted;
	for (const en of entries) {
		out = out.split(en.token).join(en.original);
	}
	return out;
}

export async function sealVault(entries: RedactionEntry[], passphrase: string): Promise<SealedVault> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await deriveKey(passphrase, salt);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = new TextEncoder().encode(JSON.stringify(entries));
	const cipherBuf = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv as unknown as BufferSource },
		key,
		data as unknown as BufferSource,
	);
	const cipherBody = new Uint8Array(cipherBuf);
	const cipher = new Uint8Array(12 + cipherBody.length);
	cipher.set(iv, 0);
	cipher.set(cipherBody, 12);
	return { cipher, salt };
}

export async function openVault(sealed: SealedVault, passphrase: string): Promise<RedactionEntry[]> {
	const key = await deriveKey(passphrase, sealed.salt);
	const iv = sealed.cipher.slice(0, 12);
	const body = sealed.cipher.slice(12);
	const plainBuf = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: iv as unknown as BufferSource },
		key,
		body as unknown as BufferSource,
	);
	const json = new TextDecoder().decode(plainBuf);
	return JSON.parse(json) as RedactionEntry[];
}

export async function redactDocument(
	text: string,
	pii: PiiEntity[],
	passphrase: string,
	prefix?: string,
): Promise<RedactionResult> {
	const { redacted, entries } = buildRedaction(text, pii, prefix);
	const sealed = await sealVault(entries, passphrase);
	return { redacted, entries, sealed };
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
	const enc = new TextEncoder();
	const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: 100_000, hash: "SHA-256" },
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

// In-house reversible redaction (T3): replace each detected span with a per-kind `<KIND_n>` token,
// counting occurrences independently per kind (1-based). Pure string logic, no crypto. The matched
// surface values are vaulted separately (T4) so a redacted document on disk reveals nothing.
export function redactText(text: string, spans: RedactionSpan[]): RedactTextResult {
	const sorted = [...spans]
		.filter((s) => s.start >= 0 && s.end <= text.length && s.start < s.end)
		.sort((a, b) => b.start - a.start);
	const counters = new Map<string, number>();
	let result = text;
	const tokens: RedactionToken[] = [];
	for (const span of sorted) {
		const kind =
			span.kind
				.toUpperCase()
				.replace(/[^A-Z0-9]+/g, "_")
				.replace(/^_+|_+$/g, "") || "UNKNOWN";
		const n = (counters.get(kind) ?? 0) + 1;
		counters.set(kind, n);
		const token = `<${kind}_${n}>`;
		result = result.slice(0, span.start) + token + result.slice(span.end);
		tokens.push({ token, start: span.start, end: span.start + token.length, kind: span.kind });
	}
	return { redacted: result, tokens };
}

// Reverse redactText using the original surface values keyed by token.
export function rehydrateText(redacted: string, tokens: { token: string; value: string }[]): string {
	let out = redacted;
	for (const t of tokens) {
		out = out.split(t.token).join(t.value);
	}
	return out;
}
