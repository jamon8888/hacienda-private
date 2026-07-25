import { z } from "zod";
import type { DeviceProfile } from "./capabilities";

export const ModelScenarioSchema = z.object({
  executionProviders: z.array(z.enum(["webgpu", "webgl", "wasm"])),
  quant: z.enum(["int8", "int4", "fp32"]),
  numThreads: z.number().int().positive(),
  chunkSize: z.number().int().positive(),
  deferPii: z.boolean(),
  modelVariant: z.enum(["e5-base", "e5-small"]),
});
export type ModelScenario = z.infer<typeof ModelScenarioSchema>;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function selectScenario(p: DeviceProfile): ModelScenario {
  const epChain: ModelScenario["executionProviders"] = [];
  // webgpu and webgl are intentionally excluded even when detected: embed.ts loads the
  // "onnxruntime-web/wasm" bundle (not the full bundle), which only registers the wasm
  // backend. The full bundle's webgpu path needs a worker module the static export doesn't
  // serve correctly (resolves to a file:// path instead of an http URL), which — because
  // the full bundle shares its wasm runtime file with webgpu/jsep — took the wasm fallback
  // down with it too; and its webgl backend never registered at all ("backend not found").
  // Re-enable once those assets are served properly under next.config.mjs's webpack build.
  epChain.push("wasm"); // always available fallback

  const cpuThreads = clamp(p.hardwareConcurrency, 1, 8);
  const isMobile = p.formFactor === "mobile" || p.formFactor === "tablet";
  const lowRam = (p.deviceMemoryGb ?? 8) <= 4;
  const weakCpu = cpuThreads <= 4;
  const gpuLooksDiscrete =
    !!p.gpuVendor && !!p.gpuArchitecture && p.gpuIsFallback !== true && (p.gpuMaxBufferBytes ?? 0) >= 128 * 1024 * 1024;

  // Quantization: discrete GPU + decent RAM → INT8; otherwise INT4 to fit.
  const quant: ModelScenario["quant"] = gpuLooksDiscrete && !lowRam && !isMobile ? "int8" : "int4";

  // Chunk size: smaller on constrained devices to bound peak memory.
  let chunkSize = 1024;
  if (lowRam) chunkSize = 512;
  if (isMobile) chunkSize = Math.min(chunkSize, 384);
  if (weakCpu) chunkSize = Math.min(chunkSize, 512);

  // Model variant: phones / very low RAM drop to e5-small ONLY if the Node
  // service advertises small-variant support (Plan 1 contract addition). Until
  // that serves /models/e5-small.{int8,int4}.onnx, gate OFF so the default path
  // stays e5-base and never 404s. Flip via detectCapabilities-style flag when
  // the Node contract is extended.
  const smallVariantsServed = false; // TODO(plan1): enable when Node serves e5-small.*
  const modelVariant: ModelScenario["modelVariant"] =
    smallVariantsServed && (isMobile || lowRam) ? "e5-small" : "e5-base";

  // Defer PII (GLiNER) to idle when CPU/MEM constrained.
  const deferPii = lowRam || weakCpu || isMobile;

  // Multi-threaded onnxruntime-web needs SharedArrayBuffer, which needs cross-origin isolation
  // (COOP/COEP response headers). The static export this ships as has no server-side headers()
  // support to set those, so ort's threaded WASM backend spawns its worker pool without the
  // isolation it needs — the Worker fails to come up and InferenceSession.create() hangs forever
  // instead of erroring. Pin to 1 thread until COOP/COEP is wired up at the serving layer (see
  // next.config.mjs); cpuThreads above still drives the unrelated quant/chunk-size/deferPii
  // heuristics.
  const numThreads = 1;

  return ModelScenarioSchema.parse({
    executionProviders: epChain,
    quant,
    numThreads,
    chunkSize,
    deferPii,
    modelVariant,
  });
}
