import { z } from "zod";
import type { DeviceProfile } from "./capabilities";

/** Zod schema for a chosen model/runtime scenario (EPs, quant, threads, etc.). */
export const ModelScenarioSchema = z.object({
  executionProviders: z.array(z.enum(["webgpu", "webgl", "wasm"])),
  quant: z.enum(["int8", "int4", "fp32"]),
  numThreads: z.number().int().positive(),
  chunkSize: z.number().int().positive(),
  deferPii: z.boolean(),
  modelVariant: z.enum(["e5-base", "e5-small"]),
});
/** A validated model/runtime scenario (inferred from {@link ModelScenarioSchema}). */
export type ModelScenario = z.infer<typeof ModelScenarioSchema>;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Choose an embedding model/runtime scenario from a device profile.
 *
 * Builds the execution-provider chain (WebGPU → WebGL → WASM), and picks
 * quantization, chunk size, model variant, and PII deferral based on GPU class,
 * RAM, CPU threads, and form factor.
 *
 * @param p - The detected {@link DeviceProfile}.
 * @returns A schema-validated {@link ModelScenario}.
 */
export function selectScenario(p: DeviceProfile): ModelScenario {
  const epChain: ModelScenario["executionProviders"] = [];
  if (p.webgpu) epChain.push("webgpu");
  if (p.webgl) epChain.push("webgl");
  epChain.push("wasm"); // always available fallback

  const threads = clamp(p.hardwareConcurrency, 1, 8);
  const isMobile = p.formFactor === "mobile" || p.formFactor === "tablet";
  const lowRam = (p.deviceMemoryGb ?? 8) <= 4;
  const weakCpu = threads <= 4;
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

  return ModelScenarioSchema.parse({
    executionProviders: epChain,
    quant,
    numThreads: threads,
    chunkSize,
    deferPii,
    modelVariant,
  });
}
