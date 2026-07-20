import type { BoundingBox } from "@xberg-io/core";

// Binary IndexedDB persistence layer (spec Section 2). EdgeVec's own
// save()/load() are unusable (load() throws a PostCard deserialization
// error in 0.9.0 -- see spike.test.ts), so we persist a compact,
// self-describing binary blob ourselves and rebuild the in-memory EdgeVec
// index once per session from it (never per query). No JSON, no
// localStorage: the dense block is packed Float32, not JSON.parse'd
// arrays-of-arrays.

const MAGIC = "EVP1";
const VERSION = 1;

export interface PersistedChunk {
	id: number;
	docId: string;
	chunkIndex: number;
	text: string;
	page?: number;
	citation?: string;
	bbox?: BoundingBox;
	vector: Float32Array;
	sparseIndices?: Uint32Array;
	sparseValues?: Float32Array;
}

export interface PersistedIndex {
	dim: number;
	sparseDim: number;
	chunks: PersistedChunk[];
}

class ByteWriter {
	private buf: Uint8Array;
	private view: DataView;
	private offset = 0;

	constructor(initialSize = 4096) {
		this.buf = new Uint8Array(initialSize);
		this.view = new DataView(this.buf.buffer);
	}

	private ensure(extra: number): void {
		if (this.offset + extra <= this.buf.length) return;
		let newSize = this.buf.length * 2;
		while (newSize < this.offset + extra) newSize *= 2;
		const next = new Uint8Array(newSize);
		next.set(this.buf.subarray(0, this.offset));
		this.buf = next;
		this.view = new DataView(this.buf.buffer);
	}

	u8(v: number): void {
		this.ensure(1);
		this.view.setUint8(this.offset, v);
		this.offset += 1;
	}

	u32(v: number): void {
		this.ensure(4);
		this.view.setUint32(this.offset, v, true);
		this.offset += 4;
	}

	i32(v: number): void {
		this.ensure(4);
		this.view.setInt32(this.offset, v, true);
		this.offset += 4;
	}

	f32(v: number): void {
		this.ensure(4);
		this.view.setFloat32(this.offset, v, true);
		this.offset += 4;
	}

	bytes(b: Uint8Array): void {
		this.ensure(b.length);
		this.buf.set(b, this.offset);
		this.offset += b.length;
	}

	str(s: string): void {
		const enc = new TextEncoder().encode(s);
		this.u32(enc.length);
		this.bytes(enc);
	}

	f32Array(arr: Float32Array): void {
		this.ensure(arr.length * 4);
		for (let i = 0; i < arr.length; i++) {
			this.view.setFloat32(this.offset, arr[i] ?? 0, true);
			this.offset += 4;
		}
	}

	u32Array(arr: Uint32Array): void {
		this.ensure(arr.length * 4);
		for (let i = 0; i < arr.length; i++) {
			this.view.setUint32(this.offset, arr[i] ?? 0, true);
			this.offset += 4;
		}
	}

	finish(): Uint8Array {
		return this.buf.slice(0, this.offset);
	}
}

class ByteReader {
	private view: DataView;
	private offset = 0;

