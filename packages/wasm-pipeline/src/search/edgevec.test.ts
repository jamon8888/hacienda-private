import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll } from "vitest";
import init from "edgevec";
import { EdgeVecSearchStore } from "./edgevec";

// Pre-warm edgevec's wasm singleton with raw bytes (Node's fetch doesn't
// support file:// URLs, which is what a bare init() resolves to under
// Node/vitest -- see spike.test.ts). EdgeVecSearchStore.open() calls plain
// init() (the browser-appropriate form); once the module-level wasm
// singleton is set, that call is a harmless no-op.
const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(require.resolve("edgevec/edgevec_bg.wasm"));

beforeAll(async () => {
	await init({ module_or_path: wasmBytes });
});

function fill(dim: number, value: number): Float32Array {
	return new Float32Array(Array(dim).fill(value));
}

// A uniform (all-identical-component) vector is a degenerate cosine input --
// with only a couple of elements in the HNSW graph, EdgeVec's ranking on
// such inputs is unstable (verified empirically: two uniform vectors ranked
// the geometrically "far" one first). Real e5 embeddings are never uniform
// and are always L2-normalized (see embed.ts); this produces a genuinely
// well-separated, unit-norm pair for the dense-only ranking test.
function wave(dim: number, seed: number): Float32Array {
	const raw = Float32Array.from({ length: dim }, (_, i) => Math.sin((i + 1) * seed));
	let sumSq = 0;
	for (const v of raw) sumSq += v * v;
	const norm = Math.sqrt(sumSq) || 1;
	return Float32Array.from(raw, (v) => v / norm);
}

describe("EdgeVecSearchStore", () => {
	it("ingest dense+sparse then hybrid query returns fused top-K", async () => {
		const s = new EdgeVecSearchStore();
		await s.open("m1");
		await s.ingest([
			{
				docId: "m1",
				chunkIndex: 0,
				text: "Acme Corp signed clause 9",
				page: 1,
				citation: "m1#c0",
				vector: fill(768, 0.1),
			},
			{
				docId: "m1",
				chunkIndex: 1,
				text: "unrelated cooking recipe",
				page: 2,
				citation: "m1#c1",
				vector: fill(768, -0.1),
			},
		]);

		const r = await s.query("m1", { vector: fill(768, 0.1), keyword: "Acme", topK: 2 });
		expect(r.length).toBeGreaterThan(0);
		expect(r[0]?.text).toContain("Acme");

		await s.close();
	});

	it("dense-only query (no keyword) still returns relevant results", async () => {
		const s = new EdgeVecSearchStore();
		await s.open("m2");
		await s.ingest([
			{ docId: "m2", chunkIndex: 0, text: "close to query", vector: wave(768, 0.05) },
			{ docId: "m2", chunkIndex: 1, text: "far from query", vector: wave(768, 1.7) },
		]);

		const r = await s.query("m2", { vector: wave(768, 0.05), keyword: "", topK: 1 });
		expect(r.length).toBe(1);
		expect(r[0]?.text).toBe("close to query");

		await s.close();
	});

	it("lowRam uses the BQ path and still resolves to indexed metadata", async () => {
		const s = new EdgeVecSearchStore();
		await s.open("m3");
		await s.ingest([
			{ docId: "m3", chunkIndex: 0, text: "bq target", vector: fill(768, 0.3) },
			{ docId: "m3", chunkIndex: 1, text: "bq other", vector: fill(768, -0.3) },
		]);

		const r = await s.query("m3", { vector: fill(768, 0.3), keyword: "", topK: 2, lowRam: true });
		expect(r.length).toBeGreaterThan(0);
		expect(r.every((c) => c.doc_id === "m3")).toBe(true);

		await s.close();
	});

	it("persist -> load round-trips a fresh store instance to the same query results", async () => {
		const writer = new EdgeVecSearchStore();
		await writer.open("m4");
		await writer.ingest([
			{
				docId: "m4",
				chunkIndex: 0,
				text: "Acme Corp signed clause 9",
				citation: "m4#c0",
				vector: fill(768, 0.1),
			},
			{
				docId: "m4",
				chunkIndex: 1,
				text: "unrelated cooking recipe",
				citation: "m4#c1",
				vector: fill(768, -0.1),
			},
		]);
		await writer.persist("m4");
		await writer.close();

		const reader = new EdgeVecSearchStore();
		const loaded = await reader.load("m4");
		expect(loaded).toBe(true);

		const r = await reader.query("m4", { vector: fill(768, 0.1), keyword: "Acme", topK: 2 });
		expect(r.length).toBeGreaterThan(0);
		expect(r[0]?.text).toContain("Acme");
		expect(r[0]?.citation).toBe("m4#c0");

		await reader.close();
	});

	it("forget deletes the persisted blob so a later load returns false", async () => {
		const writer = new EdgeVecSearchStore();
		await writer.open("m5");
		await writer.ingest([{ docId: "m5", chunkIndex: 0, text: "to be forgotten", vector: fill(768, 0.4) }]);
		await writer.persist("m5");
		await writer.forget("m5");

		const reader = new EdgeVecSearchStore();
		const loaded = await reader.load("m5");
		expect(loaded).toBe(false);
	});
});
