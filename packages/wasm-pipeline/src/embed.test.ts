import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./model-cache", () => ({
  cachedFetchBuffer: vi.fn(
    async (_url: string, onProgress?: (p: { bytesLoaded: number; bytesTotal: number }) => void) => {
      onProgress?.({ bytesLoaded: 10, bytesTotal: 10 });
      return new ArrayBuffer(10);
    },
  ),
  cachedFetchJson: vi.fn(async () => ({})),
}));

// embed.ts imports "onnxruntime-web/wasm" specifically (not the bare "onnxruntime-web" entry —
// see the Global Constraints note on why), so the mock must target that exact subpath.
vi.mock("onnxruntime-web/wasm", () => ({
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
