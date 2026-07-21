import { describe, it, expect, vi, beforeEach } from "vitest";

const initializeMock = vi.fn(async () => undefined);

vi.mock("gliner", () => ({
	// A real `function` (not an arrow) is required here: vitest 4's mock construction delegates to
	// the underlying implementation via `new`, and arrow functions are never constructible in JS.
	Gliner: vi.fn().mockImplementation(function () {
		return { initialize: initializeMock };
	}),
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
