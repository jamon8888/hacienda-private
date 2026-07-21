import type { Document, DocumentPiiEntity, Folder, Matter } from "@xberg-io/core";

// The mcp-server serves the API and the static UI from the same origin (see
// services/mcp-server/src/auth.ts's isSameOriginRequest check, which every /api/* route relies
// on) — but on ANY port, not just the 8787 default. Hardcoding that default broke every
// deployment running on a different port: the browser would try to reach a server that was
// never there. NEXT_PUBLIC_API_BASE remains a real override for genuinely cross-origin setups;
// the browser's own origin is the correct default otherwise.
function resolveBase(): string {
	const override = process.env.NEXT_PUBLIC_API_BASE;
	if (override) return override;
	if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
	return "http://localhost:8787";
}

const BASE = resolveBase();
const API = `${BASE}/api`;

async function json<T>(res: Response): Promise<T> {
	if (!res.ok) {
		const msg = await res.text().catch(() => res.statusText);
		throw new Error(msg || `request failed: ${res.status}`);
	}
	return res.json() as Promise<T>;
}

export async function getMatters(token: string): Promise<Matter[]> {
	const res = await fetch(`${API}/matters`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const data = await json<{ matters: Matter[] }>(res);
	return data.matters;
}

export async function createMatter(token: string, name: string): Promise<Matter> {
	const res = await fetch(`${API}/matters`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ name }),
	});
	return json<Matter>(res);
}

export async function forgetMatter(token: string, matterId: string): Promise<{ forgotten: unknown }> {
	const res = await fetch(`${API}/matters/${encodeURIComponent(matterId)}`, {
		method: "DELETE",
		headers: { authorization: `Bearer ${token}` },
	});
	return json<{ forgotten: unknown }>(res);
}

export async function getFolders(token: string, matterId: string): Promise<Folder[]> {
	const res = await fetch(`${API}/folders?matter_id=${encodeURIComponent(matterId)}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const data = await json<{ folders: Folder[] }>(res);
	return data.folders;
}

export async function createFolder(token: string, matterId: string, name: string, path?: string): Promise<Folder> {
	const res = await fetch(`${API}/folders`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ matter_id: matterId, name, path }),
	});
	return json<Folder>(res);
}

export async function getConsent(token: string, matterId: string) {
	const res = await fetch(`${API}/consent?matter_id=${encodeURIComponent(matterId)}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	return json<{ consent: unknown }>(res);
}

export async function grantConsent(
	token: string,
	subject: string,
	matterId: string,
	scope: string,
	expiresAt?: string,
) {
	const res = await fetch(`${API}/consent`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ subject, matter_id: matterId, scope, expires_at: expiresAt }),
	});
	return json<unknown>(res);
}

export async function pushMirror(token: string, matterId: string, payload: unknown): Promise<void> {
	const res = await fetch(`${API}/rag/mirror?matter_id=${encodeURIComponent(matterId)}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: JSON.stringify(payload),
	});
	if (!res.ok) {
		const msg = await res.text().catch(() => res.statusText);
		throw new Error(msg || `mirror push failed: ${res.status}`);
	}
}

export async function getFolderDocuments(token: string, folderId: string): Promise<Document[]> {
	const res = await fetch(`${API}/folders/${encodeURIComponent(folderId)}/documents`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const data = await json<{ documents: Document[] }>(res);
	return data.documents;
}

// Registers a document ingested entirely client-side. Only metadata crosses the wire — the
// browser has already run extraction/OCR/PII/redaction locally and never uploads the raw file.
export async function createDocument(
	token: string,
	folderId: string,
	input: { path: string; content_hash: string },
): Promise<Document> {
	const res = await fetch(`${API}/folders/${encodeURIComponent(folderId)}/documents`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify(input),
	});
	return json<Document>(res);
}

export async function updateDocumentStatus(
	token: string,
	documentId: string,
	input: {
		status: "processing" | "done" | "error";
		pages?: number;
		chunk_count?: number;
		pii_count?: number;
		error_message?: string;
	},
): Promise<Document> {
	const res = await fetch(`${API}/documents/${encodeURIComponent(documentId)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify(input),
	});
	return json<Document>(res);
}

export async function getDocument(token: string, documentId: string): Promise<Document> {
	const res = await fetch(`${API}/documents/${encodeURIComponent(documentId)}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	return json<Document>(res);
}

export async function getDocumentPii(token: string, documentId: string): Promise<DocumentPiiEntity[]> {
	const res = await fetch(`${API}/documents/${encodeURIComponent(documentId)}/pii`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const data = await json<{ pii: DocumentPiiEntity[] }>(res);
	return data.pii;
}
