import { describe, it, expect, vi } from "vitest";
import { detectCapabilities } from "./capabilities";

describe("detectCapabilities", () => {
  it("returns conservative defaults when nothing is available", async () => {
    const profile = await detectCapabilities();
    expect(profile.webgpu).toBeTypeOf("boolean");
    expect(profile.wasmSimd).toBe(true);
    expect(profile.formFactor).toMatch(/desktop|mobile/);
  });

  it("detects WebGPU + vendor when adapter resolves", async () => {
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: async () => ({
          info: { vendor: "nvidia", architecture: "turing", isFallbackAdapter: false },
          limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
        }),
      },
      hardwareConcurrency: 8,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    });
    const profile = await detectCapabilities();
    expect(profile.webgpu).toBe(true);
    expect(profile.gpuVendor).toBe("nvidia");
    expect(profile.gpuArchitecture).toBe("turing");
    expect(profile.hardwareConcurrency).toBe(8);
  });

  it("reports webgpu: false when navigator.gpu exists but requestAdapter yields no adapter", async () => {
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: async () => null },
      hardwareConcurrency: 4,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    });
    const profile = await detectCapabilities();
    expect(profile.webgpu).toBe(false);
  });

  it("reports webgpu: false when navigator.gpu exists but requestAdapter throws", async () => {
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: async () => { throw new Error("backend not found"); } },
      hardwareConcurrency: 4,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    });
    const profile = await detectCapabilities();
    expect(profile.webgpu).toBe(false);
  });
});
