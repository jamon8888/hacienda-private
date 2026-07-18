import { z } from "zod";

/** Zod schema describing a detected device's compute capabilities. */
export const DeviceProfileSchema = z.object({
  webgpu: z.boolean(),
  webgl: z.boolean(),
  wasmSimd: z.boolean(),
  hardwareConcurrency: z.number().int().positive(),
  deviceMemoryGb: z.number().positive().optional(),
  gpuVendor: z.string().optional(),
  gpuArchitecture: z.string().optional(),
  gpuIsFallback: z.boolean().optional(),
  gpuMaxBufferBytes: z.number().int().positive().optional(),
  formFactor: z.enum(["desktop", "mobile", "tablet"]),
  platform: z.string(),
});
/** A validated device capability profile (inferred from {@link DeviceProfileSchema}). */
export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;

const SIMD_WASM = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

function hasWasmSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_WASM);
  } catch {
    return false;
  }
}

function hasWebGL(): boolean {
  try {
    const c = typeof document !== "undefined" ? document.createElement("canvas") : null;
    return !!c?.getContext("webgl2") || !!c?.getContext("webgl");
  } catch {
    return false;
  }
}

function inferFormFactor(): "desktop" | "mobile" | "tablet" {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "mobile";
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  return "desktop";
}

interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string; isFallbackAdapter?: boolean };
  limits?: { maxBufferSize?: number };
  requestAdapterInfo?: () => Promise<unknown>;
}

interface GpuLike {
  requestAdapter(opts?: { powerPreference?: "low-power" | "high-performance" }): Promise<GpuAdapterLike | null>;
}

/**
 * Probe the current environment for GPU/WASM/CPU/memory capabilities.
 *
 * Detects WebGPU (with adapter info), WebGL, WASM SIMD, hardware concurrency,
 * device memory, and form factor, returning a schema-validated profile used to
 * pick an embedding scenario.
 *
 * @returns A validated {@link DeviceProfile} for the current device.
 */
export async function detectCapabilities(): Promise<DeviceProfile> {
  const nav = typeof navigator !== "undefined" ? navigator : ({} as Navigator);
  const gpu = (nav as unknown as { gpu?: GpuLike }).gpu;
  const hasGpu = gpu != null;
  let gpuVendor: string | undefined;
  let gpuArchitecture: string | undefined;
  let gpuIsFallback: boolean | undefined;
  let gpuMaxBufferBytes: number | undefined;

  if (hasGpu) {
    try {
      const adapter = await gpu!.requestAdapter({ powerPreference: "high-performance" });
      if (adapter) {
        const info = (adapter.info ??
          (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : undefined)) as
          | GpuAdapterLike["info"]
          | undefined;
        gpuVendor = info?.vendor || undefined;
        gpuArchitecture = info?.architecture || undefined;
        gpuIsFallback = info?.isFallbackAdapter;
        gpuMaxBufferBytes = adapter.limits?.maxBufferSize;
      }
    } catch {
      // privacy masking / unsupported — leave undefined
    }
  }

  let deviceMemoryGb: number | undefined;
  if ("deviceMemory" in nav && typeof nav.deviceMemory === "number") {
    deviceMemoryGb = nav.deviceMemory;
  }

  let formFactor = inferFormFactor();
  const uaData = (
    nav as unknown as {
      userAgentData?: { getHighEntropyValues?: (k: string[]) => Promise<{ mobile?: boolean; platform?: string }> };
    }
  ).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const hep = await uaData.getHighEntropyValues(["mobile", "platform"]);
      if (typeof hep.mobile === "boolean") formFactor = hep.mobile ? "mobile" : "desktop";
    } catch {
      /* ignore */
    }
  }

  const raw = {
    webgpu: hasGpu,
    webgl: hasWebGL(),
    wasmSimd: hasWasmSimd(),
    hardwareConcurrency: nav.hardwareConcurrency || 4,
    deviceMemoryGb,
    gpuVendor,
    gpuArchitecture,
    gpuIsFallback,
    gpuMaxBufferBytes,
    formFactor,
    platform: nav.platform || "unknown",
  };
  return DeviceProfileSchema.parse(raw);
}
