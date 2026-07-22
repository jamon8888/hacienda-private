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
  initWasm: () => initWasmMock(),
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
    const last = events[events.length - 1]!;
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