	constructor(private buf: Uint8Array) {
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	u8(): number {
		const v = this.view.getUint8(this.offset);
		this.offset += 1;
		return v;
	}

	u32(): number {
		const v = this.view.getUint32(this.offset, true);
		this.offset += 4;
		return v;
	}

	i32(): number {
		const v = this.view.getInt32(this.offset, true);
		this.offset += 4;
		return v;
	}

	f32(): number {
		const v = this.view.getFloat32(this.offset, true);
		this.offset += 4;
		return v;
	}

	bytes(n: number): Uint8Array {
		const v = this.buf.subarray(this.offset, this.offset + n);
		this.offset += n;
		return v;
	}

	str(): string {
		const n = this.u32();
		return new TextDecoder().decode(this.bytes(n));
	}

	f32Array(n: number): Float32Array {
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = this.f32();
		return out;
	}

	u32Array(n: number): Uint32Array {
		const out = new Uint32Array(n);
		for (let i = 0; i < n; i++) out[i] = this.u32();
		return out;
	}
}

export function pack(index: PersistedIndex): Uint8Array {
	const w = new ByteWriter();
	w.bytes(new TextEncoder().encode(MAGIC));
	w.u32(VERSION);
	w.u32(index.dim);
	w.u32(index.sparseDim);
	w.u32(index.chunks.length);

	for (const chunk of index.chunks) {
		w.f32Array(chunk.vector);
	}

	for (const chunk of index.chunks) {
		w.u32(chunk.id);
		const hasSparse = !!chunk.sparseIndices && !!chunk.sparseValues && chunk.sparseIndices.length > 0;
		w.u8(hasSparse ? 1 : 0);
		if (hasSparse) {
			const indices = chunk.sparseIndices as Uint32Array;
			const values = chunk.sparseValues as Float32Array;
			w.u32(indices.length);
			w.u32Array(indices);
			w.f32Array(values);
		}
		w.str(chunk.docId);
		w.u32(chunk.chunkIndex);
		w.u8(chunk.page !== undefined ? 1 : 0);
		if (chunk.page !== undefined) w.i32(chunk.page);
		w.str(chunk.citation ?? "");
		w.str(chunk.text);
		w.u8(chunk.bbox ? 1 : 0);
		if (chunk.bbox) {
			w.f32(chunk.bbox.x);
			w.f32(chunk.bbox.y);
			w.f32(chunk.bbox.w);
			w.f32(chunk.bbox.h);
		}
	}

	return w.finish();
}

export function unpack(blob: Uint8Array): PersistedIndex {
	const r = new ByteReader(blob);
	const magic = new TextDecoder().decode(r.bytes(4));
	if (magic !== MAGIC) {
		throw new Error(`persist.ts: bad blob magic ${JSON.stringify(magic)}, expected ${JSON.stringify(MAGIC)}`);
	}
	const version = r.u32();
	if (version !== VERSION) {
		throw new Error(`persist.ts: unsupported blob version ${version}, expected ${VERSION}`);
	}
	const dim = r.u32();
	const sparseDim = r.u32();
	const nVectors = r.u32();

	const vectors: Float32Array[] = [];
	for (let i = 0; i < nVectors; i++) {
		vectors.push(r.f32Array(dim));
	}

	const chunks: PersistedChunk[] = [];
	for (let i = 0; i < nVectors; i++) {
		const id = r.u32();
		const hasSparse = r.u8() === 1;
		let sparseIndices: Uint32Array | undefined;
		let sparseValues: Float32Array | undefined;
		if (hasSparse) {
			const nTerms = r.u32();
			sparseIndices = r.u32Array(nTerms);
			sparseValues = r.f32Array(nTerms);
		}
		const docId = r.str();
		const chunkIndex = r.u32();
		const hasPage = r.u8() === 1;
		const page = hasPage ? r.i32() : undefined;
		const citationRaw = r.str();
		const citation = citationRaw.length > 0 ? citationRaw : undefined;
		const text = r.str();
		const hasBbox = r.u8() === 1;
		const bbox: BoundingBox | undefined = hasBbox ? { x: r.f32(), y: r.f32(), w: r.f32(), h: r.f32() } : undefined;

		const vector = vectors[i];
		if (!vector) throw new Error(`persist.ts: missing dense vector for row ${i}`);

		chunks.push({
			id,
			docId,
			chunkIndex,
			text,
			page,
			citation,
			bbox,
			vector,
			sparseIndices,
			sparseValues,
		});
	}

	return { dim, sparseDim, chunks };
}

const DB_NAME = "wasm-pipeline-search";
const STORE_NAME = "blobs";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	return dbPromise;
}

export async function writeBlob(matterId: string, blob: Uint8Array): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readwrite");
		tx.objectStore(STORE_NAME).put(blob, matterId);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function readBlob(matterId: string): Promise<Uint8Array | null> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readonly");
		const req = tx.objectStore(STORE_NAME).get(matterId);
		req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
		req.onerror = () => reject(req.error);
	});
}

export async function deleteBlob(matterId: string): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readwrite");
		tx.objectStore(STORE_NAME).delete(matterId);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
