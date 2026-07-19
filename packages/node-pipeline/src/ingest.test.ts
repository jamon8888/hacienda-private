// packages/node-pipeline/src/ingest.test.ts
import { describe, expect, it, vi } from "vitest";
import { hashBytes } from "./walk.js";
import { ingestFile } from "./ingest.js";
import type { Document, DocumentPiiEntity } from "@xberg-io/core";
import type { DocumentStore, MirrorSink } from "./ingest.js";

function makeFakeStore(): DocumentStore & { documents: Document[]; pii: Record<string, DocumentPiiEntity[]> } {
	const documents: Document[] = [];
	const pii: Record<string, DocumentPiiEntity[]> = {};
	return {
		documents,
		pii,
		findDocumentByHash: (folderId, contentHash) =>
			documents.find((d) => d.folder_id === folderId && d.content_hash === contentHash),
		createDocument: (input) => {
			const doc: Document = {
				id: `doc-${documents.length + 1}`,
				folder_id: input.folder_id,
				matter_id: input.matter_id,
				path: input.path,
				content_hash: input.content_hash,
				status: "processing",
				pages: 0,
				chunk_count: 0,
				pii_count: 0,
				ingested_via: input.ingested_via,
				created_at: new Date(0).toISOString(),
			};
			documents.push(doc);
			return doc;
		},
		updateDocumentStatus: (id, status, fields = {}) => {
			const doc = documents.find((d) => d.id === id);
			if (!doc) throw new Error(`unknown document ${id}`);
			doc.status = status;
			if (fields.pages !== undefined) doc.pages = fields.pages;
			if (fields.chunk_count !== undefined) doc.chunk_count = fields.chunk_count;
			if (fields.pii_count !== undefined) doc.pii_count = fields.pii_count;
			if (fields.error_message !== undefined) doc.error_message = fields.error_message;
		},
		insertPiiEntities: (documentId, entities) => {
			const inserted = entities.map((e, i) => ({
				id: `pii-${documentId}-${i}`,
				document_id: documentId,
				reviewed: false,
				...e,
			}));
			pii[documentId] = inserted;
			return inserted;
		},
		getDocumentsByFolder: (folderId) => documents.filter((d) => d.folder_id === folderId),
	};
}

function makeFakeMirror(): MirrorSink & { appended: { matterId: string; pii: unknown[]; chunks: unknown[] }[] } {
	const appended: { matterId: string; pii: unknown[]; chunks: unknown[] }[] = [];
	return {
		appended,
		appendMirror: (matterId, additions) => {
			appended.push({ matterId, pii: additions.pii, chunks: additions.chunks });
		},
	};
}

describe("ingestFile", () => {
	it("extracts, chunks, embeds, detects PII, and persists both outputs", async () => {
		const store = makeFakeStore();
		const mirror = makeFakeMirror();
		const extract = vi.fn().mockResolvedValue({ content: "Jane Doe works at Acme Corp.", pageCount: 1 });
		const chunk = vi.fn().mockReturnValue(["Jane Doe works at Acme Corp."]);
		const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
		const detectPii = vi.fn().mockResolvedValue([{ kind: "person", start: 0, end: 8, text: "Jane Doe" }]);

		const file = { path: "/tmp/a.txt", contentHash: hashBytes(Buffer.from("Jane Doe works at Acme Corp.")) };
		const doc = await ingestFile({ extract, chunk, embed, detectPii, store, mirror }, file, {
			folderId: "folder-1",
			matterId: "matter-1",
			ingestedVia: "mcp",
		});

		expect(doc.status).toBe("done");
		expect(doc.pages).toBe(1);
		expect(doc.chunk_count).toBe(1);
		expect(doc.pii_count).toBe(1);
		expect(store.pii[doc.id]).toHaveLength(1);
		expect(mirror.appended).toHaveLength(1);
		expect(mirror.appended[0]?.matterId).toBe("matter-1");
		expect(mirror.appended[0]?.chunks).toHaveLength(1);
		expect(embed).toHaveBeenCalledWith("Jane Doe works at Acme Corp.");
	});

	it("skips a file whose content hash was already ingested for the folder", async () => {
		const store = makeFakeStore();
		const mirror = makeFakeMirror();
		const file = { path: "/tmp/a.txt", contentHash: hashBytes(Buffer.from("duplicate content")) };
		const deps = {
			extract: vi.fn().mockResolvedValue({ content: "duplicate content", pageCount: 1 }),
			chunk: vi.fn().mockReturnValue(["duplicate content"]),
			embed: vi.fn().mockResolvedValue(new Array(768).fill(0)),
			detectPii: vi.fn().mockResolvedValue([]),
			store,
			mirror,
		};

		const first = await ingestFile(deps, file, { folderId: "folder-1", matterId: "matter-1", ingestedVia: "mcp" });
		const second = await ingestFile(deps, file, { folderId: "folder-1", matterId: "matter-1", ingestedVia: "mcp" });

		expect(second.id).toBe(first.id);
		expect(deps.extract).toHaveBeenCalledTimes(1);
	});

	it("records status='error' with a message when extraction throws, without persisting PII", async () => {
		const store = makeFakeStore();
		const mirror = makeFakeMirror();
		const file = { path: "/tmp/bad.pdf", contentHash: hashBytes(Buffer.from("not a real pdf")) };
		const deps = {
			extract: vi.fn().mockRejectedValue(new Error("corrupt PDF")),
			chunk: vi.fn(),
			embed: vi.fn(),
			detectPii: vi.fn(),
			store,
			mirror,
		};

		const doc = await ingestFile(deps, file, { folderId: "folder-1", matterId: "matter-1", ingestedVia: "mcp" });

		expect(doc.status).toBe("error");
		expect(doc.error_message).toBe("corrupt PDF");
		expect(store.pii[doc.id]).toBeUndefined();
		expect(mirror.appended).toHaveLength(0);
	});
});
