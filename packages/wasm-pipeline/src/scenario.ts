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
  if (p.webgpu) epChain.push("webgpu");
  if (p.webgl) epChain.push("webgl");
  epChain.push("wasm"); // always available fallback

  const threads = clamp(p.hardwareConcurrency, 1, 8);
  const isMobile = p.formFactor === "mobile" || p.formFactor === "tablet";
  const lowRam = (p.deviceMemoryGb ?? 8) <= 4;
  const weakCpu = threads <= 4;
  const gpuLooksDiscrete =
    !!p.gpuVendor && !!p.gpuArchitecture && p.gpuIsFallback !== true &&
    (p.gpuMaxBufferBytes ?? 0) >= 128 * 1024 * 1024;

  // Quantization: INT4 is gated off for now — the published int4 ONNX graph uses operators
  // (e.g. CumSum) that onnxruntime-web's wasm/CPU execution provider does not implement
  // ("cannot resolve operator 'CumSum' with opsets: ai.onnx v11"), and wasm is the only
  // execution provider guaranteed to be available (GPU is opportunistic/best-effort, with
  // silent fallback to wasm on failure) — so INT4 would break exactly the constrained
  // devices it's meant to help. INT8 uses standard ops the wasm backend does support.
  // TODO(plan2): flip this on once CumSum support (or an INT4 export without it) is
  // confirmed on the wasm EP, not just capability-detected.
  const int4Verified = false;
  const quant: ModelScenario["quant"] =
    int4Verified && gpuLooksDiscrete && !lowRam && !isMobile ? "int4" : "int8";

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
