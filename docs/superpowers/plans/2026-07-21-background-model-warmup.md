# Background Model Warmup + Loading Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warm the E5 embedding model and GLiNER PII model in the background as soon as the app loads, show a status pill in the app shell, gate the one real model-dependent action that exists today (search), and cache all four fetched assets so this only takes real time on a genuine first visit.

**Architecture:** A new `warmup.ts` orchestrator in `packages/wasm-pipeline` reuses the existing lazy-init functions in `embed.ts` (E5) and `ner.ts` (GLiNER), adding byte-progress + caching to each, plus retry-with-backoff. A module-level singleton store in `apps/web` (`warmup-store.ts`) kicks this off exactly once per tab from `AppShell`, and a `useModelWarmup()` hook lets the status pill and the search page read `{stage, progress, error}` without prop drilling.

**Tech Stack:** TypeScript, Vitest, React 19 (`useSyncExternalStore`), `onnxruntime-web`, `gliner`, `@xenova/transformers`, Cache Storage API (browser), existing Base UI-derived `Badge`/`Button` components.

## Global Constraints

- Cache Storage bucket name is exactly `xberg-models-v1` (used for E5 model bytes, E5 tokenizer JSON, and the pre-fetched GLiNER model bytes).
- Retry policy is 3 attempts per model with backoff `1000 * 2^attempt` ms (1s / 2s / 4s), matching the approved design spec.
- `ner.ts`'s `transformersSettings.useBrowserCache` must be flipped from `false` to `true` (fixes the pre-existing every-session-redownload bug for the GLiNER tokenizer).
- No Web Worker or Service Worker — approved design spec explicitly rejected both as out of scope for this feature.
- **Testing scope correction:** the approved spec calls for a Playwright e2e smoke test. There is no `playwright.config.*` or any `*.spec.ts` file anywhere in `apps/web` today, despite `@playwright/test` being a devDependency — e2e infrastructure hasn't been set up in this repo yet. Standing up Playwright from scratch is out of scope for this plan; every task below instead gets a Vitest + Testing Library test at the store/component level (jsdom environment, per `apps/web/vitest.config.ts`), which covers the same "loading → ready → search enabled" behavior without inventing new test infrastructure. Standing up Playwright is a separate, infrastructure-level follow-up.
- **Scope correction found during planning:** the approved spec says "gate the ingest dropzone." Investigation of the current tree shows `apps/web/app/folders/[id]/FolderView.tsx` does not call `ingestFolder()` or render `FileDropzone` anywhere yet — it only has a plain text input that creates a folder by name (`file-dropzone.tsx` exists as a component but has zero consumers in the app today). That ingest wiring is Step 2 of the separately-reviewed `2026-07-20-web-ui-lawyer-enhancement-plan.md`, not yet built. This plan does **not** invent gating for a UI surface that doesn't exist; it delivers `useModelWarmup()` as the ready-made integration point, and gates the one model-dependent surface that **is** real today: `apps/web/app/search/page.tsx`'s call to `queryRag()`. Whoever implements Step 2 of the other plan should call `useModelWarmup()` in the new ingest UI the same way Task 8 here does in the search page.

---

### Task 1: Model caching + scoped-fetch-override utilities

**Files:**
- Create: `packages/wasm-pipeline/src/model-cache.ts`
- Test: `packages/wasm-pipeline/src/model-cache.test.ts`

**Interfaces:**
- Produces: `cachedFetchBuffer(url: string, onProgress?: (p: FetchProgress) => void): Promise<ArrayBuffer>`, `cachedFetchJson(url: string): Promise<unknown>`, `withScopedFetchOverride<T>(matchUrl: string, cachedBuffer: ArrayBuffer, fn: () => Promise<T>): Promise<T>`, and `export interface FetchProgress { bytesLoaded: number; bytesTotal: number }`. Tasks 2–4 import all three functions and the type from this file.

This package's Vitest tests run under the default **Node** environment (no `vitest.config.ts` in `packages/wasm-pipeline`, confirmed by the existing `capabilities.test.ts` which manually stubs `navigator` with `vi.stubGlobal`) — there is no real `fetch` or `caches` global, so every test must stub both explicitly.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/wasm-pipeline/src/model-cache.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @xberg-io/wasm-pipeline test -- model-cache`
Expected: FAIL with "Cannot find module './model-cache'" (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```ts
// packages/wasm-pipeline/src/model-cache.ts
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
	await cache.put(url, new Response(bytes.slice()));
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
	await cache.put(url, response.clone());
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xberg-io/wasm-pipeline test -- model-cache`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/wasm-pipeline/src/model-cache.ts packages/wasm-pipeline/src/model-cache.test.ts
git commit -m "feat(wasm-pipeline): add Cache Storage helpers and scoped fetch override for model warmup"
```

---

### Task 2: Wire caching + progress into the E5 embedding loader

**Files:**
- Modify: `packages/wasm-pipeline/src/embed.ts`
- Test: `packages/wasm-pipeline/src/embed.test.ts` (new)

**Interfaces:**
- Consumes: `cachedFetchBuffer`, `cachedFetchJson`, `FetchProgress` from `./model-cache` (Task 1).
- Produces: `ensureEmbedSession(scenario?: ModelScenario, onProgress?: (p: FetchProgress) => void): Promise<OrtSessionHandle>` (renamed + exported from the former private `getSession`) and `resetEmbedSession(): void`. Task 4 (`warmup.ts`) imports both.

- [ ] **Step 1: Write the failing test**

```ts
// packages/wasm-pipeline/src/embed.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./model-cache", () => ({
	cachedFetchBuffer: vi.fn(async (_url: string, onProgress?: (p: { bytesLoaded: number; bytesTotal: number }) => void) => {
		onProgress?.({ bytesLoaded: 10, bytesTotal: 10 });
		return new ArrayBuffer(10);
	}),
	cachedFetchJson: vi.fn(async () => ({})),
}));

vi.mock("onnxruntime-web", () => ({
	env: { wasm: { numThreads: 0 } },
	InferenceSession: { create: vi.fn(async () => ({ run: vi.fn(), outputNames: [], inputNames: [] })) },
}));

import { ensureEmbedSession, resetEmbedSession } from "./embed";
import { cachedFetchBuffer } from "./model-cache";
import type { ModelScenario } from "./scenario";

