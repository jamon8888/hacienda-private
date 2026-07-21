import { get, set, del } from "idb-keyval";
import type { PiiEntity } from "@xberg-io/core";
import type { DocumentSplit } from "@/components/ui/document-splits";

// Client-only cache of the original file bytes + ingest results, keyed by the server-assigned
// Document id. Nothing here ever leaves the browser: the server only ever sees the mirror bundle
// pushed via pushMirror (redacted text + sealed vault), never the raw file or plaintext PII. The
// server's own /api/documents/:id/pii route serves a *different*, consent-gated plaintext store
// populated only by the separate MCP/server ingestion path — it has no rows for browser-ingested
// documents, so this document's PII list has to come from here instead.
export interface StoredDocument {
	file: Blob;
	fileName: string;
	mimeType: string;
	// Tokenized PII spans from IngestResult.pii (kind/start/end + token, never plaintext).
	pii: PiiEntity[];
	// Raw mirror payload bytes from IngestResult.mirror — needed by rehydrateSpanForUi to
	// re-derive the vault key and decrypt a PII span on this document.
	mirror?: Uint8Array;
	// Human-review corrections keyed by the same stable id used in PiiReviewPanel (kind-start-end).
	// Confirming/correcting/rejecting a span doesn't rebuild the mirror or vault — only the
	// reviewer's expected value is recorded locally, alongside the original detection.
	reviewedPii?: Record<string, { expected: string | null }>;
	// User-defined page groupings for large filings — segments become selectable review units.
	splits?: DocumentSplit[];
}

function keyFor(docId: string): string {
	return `xberg:doc:${docId}`;
}

export async function saveOriginalFile(
	docId: string,
	file: File,
	pii: PiiEntity[],
	mirror?: Uint8Array,
): Promise<void> {
	const stored: StoredDocument = { file, fileName: file.name, mimeType: file.type, pii, mirror };
	await set(keyFor(docId), stored);
}

export async function getOriginalFile(docId: string): Promise<StoredDocument | undefined> {
	return get(keyFor(docId));
}

export async function saveReviewedPii(
	docId: string,
	reviewedPii: Record<string, { expected: string | null }>,
): Promise<void> {
	const existing = await get<StoredDocument>(keyFor(docId));
	if (!existing) return;
	await set(keyFor(docId), { ...existing, reviewedPii });
}

export async function saveSplits(docId: string, splits: DocumentSplit[]): Promise<void> {
	const existing = await get<StoredDocument>(keyFor(docId));
	if (!existing) return;
	await set(keyFor(docId), { ...existing, splits });
}

export async function deleteOriginalFile(docId: string): Promise<void> {
	await del(keyFor(docId));
}

export async function deleteOriginalFiles(docIds: string[]): Promise<void> {
	await Promise.all(docIds.map((id) => deleteOriginalFile(id)));
}
