const CACHE_NAME = "xberg-models-v1";

export interface FetchProgress {
  bytesLoaded: number;
  bytesTotal: number;
}

async function readWithProgress(response: Response, onProgress?: (p: FetchProgress) => void): Promise<Uint8Array> {
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

// The Cache Storage API is absent (older runtimes, some Node builds) or throws a SecurityError
// when accessed in an insecure context or certain private-browsing modes. Opening it must never
// crash warmup, so probe it defensively and fall back to plain network fetches when unavailable.
async function openCache(): Promise<Cache | undefined> {
  try {
    if (typeof caches === "undefined") return undefined;
    return await caches.open(CACHE_NAME);
  } catch {
    return undefined;
  }
}

export async function cachedFetchBuffer(url: string, onProgress?: (p: FetchProgress) => void): Promise<ArrayBuffer> {
  const cache = await openCache();
  let cached: Response | undefined;
  try {
    cached = await cache?.match(url);
  } catch {
    // Reading from cache is best-effort: a corrupt/unavailable Cache Storage entry
    // must never fail an otherwise-successful fetch.
  }
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
    await cache?.put(url, new Response(bytes.slice()));
  } catch {
    // Caching is best-effort: a full Cache Storage (e.g. Safari/iOS quota limits) must
    // never fail an otherwise-successful download.
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function cachedFetchJson(url: string): Promise<unknown> {
  const cache = await openCache();
  let cached: Response | undefined;
  try {
    cached = await cache?.match(url);
  } catch {
    // Reading from cache is best-effort: a corrupt/unavailable Cache Storage entry
    // must never fail an otherwise-successful fetch.
  }
  if (cached) return cached.json();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: ${response.status}`);
  }
  try {
    await cache?.put(url, response.clone());
  } catch {
    // Caching is best-effort: a full Cache Storage (e.g. Safari/iOS quota limits) must
    // never fail an otherwise-successful fetch.
  }
  return response.json();
}

// A single persistent interceptor backed by a reference-counted registry of active URL overrides.
// Swapping `globalThis.fetch` per call and restoring it in a `finally` races when two scopes overlap:
// the second call captures the first's scoped fetch as its "original", so restoring in either order
// can permanently leave a scoped closure installed and break the network layer. Installing one
// interceptor and routing through the registry lets concurrent scopes coexist safely; the original
// fetch is only restored once the last active override drains.
const fetchOverrides = new Map<string, { buffer: ArrayBuffer; refs: number }>();
let originalFetch: typeof fetch | null = null;

export async function withScopedFetchOverride<T>(
  matchUrl: string,
  cachedBuffer: ArrayBuffer,
  fn: () => Promise<T>,
): Promise<T> {
  if (!originalFetch) {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const override = fetchOverrides.get(requestUrl);
      if (override) {
        return Promise.resolve(new Response(override.buffer.slice(0)));
      }
      return originalFetch!(input, init);
    };
  }

  const existing = fetchOverrides.get(matchUrl);
  if (existing) {
    existing.refs++;
  } else {
    fetchOverrides.set(matchUrl, { buffer: cachedBuffer, refs: 1 });
  }

  try {
    return await fn();
  } finally {
    const current = fetchOverrides.get(matchUrl);
    if (current && --current.refs === 0) {
      fetchOverrides.delete(matchUrl);
    }
    if (fetchOverrides.size === 0 && originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
  }
}
