import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll } from "vitest";
import init from "edgevec";
import { buildIndex, retrieve, serializeIndex, type IndexedChunk } from "./rag";

const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(require.resolve("edgevec/edgevec_bg.wasm"));

beforeAll(async () => {
	await init({ module_or_path: wasmBytes });
});

function fill(dim: number, value: number): Float32Array {
	return new Float32Array(Array(dim).fill(value));
}

describe("rag.ts orchestration (SearchStore wiring)", () => {
	it("buildIndex -> retrieve returns the ingested chunk via hybrid search", async () => {
		const items: IndexedChunk[] = [
			{
				docId: "m1",
				chunkIndex: 0,
				text: "Acme Corp signed clause 9",
				citation: "m1#c0",
				vector: fill(768, 0.1),
			},
			{
				docId: "m1",
				chunkIndex: 1,
				text: "unrelated cooking recipe",
				citation: "m1#c1",
				vector: fill(768, -0.1),
			},
		];
		await buildIndex("m1", items);

		const hits = await retrieve("m1", fill(768, 0.1), 4, "Acme Corp");
		expect(hits.some((h) => h.text.includes("Acme"))).toBe(true);
	});

	it("serializeIndex exports non-empty save_stream bytes for the just-ingested matter", async () => {
		const items: IndexedChunk[] = [{ docId: "m2", chunkIndex: 0, text: "hello world", vector: fill(768, 0.2) }];
		await buildIndex("m2", items);

		const bytes = await serializeIndex("m2");
		expect(bytes.length).toBeGreaterThan(0);
	});

	it("serializeIndex rejects a matter that isn't the currently open one", async () => {
		const items: IndexedChunk[] = [{ docId: "m2b", chunkIndex: 0, text: "hello world", vector: fill(768, 0.2) }];
		await buildIndex("m2b", items);

		await expect(serializeIndex("some-other-matter")).rejects.toThrow(/the open matter is/);
	});

	it("switching to a different matter and back reloads the first one from its persisted blob", async () => {
		const itemsA: IndexedChunk[] = [
			{ docId: "m3", chunkIndex: 0, text: "Acme Corp document A", citation: "m3#c0", vector: fill(768, 0.3) },
		];
		await buildIndex("m3", itemsA);

		const itemsB: IndexedChunk[] = [
			{ docId: "m4", chunkIndex: 0, text: "different matter B", vector: fill(768, 0.4) },
		];
		// Switches the shared store's in-memory index to matter m4 -- m3 is only
		// reachable again via its persisted IndexedDB blob (persist.ts), not
		// in-memory state.
		await buildIndex("m4", itemsB);

		const hits = await retrieve("m3", fill(768, 0.3), 2, "Acme");
		expect(hits.some((h) => h.text.includes("Acme"))).toBe(true);
		expect(hits.every((h) => h.doc_id === "m3")).toBe(true);
	});
});
