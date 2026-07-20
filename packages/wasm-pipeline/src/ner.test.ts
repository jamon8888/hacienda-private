import { describe, it, expect, vi, beforeEach } from "vitest";

const inferenceMock = vi.fn();

vi.mock("gliner", () => ({
	Gliner: class {
		async initialize() {
			return undefined;
		}
		async inference(args: { texts: string[] }) {
			return inferenceMock(args);
		}
	},
}));

vi.mock("@xenova/transformers", () => ({
	env: { allowRemoteModels: true, allowLocalModels: true },
}));

const scenario: import("./scenario").ModelScenario = {
	executionProviders: ["wasm"],
	quant: "int8",
	numThreads: 1,
	chunkSize: 1024,
	deferPii: false,
	modelVariant: "e5-base",
};

describe("ner.ts batched PII detection", () => {
	beforeEach(() => {
		inferenceMock.mockReset();
		vi.resetModules();
	});

	it("detectPiiBatched calls model.inference exactly once for N batchable texts", async () => {
		inferenceMock.mockResolvedValue([
			[{ label: "person", start: 0, end: 8, spanText: "John Doe" }],
			[{ label: "organization", start: 0, end: 8, spanText: "Acme Co." }],
		]);
		const { detectPiiBatched } = await import("./ner");

		const out = await detectPiiBatched(
			["John Doe lives in Paris and works there", "Acme Co. headquarters is downtown"],
			undefined,
			scenario,
		);

		expect(inferenceMock).toHaveBeenCalledTimes(1);
		expect(out.length).toBe(2);
		expect(out[0]?.[0]?.text).toBe("John Doe");
		expect(out[1]?.[0]?.text).toBe("Acme Co.");
	});

	it("skips texts shorter than the batchable threshold without calling inference for them", async () => {
		inferenceMock.mockResolvedValue([[{ label: "person", start: 0, end: 8, spanText: "John Doe" }]]);
		const { detectPiiBatched } = await import("./ner");

		const out = await detectPiiBatched(["John Doe lives in Paris and works there", "short"], undefined, scenario);

		expect(inferenceMock).toHaveBeenCalledTimes(1);
		expect(inferenceMock.mock.calls[0]?.[0]?.texts).toEqual(["John Doe lives in Paris and works there"]);
		expect(out[0]?.[0]?.text).toBe("John Doe");
		expect(out[1]).toEqual([]);
	});

	it("all-short batch returns empty results without calling inference at all", async () => {
		const { detectPiiBatched } = await import("./ner");
		const out = await detectPiiBatched(["hi", "yo"], undefined, scenario);
		expect(inferenceMock).not.toHaveBeenCalled();
		expect(out).toEqual([[], []]);
	});

	it("detectPii (single-text) still scans short text -- no silent skip regression", async () => {
		inferenceMock.mockResolvedValue([[{ label: "person", start: 8, end: 14, spanText: "J. Doe" }]]);
		const { detectPii } = await import("./ner");

		const entities = await detectPii("Signed, J. Doe", undefined, scenario);

		expect(inferenceMock).toHaveBeenCalledTimes(1);
		expect(inferenceMock.mock.calls[0]?.[0]?.texts).toEqual(["Signed, J. Doe"]);
		expect(entities[0]?.text).toBe("J. Doe");
	});
});
