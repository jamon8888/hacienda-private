import type { Document, DocumentPiiEntity, Folder, Matter } from "@xberg-io/core";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8787";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getMatters(token: string): Promise<Matter[]> {
  const res = await fetch(`${BASE}/matters`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await json<{ matters: Matter[] }>(res);
  return data.matters;
}

export async function createMatter(token: string, name: string): Promise<Matter> {
  const res = await fetch(`${BASE}/matters`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  return json<Matter>(res);
}

export async function getFolders(token: string, matterId: string): Promise<Folder[]> {
  const res = await fetch(`${BASE}/folders?matter_id=${encodeURIComponent(matterId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await json<{ folders: Folder[] }>(res);
  return data.folders;
}

export async function createFolder(token: string, matterId: string, name: string, path?: string): Promise<Folder> {
  const res = await fetch(`${BASE}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ matter_id: matterId, name, path }),
  });
  return json<Folder>(res);
}

export async function getConsent(token: string, matterId: string) {
  const res = await fetch(`${BASE}/consent?matter_id=${encodeURIComponent(matterId)}`, {
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
  const res = await fetch(`${BASE}/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ subject, matter_id: matterId, scope, expires_at: expiresAt }),
  });
  return json<unknown>(res);
}

export async function pushMirror(token: string, matterId: string, payload: unknown): Promise<void> {
  const res = await fetch(`${BASE}/rag/mirror?matter_id=${encodeURIComponent(matterId)}`, {
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
  const res = await fetch(`${BASE}/folders/${encodeURIComponent(folderId)}/documents`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await json<{ documents: Document[] }>(res);
  return data.documents;
}

export async function getDocumentPii(token: string, documentId: string): Promise<DocumentPiiEntity[]> {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(documentId)}/pii`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await json<{ pii: DocumentPiiEntity[] }>(res);
  return data.pii;
}
