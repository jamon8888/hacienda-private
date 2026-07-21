const CACHE_NAME = "xberg-models-v1";

export interface FetchProgress {
	bytesLoaded: number;
	bytesTotal: number;
}

async function readWithProgress(
	response: Response,
	onProgress?: (p: FetchProgress) => void,
): Promise<Uint8Array> {
	const total = Number(response.headers.get("content-length") ?? 0);
	const reader = response.body?.getReader();
	if (!reader) {
		const buf = new Uint8Array(await response.arrayBuffer());
		onProgress?.({ bytesLoaded: buf.byteLength, bytesTotal: total || buf.byteLength });
		return buf;
	}

	const chunks: Uint8Array[] = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			loaded += value.byteLength;
			onProgress?.({ bytesLoaded: loaded, bytesTotal: total || loaded });
		}
	}
	const out = new Uint8Array(loaded);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export async function cachedFetchBuffer(
	url: string,
	onProgress?: (p: FetchProgress) => void,
): Promise<ArrayBuffer> {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(url);
	if (cached) {
		const buf = new Uint8Array(await cached.arrayBuffer());
		onProgress?.({ bytesLoaded: buf.byteLength, bytesTotal: buf.byteLength });
		return buf.buffer;
	}

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`failed to fetch ${url}: ${response.status}`);
	}
	const bytes = await readWithProgress(response, onProgress);
	try {
		await cache.put(url, new Response(bytes.slice()));
	} catch {
		// Caching is best-effort: a full Cache Storage (e.g. Safari/iOS quota limits) must
		// never fail an otherwise-successful download.
	}
	return bytes.buffer;
}

export async function cachedFetchJson(url: string): Promise<unknown> {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(url);
	if (cached) return cached.json();

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`failed to fetch ${url}: ${response.status}`);
	}
	try {
		await cache.put(url, response.clone());
	} catch {
		// Caching is best-effort: a full Cache Storage (e.g. Safari/iOS quota limits) must
		// never fail an otherwise-successful fetch.
	}
	return response.json();
}

export async function withScopedFetchOverride<T>(
	matchUrl: string,
	cachedBuffer: ArrayBuffer,
	fn: () => Promise<T>,
): Promise<T> {
	const original: typeof fetch = globalThis.fetch;
	const scoped: typeof fetch = (input, init) => {
		const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (requestUrl === matchUrl) {
			return Promise.resolve(new Response(cachedBuffer.slice(0)));
		}
		return original(input, init);
	};
	globalThis.fetch = scoped;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}
