import { describe, it, expect, vi, beforeEach } from "vitest";

const createSessionSpy = vi.fn();

vi.mock("onnxruntime-web", () => {
	class Tensor {
		type: string;
		data: unknown;
		dims: number[];
		constructor(type: string, data: unknown, dims: number[]) {
			this.type = type;
			this.data = data;
			this.dims = dims;
		}
	}
	return {
		env: { wasm: {} as Record<string, unknown> },
		Tensor,
		InferenceSession: {
			create: (...args: unknown[]) => {
				createSessionSpy(...args);
				return Promise.resolve({
					run: async () => ({
						output: { data: new Float32Array(3 * 768).fill(1), dims: [1, 3, 768], type: "float32" },
					}),
					outputNames: ["output"],
					inputNames: ["input_ids", "attention_mask", "token_type_ids"],
				});
			},
		},
	};
});

vi.mock("@xenova/transformers", () => {
	function XLMRobertaTokenizer() {
		return (_text: string, _opts?: { return_tensor?: boolean }) => ({
			input_ids: [1, 2, 3],
			attention_mask: [1, 1, 1],
		});
	}
	return {
		env: { allowRemoteModels: true, allowLocalModels: true },
		XLMRobertaTokenizer,
	};
});

const scenario: import("./scenario").ModelScenario = {
	executionProviders: ["wasm"],
	quant: "int8",
	numThreads: 1,
	chunkSize: 1024,
	deferPii: false,
	modelVariant: "e5-base",
};

describe("embed.ts session + onnxruntime-web import caching", () => {
	beforeEach(() => {
		createSessionSpy.mockClear();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({}),
				arrayBuffer: async () => new ArrayBuffer(8),
			})),
		);
		vi.resetModules();
	});

	it("reuses one ORT session across chunks in a single embedChunks call", async () => {
		const { embedChunks } = await import("./embed");
		const v = await embedChunks([{ text: "a" }, { text: "b" }], scenario);
		expect(v.length).toBe(2);
		expect(v[0]?.length).toBe(768);
		// The historically redundant per-call `await import("onnxruntime-web")`
		// inside embedOne (embed.ts:118) didn't create a second session by
		// itself (Node/ESM already memoizes the module), but hoisting it via
		// getOrt() is what this test actually exercises: InferenceSession.create
		// is only reached through getSession()'s own sig-cached promise, and
		// this asserts that caching still holds with N>1 chunks sharing one call.
		expect(createSessionSpy).toHaveBeenCalledTimes(1);
	});

	it("reuses the session across separate embedQuery calls with the same scenario", async () => {
		const { embedQuery } = await import("./embed");
		await embedQuery("q1", scenario);
		await embedQuery("q2", scenario);
		expect(createSessionSpy).toHaveBeenCalledTimes(1);
	});
});
