import { describe, it, expect, vi, beforeEach } from "vitest";
import { cachedFetchBuffer, cachedFetchJson, withScopedFetchOverride } from "./model-cache";

function fakeCacheStorage() {
	const store = new Map<string, Response>();
	return {
		open: async () => ({
			match: async (url: string) => store.get(url),
			put: async (url: string, res: Response) => {
				store.set(url, res);
			},
		}),
		store,
	};
}

describe("cachedFetchBuffer", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetches, reports progress, and caches on first call", async () => {
		const cache = fakeCacheStorage();
		vi.stubGlobal("caches", cache);
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			headers: { get: (k: string) => (k === "content-length" ? "4" : null) },
			body: {
				getReader: () => {
					let done = false;
					return {
						read: async () => {
							if (done) return { done: true, value: undefined };
							done = true;
							return { done: false, value: bytes };
						},
					};
				},
			},
			arrayBuffer: async () => bytes.buffer,
		}));
		vi.stubGlobal("fetch", fetchMock);

		const progressEvents: { bytesLoaded: number; bytesTotal: number }[] = [];
		const buf = await cachedFetchBuffer("https://example.test/model.onnx", (p) => progressEvents.push(p));

		expect(new Uint8Array(buf)).toEqual(bytes);
		expect(progressEvents).toEqual([{ bytesLoaded: 4, bytesTotal: 4 }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(cache.store.has("https://example.test/model.onnx")).toBe(true);
	});

	it("serves from cache on the second call without hitting fetch again", async () => {
		const cache = fakeCacheStorage();
		vi.stubGlobal("caches", cache);
		const bytes = new Uint8Array([9, 9]);
		cache.store.set("https://example.test/model.onnx", new Response(bytes.buffer));
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const buf = await cachedFetchBuffer("https://example.test/model.onnx");

		expect(new Uint8Array(buf)).toEqual(bytes);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("throws when the response is not ok", async () => {
		const cache = fakeCacheStorage();
		vi.stubGlobal("caches", cache);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null } })),
		);

		await expect(cachedFetchBuffer("https://example.test/missing.onnx")).rejects.toThrow(
			"failed to fetch https://example.test/missing.onnx: 404",
		);
	});

	it("still resolves with the fetched bytes when cache.put throws (e.g. QuotaExceededError)", async () => {
		const cache = fakeCacheStorage();
		cache.open = async () => ({
			match: async () => undefined,
			put: async () => {
				throw new Error("QuotaExceededError");
			},
		});
		vi.stubGlobal("caches", cache);
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			headers: { get: (k: string) => (k === "content-length" ? "4" : null) },
			body: {
				getReader: () => {
					let done = false;
					return {
						read: async () => {
							if (done) return { done: true, value: undefined };
							done = true;
							return { done: false, value: bytes };
						},
					};
				},
			},
			arrayBuffer: async () => bytes.buffer,
		}));
		vi.stubGlobal("fetch", fetchMock);

		const buf = await cachedFetchBuffer("https://example.test/model.onnx");

		expect(new Uint8Array(buf)).toEqual(bytes);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("cachedFetchJson", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetches and caches JSON", async () => {
		const cache = fakeCacheStorage();
		vi.stubGlobal("caches", cache);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			clone: () => ({ json: async () => ({ hello: "world" }) }),
			json: async () => ({ hello: "world" }),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const result = await cachedFetchJson("https://example.test/tokenizer.json");
		expect(result).toEqual({ hello: "world" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("still resolves with the fetched JSON when cache.put throws (e.g. QuotaExceededError)", async () => {
		const cache = fakeCacheStorage();
		cache.open = async () => ({
			match: async () => undefined,
			put: async () => {
				throw new Error("QuotaExceededError");
			},
		});
		vi.stubGlobal("caches", cache);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			clone: () => ({ json: async () => ({ hello: "world" }) }),
			json: async () => ({ hello: "world" }),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const result = await cachedFetchJson("https://example.test/tokenizer.json");

		expect(result).toEqual({ hello: "world" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("withScopedFetchOverride", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("serves the matched URL from the cached buffer and restores fetch afterward", async () => {
		const original = vi.fn(async () => new Response("untouched"));
		vi.stubGlobal("fetch", original);
		const bytes = new Uint8Array([5, 6, 7]).buffer;

		let seenDuringCall: typeof fetch | undefined;
		await withScopedFetchOverride("https://example.test/model.onnx", bytes, async () => {
			seenDuringCall = globalThis.fetch;
			const res = await globalThis.fetch("https://example.test/model.onnx");
			const buf = await res.arrayBuffer();
			expect(new Uint8Array(buf)).toEqual(new Uint8Array(bytes));
		});

		expect(seenDuringCall).not.toBe(original);
		expect(globalThis.fetch).toBe(original);
		expect(original).not.toHaveBeenCalled();
	});

	it("restores the original fetch even when fn throws", async () => {
		const original = vi.fn(async () => new Response("untouched"));
		vi.stubGlobal("fetch", original);

		await expect(
			withScopedFetchOverride("https://example.test/model.onnx", new ArrayBuffer(0), async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(globalThis.fetch).toBe(original);
	});

	it("passes through requests to other URLs unchanged", async () => {
		const original = vi.fn(async () => new Response("passthrough"));
		vi.stubGlobal("fetch", original);

		await withScopedFetchOverride("https://example.test/model.onnx", new ArrayBuffer(0), async () => {
			await globalThis.fetch("https://example.test/other.json");
		});

		expect(original).toHaveBeenCalledWith("https://example.test/other.json", undefined);
	});
});
