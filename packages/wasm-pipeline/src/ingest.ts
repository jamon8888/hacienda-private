import type { Matter, Folder, PiiEntity } from "@xberg-io/core";
import { extractDocument, firstDocument } from "./runtime";
import { defaultExtractionConfig, withTesseractOcr } from "./ocr";
import { chunkExtraction, withChunking, chunkCitation, chunkPage, chunkBoundingBox } from "./chunk";
import { embedChunks } from "./embed";
import { detectPii, listPiiTypes } from "./ner";
import { buildIndex, serializeIndex, type IndexedChunk } from "./rag";
import { buildRedaction, sealVault, type RedactionEntry } from "./redact";
import { pushMirror, serializeMirrorToBytes } from "./mirror";
import { detectCapabilities } from "./capabilities";
import { selectScenario, type ModelScenario } from "./scenario";

function runPiiWhenIdle(text: string, piiTypes: readonly string[], scenario: ModelScenario): Promise<PiiEntity[]> {
	const run = () => detectPii(text, piiTypes, scenario);
	const w =
		typeof window !== "undefined"
			? (window as Window & { requestIdleCallback?: (cb: () => void) => number })
			: undefined;
	if (w?.requestIdleCallback) {
		const ric = w.requestIdleCallback;
		return new Promise<PiiEntity[]>((resolve) => {
			ric(() => {
				void run().then(resolve);
			});
		});
	}
	return new Promise<PiiEntity[]>((resolve) => {
		setTimeout(() => {
			void run().then(resolve);
		}, 0);
	});
}

export interface IngestOptions {
	passphrase: string;
	scopeToken: string;
	maxCharacters?: number;
	language?: string[];
}

export async function ingestFolder(
	matter: Matter,
	folder: Folder,
	file: File | Uint8Array,
	options: IngestOptions,
): Promise<{ accepted: number }> {
	const base = await defaultExtractionConfig();
	const ocrConfig = await withTesseractOcr(base, "tesseract", options.language);
	const profile = await detectCapabilities();
	const scenario = selectScenario(profile);
	const config = await withChunking(ocrConfig, {
		maxCharacters: options.maxCharacters ?? scenario.chunkSize,
		chunkerType: "markdown",
	});

	const result = await extractDocument(file, config);
	const doc = firstDocument(result);
	if (!doc) {
		return { accepted: 0 };
	}

	const piiTypes = listPiiTypes();
	const chunks = chunkExtraction(doc);
	const vectors = await embedChunks(
		chunks.map((c) => ({ text: c.content })),
	);

	const items: IndexedChunk[] = [];
	const allEntries: RedactionEntry[] = [];
	interface PiiTask {
		item: IndexedChunk;
		piiPromise: Promise<PiiEntity[]>;
		index: number;
	}
	const piiTasks: PiiTask[] = [];
	for (const [i, c] of chunks.entries()) {
		const v = vectors[i];
		if (!v) continue;
		const piiPromise = scenario.deferPii
			? runPiiWhenIdle(c.content, piiTypes, scenario)
			: detectPii(c.content, piiTypes, scenario);
		const entry: IndexedChunk = {
			docId: folder.id,
			chunkIndex: c.metadata.chunkIndex,
			text: c.content,
			page: chunkPage(c),
			citation: chunkCitation(folder.id, c),
			bbox: chunkBoundingBox(doc, c),
			vector: v,
		};
		items.push(entry);
		piiTasks.push({ item: entry, piiPromise, index: i });
	}

	await Promise.all(piiTasks.map((t) => t.piiPromise));
	for (const t of piiTasks) {
		const pii = await t.piiPromise;
		const { redacted, entries } = buildRedaction(t.item.text, pii, `C${t.index}`);
		for (const e of entries) allEntries.push(e);
		t.item.text = redacted;
	}

	const db = await buildIndex(matter.id, items);
	const indexBytes = await serializeIndex(db);
	const sealed = await sealVault(allEntries, options.passphrase);
	const payload = serializeMirrorToBytes(indexBytes, sealed.cipher, sealed.salt);
	await pushMirror(matter, payload, options.scopeToken);

	return { accepted: items.length };
}
