import type { RetrievedChunk } from "@xberg-io/core";
import { EdgeVecSearchStore } from "./search/edgevec";
import type { IndexedChunk } from "./search/store";

export type { IndexedChunk } from "./search/store";

// A single shared EdgeVecSearchStore for the browser tab session. EdgeVec's
// own save()/load() are broken in 0.9.0 (see search/spike.test.ts), so
// persistence goes through search/persist.ts's binary IndexedDB blob instead;
// the in-memory index is rebuilt from that blob once per matter switch, never
// per query -- that per-query rebuild was the dominant latency in the prior
// design.
let sharedStore: EdgeVecSearchStore | null = null;
let openMatterId: string | null = null;

function getStore(): EdgeVecSearchStore {
	if (!sharedStore) sharedStore = new EdgeVecSearchStore();
	return sharedStore;
}

async function ensureOpenForIngest(matterId: string): Promise<EdgeVecSearchStore> {
	const store = getStore();
	if (openMatterId !== matterId) {
		await store.open(matterId);
		openMatterId = matterId;
	}
	return store;
}

async function ensureOpenForQuery(matterId: string): Promise<EdgeVecSearchStore> {
	const store = getStore();
	if (openMatterId !== matterId) {
		const loaded = await store.load(matterId);
		if (!loaded) await store.open(matterId);
		openMatterId = matterId;
	}
	return store;
}

export async function buildIndex(matterId: string, items: IndexedChunk[]): Promise<void> {
	const store = await ensureOpenForIngest(matterId);
	await store.ingest(items);
	await store.persist(matterId);
}

export async function retrieve(
	matterId: string,
	queryVec: number[] | Float32Array,
	topK: number,
	keyword = "",
): Promise<RetrievedChunk[]> {
	const store = await ensureOpenForQuery(matterId);
	const vec = queryVec instanceof Float32Array ? queryVec : new Float32Array(queryVec);
	return store.query(matterId, { vector: vec, keyword, topK });
}

/**
 * Exports the currently-open matter's EdgeVec index as save_stream() bytes,
 * for the /api/rag/mirror upload. Only valid immediately after buildIndex()
 * for the same matterId -- unaffected by EdgeVec's broken load(): save_stream
 * is a write-only export the Node MirrorStore reopens independently
 * (Task 8), not something this process ever tries to load back.
 */
export async function serializeIndex(matterId: string): Promise<Uint8Array> {
	const store = getStore();
	if (store.getOpenMatterId() !== matterId) {
		throw new Error(
			`rag.ts: serializeIndex called for matter ${matterId}, but the open matter is ${store.getOpenMatterId()}`,
		);
	}
	const db = store.getRawDb();
	if (!db) throw new Error(`rag.ts: serializeIndex called for matter ${matterId} but no EdgeVec index is open`);

	const iter = db.save_stream();
	const parts: Uint8Array[] = [];
	let chunk = iter.next_chunk();
	while (chunk) {
		parts.push(chunk);
		chunk = iter.next_chunk();
	}
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}