const scenario: ModelScenario = {
	executionProviders: ["wasm"],
	quant: "int8",
	numThreads: 2,
	chunkSize: 512,
	deferPii: false,
	modelVariant: "e5-base",
};

describe("ensureEmbedSession", () => {
	beforeEach(() => {
		resetEmbedSession();
		vi.clearAllMocks();
	});

	it("fetches the model once and reuses the session for the same scenario signature", async () => {
		const progressEvents: unknown[] = [];
		await ensureEmbedSession(scenario, (p) => progressEvents.push(p));
		await ensureEmbedSession(scenario);

		expect(cachedFetchBuffer).toHaveBeenCalledTimes(1);
		expect(progressEvents).toEqual([{ bytesLoaded: 10, bytesTotal: 10 }]);
	});

	it("re-fetches when the scenario signature changes", async () => {
		await ensureEmbedSession(scenario);
		await ensureEmbedSession({ ...scenario, quant: "int4" });

		expect(cachedFetchBuffer).toHaveBeenCalledTimes(2);
	});

	it("resetEmbedSession forces the next call to fetch again", async () => {
		await ensureEmbedSession(scenario);
		resetEmbedSession();
		await ensureEmbedSession(scenario);

		expect(cachedFetchBuffer).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/wasm-pipeline test -- embed`
Expected: FAIL — `ensureEmbedSession`/`resetEmbedSession` are not exported yet.

- [ ] **Step 3: Modify the implementation**

Replace the whole file with:

```ts
// packages/wasm-pipeline/src/embed.ts
import { cachedFetchBuffer, cachedFetchJson, type FetchProgress } from "./model-cache";
import { E5_TOKENIZER_URL, E5_TOKENIZER_CONFIG_URL, EMBED_DIM, e5ModelUrl } from "./constants";
import type { ModelScenario } from "./scenario";

export interface EmbeddableChunk {
	text: string;
}

const DEFAULT_SCENARIO: ModelScenario = {
	executionProviders: ["webgpu", "wasm"],
	quant: "int8",
	numThreads: 4,
	chunkSize: 1024,
	deferPii: false,
	modelVariant: "e5-base",
};

interface TokenizerOutput {
	input_ids: number[];
	attention_mask: number[];
	token_type_ids?: number[];
}

type CallableTokenizer = ((text: string, options?: { return_tensor?: boolean }) => TokenizerOutput) &
	Record<string, unknown>;

interface OrtTensor {
	data: Float32Array | BigInt64Array;
	dims: number[];
	type: string;
}

let cachedSig: string | null = null;
let sessionPromise: Promise<OrtSessionHandle> | null = null;
let tokenizerPromise: Promise<CallableTokenizer> | null = null;
let warnedDefaultScenario = false;

interface OrtSessionHandle {
	run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
	outputNames: string[];
	inputNames: string[];
}

type Prefix = "query" | "passage";

export function resetEmbedSession(): void {
	cachedSig = null;
	sessionPromise = null;
}

export async function ensureEmbedSession(
	scenario: ModelScenario = DEFAULT_SCENARIO,
	onProgress?: (p: FetchProgress) => void,
): Promise<OrtSessionHandle> {
	const sig = JSON.stringify({
		ep: scenario.executionProviders,
		quant: scenario.quant,
		variant: scenario.modelVariant,
		numThreads: scenario.numThreads,
	});
	if (!sessionPromise || sig !== cachedSig) {
		cachedSig = sig;
		sessionPromise = (async () => {
			const ort = await import("onnxruntime-web");
			ort.env.wasm.numThreads = scenario.numThreads;
			const buf = await cachedFetchBuffer(e5ModelUrl(scenario.modelVariant, scenario.quant), onProgress);
			const session = await ort.InferenceSession.create(buf, {
				executionProviders: scenario.executionProviders,
				graphOptimizationLevel: "all",
			});
			return session as unknown as OrtSessionHandle;
		})();
	}
	return sessionPromise;
}

// Local tokenizer loading (no Hugging Face egress).
//
// The Node service (Plan 1 `services/mcp-server`) serves the e5 tokenizer assets from
// its model cache at `${API_BASE}/models/e5.tokenizer.json` (+ companion `tokenizer_config.json`).
// We fetch those JSON files directly from the same Node origin that serves `e5.onnx`, then build
// the tokenizer in-process with `@xenova/transformers`' `XLMRobertaTokenizer` constructor.
// `multilingual-e5-base` is XLM-RoBERTa based, and its `tokenizer_config.json` declares
// `tokenizer_class: "XLMRobertaTokenizer"`, so we construct that class directly from the JSON —
// no `from_pretrained(repoId)` call, and therefore no runtime request to huggingface.co / hf.co.
// `env.allowRemoteModels` is forced off as a belt-and-suspenders guard so the library can never
// fall back to a remote HF fetch.
async function getTokenizer(): Promise<CallableTokenizer> {
	if (!tokenizerPromise) {
		tokenizerPromise = (async () => {
			const { env, XLMRobertaTokenizer } = await import("@xenova/transformers");
			env.allowRemoteModels = false;
			env.allowLocalModels = false;

			const [tokenizerJSON, tokenizerConfig] = await Promise.all([
				cachedFetchJson(E5_TOKENIZER_URL),
				cachedFetchJson(E5_TOKENIZER_CONFIG_URL),
			]);
			const tok = new XLMRobertaTokenizer(tokenizerJSON, tokenizerConfig);
			return tok as unknown as CallableTokenizer;
		})();
	}
	return tokenizerPromise;
}

async function embedOne(
	text: string,
	prefix: Prefix,
	scenario: ModelScenario = DEFAULT_SCENARIO,
): Promise<Float32Array> {
	const [session, tok] = await Promise.all([ensureEmbedSession(scenario), getTokenizer()]);
	const prefixed = prefix === "query" ? `query: ${text}` : `passage: ${text}`;
	const enc = tok(prefixed, { return_tensor: false });
	const inputIds = enc.input_ids;
	const attn = enc.attention_mask;
	const seqLen = inputIds.length;

	const ort = await import("onnxruntime-web");
	const ids = BigInt64Array.from(inputIds.map((x: number) => BigInt(x)));
	const mask = BigInt64Array.from(attn.map((x: number) => BigInt(x)));
	const types = new BigInt64Array(seqLen);
	const feeds: Record<string, OrtTensor> = {
		input_ids: new ort.Tensor("int64", ids, [1, seqLen]) as unknown as OrtTensor,
		attention_mask: new ort.Tensor("int64", mask, [1, seqLen]) as unknown as OrtTensor,
		token_type_ids: new ort.Tensor("int64", types, [1, seqLen]) as unknown as OrtTensor,
	};

	const out = await session.run(feeds);
	const values = Object.values(out);
	const outTensor = values[0];
	if (!outTensor) throw new Error("e5 session produced no output");
	const data = outTensor.data as Float32Array;
	const dims = outTensor.dims;
	const seq = dims[1] ?? seqLen;
	const hidden = EMBED_DIM;

	const vec = new Float32Array(hidden);
	let count = 0;
	for (let i = 0; i < seq; i++) {
		if (attn[i] === 1) {
			count++;
			for (let d = 0; d < hidden; d++) {
				vec[d] = (vec[d] ?? 0) + (data[i * hidden + d] ?? 0);
			}
		}
	}
	for (let d = 0; d < hidden; d++) {
		vec[d] = (vec[d] ?? 0) / Math.max(count, 1);
	}

	let norm = 0;
	for (let d = 0; d < hidden; d++) {
		norm += (vec[d] ?? 0) * (vec[d] ?? 0);
	}
	const denom = Math.sqrt(norm) || 1;
	for (let d = 0; d < hidden; d++) {
		vec[d] = (vec[d] ?? 0) / denom;
	}
	return vec;
}

// DEFAULT_SCENARIO is a defensive fallback; ingest.ts and query.ts now pass a real selectScenario() output.
export async function embedChunks(
	chunks: EmbeddableChunk[],
	scenario: ModelScenario = DEFAULT_SCENARIO,
): Promise<Float32Array[]> {
	if (scenario === DEFAULT_SCENARIO && !warnedDefaultScenario) {
		warnedDefaultScenario = true;
		console.warn(
			"[wasm-pipeline] embed called without a ModelScenario — using DEFAULT_SCENARIO; callers should pass selectScenario() output (see plan task 4-5)",
		);
	}
	return Promise.all(chunks.map((c) => embedOne(c.text, "passage", scenario)));
}

// DEFAULT_SCENARIO is a defensive fallback; ingest.ts and query.ts now pass a real selectScenario() output.
export async function embedQuery(text: string, scenario: ModelScenario = DEFAULT_SCENARIO): Promise<Float32Array> {
	if (scenario === DEFAULT_SCENARIO && !warnedDefaultScenario) {
		warnedDefaultScenario = true;
		console.warn(
			"[wasm-pipeline] embed called without a ModelScenario — using DEFAULT_SCENARIO; callers should pass selectScenario() output (see plan task 4-5)",
		);
	}
	return embedOne(text, "query", scenario);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xberg-io/wasm-pipeline test -- embed`
Expected: PASS, all 3 new tests green.

Run: `pnpm --filter @xberg-io/wasm-pipeline typecheck`
Expected: 0 errors (confirms `detectPii`/`ingest.ts`/`query.ts` callers of `embedChunks`/`embedQuery` are unaffected — their signatures didn't change).

- [ ] **Step 5: Commit**

```bash
git add packages/wasm-pipeline/src/embed.ts packages/wasm-pipeline/src/embed.test.ts
git commit -m "feat(wasm-pipeline): cache E5 model/tokenizer fetches and expose ensureEmbedSession for warmup"
```

---

### Task 3: Wire caching + progress into the GLiNER PII loader

**Files:**
- Modify: `packages/wasm-pipeline/src/ner.ts`
- Test: `packages/wasm-pipeline/src/ner.test.ts` (new)

**Interfaces:**
- Consumes: `cachedFetchBuffer`, `withScopedFetchOverride`, `FetchProgress` from `./model-cache` (Task 1).
- Produces: `ensurePiiModel(scenario: ModelScenario, onProgress?: (p: FetchProgress) => void): Promise<Gliner>` (renamed + exported from the former private `getModel`) and `resetPiiModel(): void`. Task 4 (`warmup.ts`) imports both. `detectPii`'s existing signature is unchanged — it now calls `ensurePiiModel` internally instead of the old private `getModel`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/wasm-pipeline/src/ner.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const initializeMock = vi.fn(async () => undefined);

vi.mock("gliner", () => ({
	Gliner: vi.fn().mockImplementation(() => ({ initialize: initializeMock })),
}));

vi.mock("@xenova/transformers", () => ({
	env: { allowRemoteModels: true },
}));

vi.mock("./model-cache", () => ({
	cachedFetchBuffer: vi.fn(async (_url: string, onProgress?: (p: { bytesLoaded: number; bytesTotal: number }) => void) => {
		onProgress?.({ bytesLoaded: 5, bytesTotal: 5 });
		return new ArrayBuffer(5);
	}),
	withScopedFetchOverride: vi.fn(async (_url: string, _buf: ArrayBuffer, fn: () => Promise<unknown>) => fn()),
}));

import { ensurePiiModel, resetPiiModel } from "./ner";
import { cachedFetchBuffer, withScopedFetchOverride } from "./model-cache";
import type { ModelScenario } from "./scenario";

const scenario: ModelScenario = {
	executionProviders: ["wasm"],
	quant: "int8",
	numThreads: 2,
	chunkSize: 512,
	deferPii: false,
	modelVariant: "e5-base",
};

describe("ensurePiiModel", () => {
	beforeEach(() => {
		resetPiiModel();
		vi.clearAllMocks();
	});

	it("pre-fetches the model bytes, initializes through the scoped override, and memoizes", async () => {
		const progressEvents: unknown[] = [];
		await ensurePiiModel(scenario, (p) => progressEvents.push(p));
		await ensurePiiModel(scenario);

		expect(cachedFetchBuffer).toHaveBeenCalledTimes(1);
		expect(withScopedFetchOverride).toHaveBeenCalledTimes(1);
		expect(initializeMock).toHaveBeenCalledTimes(1);
		expect(progressEvents).toEqual([{ bytesLoaded: 5, bytesTotal: 5 }]);
	});

	it("resetPiiModel forces the next call to re-initialize", async () => {
		await ensurePiiModel(scenario);
		resetPiiModel();
		await ensurePiiModel(scenario);

		expect(initializeMock).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/wasm-pipeline test -- ner`
Expected: FAIL — `ensurePiiModel`/`resetPiiModel` are not exported yet.

- [ ] **Step 3: Modify the implementation**

Replace the whole file with:

```ts
// packages/wasm-pipeline/src/ner.ts
import type { PiiEntity } from "@xberg-io/core";
import type { Gliner, IEntityResult, InitConfig, IONNXWebSettings, ITransformersSettings } from "gliner";
import { GLINER_TOKENIZER_URL, glinerModelUrl } from "./constants";
import { cachedFetchBuffer, withScopedFetchOverride, type FetchProgress } from "./model-cache";
import type { ModelScenario } from "./scenario";

// DEFAULT_SCENARIO is a defensive fallback; ingest.ts and query.ts now pass a real selectScenario() output.
const DEFAULT_SCENARIO: ModelScenario = {
	executionProviders: ["webgpu", "wasm"],
	quant: "int8",
	numThreads: 4,
	chunkSize: 1024,
	deferPii: false,
	modelVariant: "e5-base",
};
let warnedDefaultScenario = false;

// Remote-model guard: gliner's `initialize()` calls `AutoTokenizer.from_pretrained(tokenizerPath)`
// via `@xenova/transformers`. Turn off remote fetching up-front so it can never fall back to
// huggingface.co / hf.co. `env` only exists in the browser/Node transformers build; guard the import.
async function disableRemoteModels(): Promise<void> {
	try {
		const { env } = await import("@xenova/transformers");
		env.allowRemoteModels = false;
	} catch {
		// transformers runtime unavailable here (e.g. typecheck-only) — no-op.
	}
}

const PII_TYPES = ["person", "organization", "location", "email", "phone", "date", "ssn", "financial"] as const;

export function listPiiTypes(): readonly string[] {
	return PII_TYPES;
}

let cachedSig: string | null = null;
let modelPromise: Promise<Gliner> | null = null;

export function resetPiiModel(): void {
	cachedSig = null;
	modelPromise = null;
}

// Local tokenizer loading (no Hugging Face egress).
//
// gliner's `initialize()` calls `AutoTokenizer.from_pretrained(tokenizerPath)` internally via
// `@xenova/transformers`. We point `tokenizerPath` at the Node-served local tokenizer JSON
// (`${API_BASE}/models/gliner-tokenizer.json`) rather than an HF repo id, so no runtime request
// to huggingface.co / hf.co is made. We also disable remote model loading in transformers.js
// (`env.allowRemoteModels = false`) and tell gliner to only use local models, as belt-and-suspenders
// guards so the library can never fall back to a remote HF fetch. `useBrowserCache: true` lets
// transformers.js cache the tokenizer fetch itself (Cache Storage-backed) so it isn't re-downloaded
// every session.
//
// The GLiNER model binary is a separate story: gliner's `ONNXWebWrapper.init()` calls
// `ort.InferenceSession.create(modelPath, ...)` with a URL string, so `onnxruntime-web` does its
// own internal fetch that we can't observe or redirect. We pre-fetch the same URL ourselves via
// `cachedFetchBuffer` (for progress + Cache Storage), then run `model.initialize()` inside
// `withScopedFetchOverride` so the internal fetch is served from those same bytes instead of
// hitting the network a second time.
//
// NOTE (cross-plan dependency): this requires Plan 1's `services/mcp-server` ModelCache to serve a
// GLiNER tokenizer file at `/models/gliner-tokenizer.json` (standard transformers tokenizer.json
// layout). If the Node service serves it under a different name, update `GLINER_TOKENIZER_URL`.
export async function ensurePiiModel(
	scenario: ModelScenario,
	onProgress?: (p: FetchProgress) => void,
): Promise<Gliner> {
	const sig = JSON.stringify({
		quant: scenario.quant,
		ep: scenario.executionProviders[0],
	});
	if (!modelPromise || sig !== cachedSig) {
		cachedSig = sig;
		modelPromise = (async () => {
			const { Gliner: GlinerClass } = await import("gliner");
			await disableRemoteModels();
			const transformersSettings: ITransformersSettings = {
				allowLocalModels: true,
				useBrowserCache: true,
			};
			const modelUrl = glinerModelUrl(scenario.quant);
			const onnxSettings: IONNXWebSettings = {
				modelPath: modelUrl,
				executionProvider: scenario.executionProviders[0],
			};
			const config: InitConfig = {
				tokenizerPath: GLINER_TOKENIZER_URL,
				onnxSettings,
				transformersSettings,
			};
			const model = new GlinerClass(config);
			const modelBytes = await cachedFetchBuffer(modelUrl, onProgress);
			await withScopedFetchOverride(modelUrl, modelBytes, () => model.initialize());
			return model;
		})();
	}
	return modelPromise;
}

export async function detectPii(
	text: string,
	types: readonly string[] = PII_TYPES,
	scenario: ModelScenario = DEFAULT_SCENARIO,
): Promise<PiiEntity[]> {
	if (scenario === DEFAULT_SCENARIO && !warnedDefaultScenario) {
		warnedDefaultScenario = true;
		console.warn(
			"[wasm-pipeline] detectPii called without a ModelScenario — using DEFAULT_SCENARIO; callers should pass selectScenario() output (see plan task 4-5)",
		);
	}
	const model = await ensurePiiModel(scenario);
	const result = await model.inference({
		texts: [text],
		entities: [...types],
		flatNer: true,
		threshold: 0.5,
	});
	const ents = result[0] ?? [];
	return ents.map((e: IEntityResult) => ({
		kind: e.label,
		start: e.start,
		end: e.end,
		text: e.spanText,
	}));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xberg-io/wasm-pipeline test -- ner`
Expected: PASS, both new tests green.

Run: `pnpm --filter @xberg-io/wasm-pipeline typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/wasm-pipeline/src/ner.ts packages/wasm-pipeline/src/ner.test.ts
git commit -m "fix(wasm-pipeline): cache GLiNER model+tokenizer fetches and expose ensurePiiModel for warmup"
```

---

### Task 4: Warmup orchestrator with retry/backoff

**Files:**
- Modify: `packages/wasm-pipeline/src/runtime.ts`
- Create: `packages/wasm-pipeline/src/warmup.ts`
- Test: `packages/wasm-pipeline/src/warmup.test.ts`

**Interfaces:**
- Consumes: `initWasm` (existing) + new `resetWasm` from `./runtime`; `ensureEmbedSession`, `resetEmbedSession` from `./embed` (Task 2); `ensurePiiModel`, `resetPiiModel` from `./ner` (Task 3); `detectCapabilities` from `./capabilities`; `selectScenario`, `ModelScenario` from `./scenario`.
- Produces: `warmupModels(onProgress?: (p: WarmupProgress) => void): Promise<WarmupResult>`, `interface WarmupProgress { stage: "engine" | "e5" | "gliner"; overall: number }`, `interface WarmupResult { scenario: ModelScenario }`, `type WarmupStage = "engine" | "e5" | "gliner"`. Task 5 exports these from the package; Task 6 (`warmup-store.ts`) consumes `warmupModels` and `WarmupProgress`.

- [ ] **Step 1: Add `resetWasm` to runtime.ts**

In `packages/wasm-pipeline/src/runtime.ts`, add this function directly after `initWasm`:

```ts
export function resetWasm(): void {
	wasmMod = null;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/wasm-pipeline/src/warmup.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./capabilities", () => ({
	detectCapabilities: vi.fn(async () => ({
		webgpu: false,
		webgl: false,
		wasmSimd: true,
		hardwareConcurrency: 4,
		formFactor: "desktop",
		platform: "test",
	})),
}));

vi.mock("./scenario", () => ({
	selectScenario: vi.fn(() => ({
		executionProviders: ["wasm"],
		quant: "int8",
		numThreads: 4,
		chunkSize: 1024,
		deferPii: false,
		modelVariant: "e5-base",
	})),
}));

const initWasmMock = vi.fn(async () => undefined);
const resetWasmMock = vi.fn();
vi.mock("./runtime", () => ({
	initWasm: (...args: unknown[]) => initWasmMock(...args),
	resetWasm: (...args: unknown[]) => resetWasmMock(...args),
}));

const ensureEmbedSessionMock = vi.fn();
const resetEmbedSessionMock = vi.fn();
vi.mock("./embed", () => ({
	ensureEmbedSession: (...args: unknown[]) => ensureEmbedSessionMock(...args),
	resetEmbedSession: (...args: unknown[]) => resetEmbedSessionMock(...args),
}));

const ensurePiiModelMock = vi.fn();
const resetPiiModelMock = vi.fn();
vi.mock("./ner", () => ({
	ensurePiiModel: (...args: unknown[]) => ensurePiiModelMock(...args),
	resetPiiModel: (...args: unknown[]) => resetPiiModelMock(...args),
}));

import { warmupModels } from "./warmup";

describe("warmupModels", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("initializes the engine then both models in parallel, reporting weighted overall progress", async () => {
		ensureEmbedSessionMock.mockImplementation(async (_s, onProgress) => {
			onProgress?.({ bytesLoaded: 5, bytesTotal: 10 });
			onProgress?.({ bytesLoaded: 10, bytesTotal: 10 });
			return {};
		});
		ensurePiiModelMock.mockImplementation(async (_s, onProgress) => {
			onProgress?.({ bytesLoaded: 10, bytesTotal: 10 });
			return {};
		});

		const events: { stage: string; overall: number }[] = [];
		const result = await warmupModels((p) => events.push(p));

		expect(initWasmMock).toHaveBeenCalledTimes(1);
		expect(ensureEmbedSessionMock).toHaveBeenCalledTimes(1);
		expect(ensurePiiModelMock).toHaveBeenCalledTimes(1);
		expect(result.scenario.modelVariant).toBe("e5-base");

		expect(events[0]).toEqual({ stage: "engine", overall: 0.1 });
		const last = events[events.length - 1];
		expect(last.overall).toBeCloseTo(1, 5);
	});

	it("retries a failing model up to 3 times with backoff, resetting its memoized state each time", async () => {
		vi.useFakeTimers();
		ensureEmbedSessionMock
			.mockRejectedValueOnce(new Error("net down"))
			.mockRejectedValueOnce(new Error("net down"))
			.mockResolvedValueOnce({});
		ensurePiiModelMock.mockResolvedValue({});

		const promise = warmupModels();
		await vi.runAllTimersAsync();
		await promise;

		expect(ensureEmbedSessionMock).toHaveBeenCalledTimes(3);
		expect(resetEmbedSessionMock).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("throws after exhausting retries on both attempts", async () => {
		vi.useFakeTimers();
		ensureEmbedSessionMock.mockRejectedValue(new Error("permanent failure"));
		ensurePiiModelMock.mockResolvedValue({});

		const promise = warmupModels();
		const expectation = expect(promise).rejects.toThrow("permanent failure");
		await vi.runAllTimersAsync();
		await expectation;
		expect(ensureEmbedSessionMock).toHaveBeenCalledTimes(3);
		vi.useRealTimers();
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @xberg-io/wasm-pipeline test -- warmup`
Expected: FAIL with "Cannot find module './warmup'".

- [ ] **Step 4: Write the implementation**

```ts
// packages/wasm-pipeline/src/warmup.ts
import { detectCapabilities } from "./capabilities";
import { selectScenario, type ModelScenario } from "./scenario";
import { ensureEmbedSession, resetEmbedSession } from "./embed";
import { ensurePiiModel, resetPiiModel } from "./ner";
import { initWasm, resetWasm } from "./runtime";

export type WarmupStage = "engine" | "e5" | "gliner";

export interface WarmupProgress {
	stage: WarmupStage;
	overall: number;
}

export interface WarmupResult {
	scenario: ModelScenario;
}

const WEIGHTS: Record<WarmupStage, number> = { engine: 0.1, e5: 0.45, gliner: 0.45 };
const RETRY_ATTEMPTS = 3;

async function withRetry<T>(fn: () => Promise<T>, reset: () => void, attempts = RETRY_ATTEMPTS): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			reset();
			if (attempt < attempts - 1) {
				await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
			}
		}
	}
	throw lastErr;
}

export async function warmupModels(onProgress?: (p: WarmupProgress) => void): Promise<WarmupResult> {
	const fractions: Record<WarmupStage, number> = { engine: 0, e5: 0, gliner: 0 };
	const emit = (stage: WarmupStage) => {
		onProgress?.({
			stage,
			overall: fractions.engine * WEIGHTS.engine + fractions.e5 * WEIGHTS.e5 + fractions.gliner * WEIGHTS.gliner,
		});
	};

	const profile = await detectCapabilities();
	const scenario = selectScenario(profile);

	await withRetry(() => initWasm(), resetWasm);
	fractions.engine = 1;
	emit("engine");

	await Promise.all([
		withRetry(
			() =>
				ensureEmbedSession(scenario, (p) => {
					fractions.e5 = p.bytesTotal > 0 ? p.bytesLoaded / p.bytesTotal : 0;
					emit("e5");
				}),
			resetEmbedSession,
		),
		withRetry(
			() =>
				ensurePiiModel(scenario, (p) => {
					fractions.gliner = p.bytesTotal > 0 ? p.bytesLoaded / p.bytesTotal : 0;
					emit("gliner");
				}),
			resetPiiModel,
		),
	]);

	fractions.e5 = 1;
	fractions.gliner = 1;
	emit("gliner");

	return { scenario };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @xberg-io/wasm-pipeline test -- warmup`
Expected: PASS, all 3 tests green.

Run: `pnpm --filter @xberg-io/wasm-pipeline typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/wasm-pipeline/src/runtime.ts packages/wasm-pipeline/src/warmup.ts packages/wasm-pipeline/src/warmup.test.ts
git commit -m "feat(wasm-pipeline): add warmupModels orchestrator with per-model retry and weighted progress"
```

---

### Task 5: Export warmup from the package and thread it through the web app's adapter layer

**Files:**
- Modify: `packages/wasm-pipeline/src/index.ts`
- Modify: `apps/web/lib/engine/adapter.ts`
- Modify: `apps/web/lib/engine/index.ts`
- Modify: `apps/web/lib/engine/contract.test.ts`

**Interfaces:**
- Consumes: `warmupModels`, `WarmupProgress`, `WarmupResult`, `WarmupStage` from `./warmup` (Task 4).
- Produces: `warmupModels` importable from `@xberg-io/wasm-pipeline` (the alias apps/web code actually imports — see `apps/web/tsconfig.json:24-27` and `apps/web/vitest.config.ts:12`, which point that specifier at `apps/web/lib/engine/index.ts`, not the raw package). Task 6 imports `warmupModels` and `WarmupProgress` from `@xberg-io/wasm-pipeline`.

This task has no new runtime logic, so its "test" is the existing contract test plus a typecheck/build — this is a pure wiring task.

- [ ] **Step 1: Write the failing test**

Add this block to `apps/web/lib/engine/contract.test.ts` (inside the existing `describe`, after the `redactDocument` test):

```ts
  it("exposes warmupModels", () => {
    expect(typeof engine.warmupModels).toBe("function");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/web test -- contract`
Expected: FAIL — `engine.warmupModels` is `undefined`.

- [ ] **Step 3: Wire the export through all three files**

In `packages/wasm-pipeline/src/index.ts`, add this line after the existing `export { detectCapabilities, ... }` / `export { selectScenario, ... }` block:

```ts
export { warmupModels } from "./warmup";
export type { WarmupProgress, WarmupResult, WarmupStage } from "./warmup";
```

In `apps/web/lib/engine/adapter.ts`, add this line immediately after the big `import { ... } from "@xberg-io/wasm-pipeline-real";` block (after line 28 in the current file):

```ts
export { warmupModels } from "@xberg-io/wasm-pipeline-real";
export type { WarmupProgress, WarmupResult } from "@xberg-io/wasm-pipeline-real";
```

In `apps/web/lib/engine/index.ts`, replace the whole file with:

```ts
export {
  ingestFolder,
  extractDocumentForUi as extractDocument,
  queryRagForUi as queryRag,
  redactDocumentForUi as redactDocument,
  warmupModels,
  type ExtractedDocument,
  type IngestResult,
  type IngestProgress,
  type IngestContext,
  type WarmupProgress,
  type WarmupResult,
} from "./adapter";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xberg-io/web test -- contract`
Expected: PASS, all 5 contract tests green.

Run: `pnpm --filter @xberg-io/wasm-pipeline build && pnpm --filter @xberg-io/web typecheck`
Expected: both succeed with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/wasm-pipeline/src/index.ts apps/web/lib/engine/adapter.ts apps/web/lib/engine/index.ts apps/web/lib/engine/contract.test.ts
git commit -m "feat: export warmupModels through the wasm-pipeline package and web adapter layer"
```

---

### Task 6: Client-side warmup store + hook

**Files:**
- Create: `apps/web/lib/engine/warmup-store.ts`
- Test: `apps/web/lib/engine/warmup-store.test.ts`

**Interfaces:**
- Consumes: `warmupModels`, `WarmupProgress` from `@xberg-io/wasm-pipeline` (Task 5).
- Produces: `useModelWarmup(): WarmupState & { retry: () => void }`, `startModelWarmup(): void`, `retryModelWarmup(): void`, `type WarmupStage = "idle" | "loading" | "ready" | "error"`, `interface WarmupState { stage: WarmupStage; progress: number; error: string | null; attempt: number }`. Task 7 (`app-shell.tsx`, `model-warmup-status.tsx`) and Task 8 (`search/page.tsx`) import `useModelWarmup` and `startModelWarmup`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/engine/warmup-store.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warmupModelsMock = vi.fn();
vi.mock("@xberg-io/wasm-pipeline", () => ({
	warmupModels: (onProgress?: (p: { stage: string; overall: number }) => void) => warmupModelsMock(onProgress),
}));

import {
	__resetModelWarmupStoreForTests,
	getModelWarmupSnapshot,
	retryModelWarmup,
	startModelWarmup,
} from "./warmup-store";

beforeEach(() => {
	__resetModelWarmupStoreForTests();
	warmupModelsMock.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("warmup-store", () => {
	it("starts idle, moves to loading immediately, then ready once warmupModels resolves", async () => {
		let resolveWarmup: (() => void) | undefined;
		warmupModelsMock.mockImplementation(
			(onProgress: (p: { stage: string; overall: number }) => void) =>
				new Promise<void>((resolve) => {
					resolveWarmup = () => {
						onProgress({ stage: "gliner", overall: 1 });
						resolve();
					};
				}),
		);

		expect(getModelWarmupSnapshot().stage).toBe("idle");
		startModelWarmup();
		expect(getModelWarmupSnapshot().stage).toBe("loading");

		resolveWarmup?.();
		await vi.waitFor(() => expect(getModelWarmupSnapshot().stage).toBe("ready"));
		expect(getModelWarmupSnapshot().progress).toBe(1);
	});

	it("calls warmupModels exactly once even if startModelWarmup is called multiple times", () => {
		warmupModelsMock.mockResolvedValue(undefined);
		startModelWarmup();
		startModelWarmup();
		startModelWarmup();
		expect(warmupModelsMock).toHaveBeenCalledTimes(1);
	});

	it("moves to an error state when warmupModels rejects, and retry re-runs it", async () => {
		warmupModelsMock.mockRejectedValueOnce(new Error("network down"));
		startModelWarmup();
		await vi.waitFor(() => expect(getModelWarmupSnapshot().stage).toBe("error"));
		expect(getModelWarmupSnapshot().error).toBe("network down");

		warmupModelsMock.mockResolvedValueOnce(undefined);
		retryModelWarmup();
		await vi.waitFor(() => expect(getModelWarmupSnapshot().stage).toBe("ready"));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/web test -- warmup-store`
Expected: FAIL with "Cannot find module './warmup-store'".

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/engine/warmup-store.ts
"use client";

import { useSyncExternalStore } from "react";
import { warmupModels, type WarmupProgress } from "@xberg-io/wasm-pipeline";

export type WarmupStage = "idle" | "loading" | "ready" | "error";

export interface WarmupState {
	stage: WarmupStage;
	progress: number;
	error: string | null;
	attempt: number;
}

type Listener = () => void;

let state: WarmupState = { stage: "idle", progress: 0, error: null, attempt: 0 };
const listeners = new Set<Listener>();
let started = false;

function setState(next: Partial<WarmupState>): void {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

async function runWarmup(): Promise<void> {
	setState({ stage: "loading", progress: 0, error: null, attempt: state.attempt + 1 });
	try {
		await warmupModels((p: WarmupProgress) => setState({ progress: p.overall }));
		setState({ stage: "ready", progress: 1, error: null });
	} catch (err) {
		setState({ stage: "error", error: err instanceof Error ? err.message : "Failed to load on-device models" });
	}
}

export function startModelWarmup(): void {
	if (started) return;
	started = true;
	void runWarmup();
}

export function retryModelWarmup(): void {
	void runWarmup();
}

export function subscribeModelWarmup(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getModelWarmupSnapshot(): WarmupState {
	return state;
}

export function useModelWarmup(): WarmupState & { retry: () => void } {
	const snapshot = useSyncExternalStore(subscribeModelWarmup, getModelWarmupSnapshot, getModelWarmupSnapshot);
	return { ...snapshot, retry: retryModelWarmup };
}

export function __resetModelWarmupStoreForTests(): void {
	state = { stage: "idle", progress: 0, error: null, attempt: 0 };
	started = false;
	listeners.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xberg-io/web test -- warmup-store`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/engine/warmup-store.ts apps/web/lib/engine/warmup-store.test.ts
git commit -m "feat(web): add module-singleton model warmup store and useModelWarmup hook"
```

---

### Task 7: Status pill component + app-shell wiring

**Files:**
- Create: `apps/web/components/model-warmup-status.tsx`
- Test: `apps/web/components/model-warmup-status.test.tsx`
- Modify: `apps/web/components/app-shell.tsx`

**Interfaces:**
- Consumes: `useModelWarmup`, `startModelWarmup` from `@/lib/engine/warmup-store` (Task 6); existing `Badge` (`@/components/ui/badge`, variants `success`/`info`/`error` etc. — confirmed in `badge.tsx`) and `Button` (`@/components/ui/button`, `variant="ghost"`, `size="sm"` — confirmed in `button.tsx`).
- Produces: `<ModelWarmupStatus />` component, rendered in `AppShell`'s header next to the existing `<VaultStatus />`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/components/model-warmup-status.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const warmupState: { current: { stage: string; progress: number; error: string | null; retry: () => void } } = {
	current: { stage: "loading", progress: 0, error: null, retry: vi.fn() },
};

vi.mock("@/lib/engine/warmup-store", () => ({
	useModelWarmup: () => warmupState.current,
}));

import { ModelWarmupStatus } from "./model-warmup-status";

describe("ModelWarmupStatus", () => {
	it("shows a rounded percentage while preparing models", () => {
		warmupState.current = { stage: "loading", progress: 0.416, error: null, retry: vi.fn() };
		render(<ModelWarmupStatus />);
		expect(screen.getByText(/Preparing models… 42%/)).toBeInTheDocument();
	});

	it("shows a ready badge once models are ready", () => {
		warmupState.current = { stage: "ready", progress: 1, error: null, retry: vi.fn() };
		render(<ModelWarmupStatus />);
		expect(screen.getByText("Models ready")).toBeInTheDocument();
	});

	it("shows an error state whose button calls retry when clicked", async () => {
		const retry = vi.fn();
		warmupState.current = { stage: "error", progress: 0, error: "network down", retry };
		render(<ModelWarmupStatus />);
		const button = screen.getByRole("button", { name: /models unavailable/i });
		await userEvent.setup().click(button);
		expect(retry).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/web test -- model-warmup-status`
Expected: FAIL with "Cannot find module './model-warmup-status'".

- [ ] **Step 3: Write the component**

```tsx
// apps/web/components/model-warmup-status.tsx
"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert01Icon,
	ArrowReloadHorizontalIcon,
	CheckmarkCircle02Icon,
	Loading03Icon,
} from "@hugeicons/core-free-icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useModelWarmup } from "@/lib/engine/warmup-store";

export function ModelWarmupStatus() {
	const { stage, progress, error, retry } = useModelWarmup();

	if (stage === "ready") {
		return (
			<Badge variant="success" aria-label="On-device AI models ready">
				<HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-3" />
				Models ready
			</Badge>
		);
	}

	if (stage === "error") {
		return (
			<Button
				variant="ghost"
				size="sm"
				onClick={retry}
				className="h-auto gap-1 py-0.5 text-destructive hover:text-destructive"
				aria-label={`Model loading failed: ${error ?? "unknown error"} — retry`}
			>
				<HugeiconsIcon icon={Alert01Icon} className="size-3" />
				Models unavailable
				<HugeiconsIcon icon={ArrowReloadHorizontalIcon} className="size-3" />
			</Button>
		);
	}

	return (
		<Badge variant="info" aria-label={`Preparing on-device models: ${Math.round(progress * 100)}%`}>
			<HugeiconsIcon icon={Loading03Icon} className="size-3 animate-spin" />
			Preparing models… {Math.round(progress * 100)}%
		</Badge>
	);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xberg-io/web test -- model-warmup-status`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Wire the kickoff + pill into AppShell**

In `apps/web/components/app-shell.tsx`, add these two imports alongside the existing ones (after the `MatterNav, VaultStatus` import):

```tsx
import { ModelWarmupStatus } from "@/components/model-warmup-status";
import { startModelWarmup } from "@/lib/engine/warmup-store";
```

Add this effect alongside the other `useEffect` calls in `AppShell` (right after the `⌘K` keydown listener effect):

```tsx
	useEffect(() => {
		startModelWarmup();
	}, []);
```

Replace the header's status area:

```tsx
					<div className="ml-auto flex items-center gap-2">
						<VaultStatus locked={!auth?.passphrase} />
					</div>
```

with:

```tsx
					<div className="ml-auto flex items-center gap-2">
						<ModelWarmupStatus />
						<VaultStatus locked={!auth?.passphrase} />
					</div>
```

- [ ] **Step 6: Verify the whole app still builds**

Run: `pnpm --filter @xberg-io/web typecheck && pnpm --filter @xberg-io/web build`
Expected: both succeed with 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/model-warmup-status.tsx apps/web/components/model-warmup-status.test.tsx apps/web/components/app-shell.tsx
git commit -m "feat(web): add model warmup status pill and kick off warmup from AppShell"
```

---

### Task 8: Gate search on model readiness

**Files:**
- Modify: `apps/web/app/search/page.tsx`
- Test: `apps/web/app/search/page.test.tsx` (new)

**Interfaces:**
- Consumes: `useModelWarmup` from `@/lib/engine/warmup-store` (Task 6).
- Produces: exported `SearchPageInner` (newly named-exported, in addition to the existing default export) so the test can render it directly without a `<Suspense>` wrapper.

`app/search/page.tsx` today calls `queryRag(matter, query, 8)` directly from `@xberg-io/wasm-pipeline` on every search — this is the one real, already-wired model-dependent user action in the app today (confirmed: `FolderView.tsx`'s ingest path doesn't call any embedding/PII function yet, see the Global Constraints scope note above).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/app/search/page.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams("matter_id=m1"),
}));

vi.mock("@/lib/auth", () => ({
	useAuth: () => ({ ensureAuth: () => ({ token: "t1" }) }),
}));

vi.mock("@/lib/api", () => ({
	getMatters: async () => [{ id: "m1", name: "Matter One" }],
}));

vi.mock("@xberg-io/wasm-pipeline", () => ({
	queryRag: vi.fn(),
}));

const warmupState: { current: { stage: string } } = { current: { stage: "loading" } };
vi.mock("@/lib/engine/warmup-store", () => ({
	useModelWarmup: () => warmupState.current,
}));

import { SearchPageInner } from "./page";

describe("SearchPageInner", () => {
	it("disables search and labels the button while models are loading", async () => {
		warmupState.current = { stage: "loading" };
		render(<SearchPageInner />);
		const button = await screen.findByRole("button", { name: /preparing models/i });
		expect(button).toBeDisabled();
	});

	it("enables search once models are ready", async () => {
		warmupState.current = { stage: "ready" };
		render(<SearchPageInner />);
		const button = await screen.findByRole("button", { name: "Search" });
		expect(button).not.toBeDisabled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/web test -- app/search/page`
Expected: FAIL — `SearchPageInner` is not exported yet.

- [ ] **Step 3: Modify the implementation**

Replace the whole file with:

```tsx
// apps/web/app/search/page.tsx
"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RetrievedChunkCard } from "@/components/RetrievedChunkCard";
import { useAuth } from "@/lib/auth";
import { getMatters } from "@/lib/api";
import { useModelWarmup } from "@/lib/engine/warmup-store";
import { queryRag } from "@xberg-io/wasm-pipeline";
import type { Matter, RetrievedChunk } from "@xberg-io/core";

export function SearchPageInner() {
  const searchParams = useSearchParams();
  const matterId = searchParams.get("matter_id") ?? searchParams.get("folder_id") ?? "";
  const { ensureAuth } = useAuth();
  const { stage: modelStage } = useModelWarmup();
  const [matter, setMatter] = useState<Matter | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RetrievedChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!matterId) return;
    const auth = ensureAuth();
    void (async () => {
      const matters = await getMatters(auth.token);
      setMatter(matters.find((m) => m.id === matterId) ?? null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId]);

  const search = async () => {
    if (!query.trim() || !matter) return;
    if (modelStage !== "ready") {
      setError("On-device AI models are still loading — try again in a moment.");
      return;
    }
    ensureAuth();
    setLoading(true);
    setError(null);
    try {
      const chunks = await queryRag(matter, query.trim(), 8);
      setResults(chunks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">RAG Search</h1>
      <div className="mb-6 flex gap-2">
        <Input
          placeholder="Ask a question about your documents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <Button onClick={search} disabled={loading || !query.trim() || !matter || modelStage !== "ready"}>
          {loading ? "Searching…" : modelStage !== "ready" ? "Preparing models…" : "Search"}
        </Button>
      </div>
      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
      <div className="grid gap-3">
        {results.map((c, i) => (
          <RetrievedChunkCard key={i} chunk={c} />
        ))}
        {results.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground">
            No results. Try a different query or ensure the matter has been processed.
          </p>
        )}
      </div>
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl p-6">Loading…</main>}>
      <SearchPageInner />
    </Suspense>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xberg-io/web test -- app/search/page`
Expected: PASS, both tests green.

Run: `pnpm --filter @xberg-io/web typecheck && pnpm --filter @xberg-io/web build`
Expected: both succeed with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/search/page.tsx apps/web/app/search/page.test.tsx
git commit -m "feat(web): gate search on model warmup readiness"
```

---

## Follow-up (explicitly out of scope for this plan)

- Wiring `FileDropzone` → `ingestFolder()` into `FolderView.tsx` (Step 2 of `2026-07-20-web-ui-lawyer-enhancement-plan.md`) — once that lands, it should call `useModelWarmup()` from `@/lib/engine/warmup-store` the same way Task 8 does, and disable the dropzone while `stage !== "ready"`.
- Backend `Cache-Control` header tuning on the Node model-cache service's `/models/*` routes — not required by this plan (the scoped-fetch-override makes GLiNER model caching independent of server headers), but would further speed up cold CDN-level fetches.
