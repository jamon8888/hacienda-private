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
		warmupModelsMock.mockImplementation(
			(onProgress: (p: { stage: string; overall: number }) => void) => {
				onProgress({ stage: "gliner", overall: 0.5 });
				return Promise.reject(new Error("network down"));
			},
		);
		startModelWarmup();
		await vi.waitFor(() => expect(getModelWarmupSnapshot().stage).toBe("error"));
		expect(getModelWarmupSnapshot().error).toBe("network down");
		expect(getModelWarmupSnapshot().progress).toBe(0);

		warmupModelsMock.mockResolvedValueOnce(undefined);
		retryModelWarmup();
		await vi.waitFor(() => expect(getModelWarmupSnapshot().stage).toBe("ready"));
	});
});
