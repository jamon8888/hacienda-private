import { describe, it, expect } from "vitest";
import { selectScenario } from "./scenario";
import type { DeviceProfile } from "./capabilities";

function profile(over: Partial<DeviceProfile>): DeviceProfile {
  return {
    webgpu: false,
    webgl: false,
    wasmSimd: true,
    hardwareConcurrency: 4,
    formFactor: "desktop",
    platform: "unknown",
    ...over,
  } as DeviceProfile;
}

describe("selectScenario", () => {
  it("picks WebGPU + INT8 on a discrete GPU laptop", () => {
    const s = selectScenario(
      profile({
        webgpu: true,
        webgl: true,
        gpuVendor: "nvidia",
        gpuArchitecture: "turing",
        gpuMaxBufferBytes: 256 * 1024 * 1024,
        hardwareConcurrency: 8,
        deviceMemoryGb: 16,
      }),
    );
    expect(s.executionProviders).toEqual(["webgpu", "webgl", "wasm"]);
    expect(s.quant).toBe("int8");
    expect(s.numThreads).toBe(8);
  });

  it("picks WASM-only + INT4 on a low-RAM 4-thread laptop", () => {
    const s = selectScenario(profile({ webgpu: false, webgl: false, hardwareConcurrency: 4, deviceMemoryGb: 4 }));
    expect(s.executionProviders).toEqual(["wasm"]);
    expect(s.quant).toBe("int4");
    expect(s.deferPii).toBe(true);
    expect(s.chunkSize).toBeLessThanOrEqual(512);
  });

  it("picks INT4 + mobile knobs on a phone", () => {
    const s = selectScenario(
      profile({ webgpu: true, formFactor: "mobile", hardwareConcurrency: 6, deviceMemoryGb: 6 }),
    );
    expect(s.quant).toBe("int4");
    expect(s.chunkSize).toBeLessThanOrEqual(384);
  });

  it("falls back to conservative defaults when GPU info is masked", () => {
    const s = selectScenario(
      profile({
        webgpu: true,
        gpuVendor: "",
        gpuArchitecture: "",
        gpuMaxBufferBytes: undefined,
        hardwareConcurrency: 4,
      }),
    );
    expect(s.quant).toBe("int4");
    expect(s.executionProviders[0]).toBe("webgpu");
  });
});
