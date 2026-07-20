# WASM Capability Detection & Adaptive WIC/Model Scenario Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-side capability detector + scenario selector to `packages/wasm-pipeline` so ORT-web execution provider, model quantization, and chunk/batch knobs are chosen per-device (GPU/CPU/OS/RAM) instead of hard-coded, optimizing speed and memory on everything from an 8 GB / 4-thread laptop to a modern discrete-GPU machine.

**Architecture:** A pure-TS `detectCapabilities()` probes the JS host (WebGPU adapter info + limits, `hardwareConcurrency`, `deviceMemory`, UA/UA-CH) and returns a `DeviceProfile`. A deterministic `selectScenario(profile)` table maps that profile to a `ModelScenario` (EP chain, quant level, threads, chunk size, PII deferral). `embed.ts`/`ner.ts`/`ingest.ts` consume the scenario *before* `ort.InferenceSession.create`. This is orthogonal to WASM memory64 — it works on standard wasm32 + ORT-web today.

**Tech Stack:** TypeScript (ESM, `strict` + `noUncheckedIndexedAccess`), `onnxruntime-web` (`executionProviders` + `env.wasm.numThreads`), WebGPU (`navigator.gpu.requestAdapter`/`adapter.info`/`adapter.limits`), `zod` for profile validation. Targets the existing `packages/wasm-pipeline` (Plan 2).

---

## Scope note

This plan covers **one subsystem**: device capability detection → adaptive model scenario. It is a vertical slice that slots into Plan 2's `packages/wasm-pipeline`. It does NOT add new ML models, change the pipeline stages, or touch the Node service. Wiring points are called out per task.

> **Do NOT gate on Wasm64 / memory64.** Investigation finding: memory64 only changes linear-memory addressing (4 GiB cap → larger). It does not expose OS/GPU/CPU and is unnecessary here (`multilingual-e5-base` INT8 ≈ 470 MB, GLiNER-PII INT8 ≈ 100–160 MB — both fit wasm32). Detection uses the JS host, not the WASM module.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/wasm-pipeline/src/capabilities.ts` | Probe the browser; return a validated `DeviceProfile`. |
| `packages/wasm-pipeline/src/scenario.ts` | Pure `selectScenario(profile)` → `ModelScenario` decision table. |
| `packages/wasm-pipeline/src/capabilities.test.ts` | Unit tests for detection (mocked `navigator`/`gpu`). |
| `packages/wasm-pipeline/src/scenario.test.ts` | Unit tests for the decision table (all profile combos). |
| Modify `packages/wasm-pipeline/src/embed.ts` | Pass scenario EP + quant + threads into `ort.InferenceSession.create`. |
| Modify `packages/wasm-pipeline/src/ner.ts` | Same — GLiNER EP/quant from scenario. |
| Modify `packages/wasm-pipeline/src/ingest.ts` | Resolve scenario once, pass to embed/ner; apply chunk-size knob. (Edits the file created in Plan 2 Task 9 — add the two new imports + scenario resolution; do NOT rewrite it.) |
| Modify `packages/wasm-pipeline/src/index.ts` | Re-export `detectCapabilities`, `selectScenario`, `DeviceProfile`, `ModelScenario`. |

---

## Detectable signals (capability surface)

| Signal | Source | Used for |
|---|---|---|
| WebGPU present | `'gpu' in navigator` | EP chain head |
| GPU vendor / architecture | `adapter.info` (`vendor`, `architecture`, `isFallbackAdapter`) | discrete vs integrated class |
| GPU limits | `adapter.limits.maxBufferSize`, `maxStorageBufferBindingSize` | inferred max model footprint |
| WebGL present | `document.createElement('canvas').getContext('webgl2')` | EP chain fallback |
| CPU threads | `navigator.hardwareConcurrency` | `env.wasm.numThreads`, batch size |
| Device RAM | `navigator.deviceMemory` (Chromium; `undefined` elsewhere) | quant level, chunk size |
| Form factor / OS | `navigator.userAgentData.getHighEntropyValues(['architecture','model','mobile','platform'])` + `userAgent` fallback | mobile vs desktop quant |
| WASM SIMD | feature-probe function | required for WASM-SIMD EP |

> **Privacy:** `adapter.info.vendor`/`architecture` may be empty strings. Always fall through to a conservative default scenario. Never throw on missing fields.

---

### Task 1 — `src/capabilities.ts`: capability detection

**Files:**
- Create: `packages/wasm-pipeline/src/capabilities.ts`
- Test: `packages/wasm-pipeline/src/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { detectCapabilities } from "./capabilities";
import type { DeviceProfile } from "./capabilities";

function fakeNavigator(over: Record<string, unknown> = {}): DeviceProfile {
  const base = {
    webgpu: false,
    webgl: false,
    wasmSimd: true,
    hardwareConcurrency: 4,
    deviceMemoryGb: undefined,
    gpuVendor: undefined,
    gpuArchitecture: undefined,
    gpuIsFallback: undefined,
    gpuMaxBufferBytes: undefined,
    formFactor: "desktop" as const,
    platform: "unknown",
  };
  return { ...base, ...over } as DeviceProfile;
}

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter wasm-pipeline test src/capabilities.test.ts`
Expected: FAIL — `Cannot find module './capabilities'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { z } from "zod";

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
export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;

function hasWasmSimd(): boolean {
  try {
    // Probe a minimal module that returns a v128 (SIMD); validate() throws on non-SIMD engines.
    new Function("return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]))")();
    return true;
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

export async function detectCapabilities(): Promise<DeviceProfile> {
  const nav = typeof navigator !== "undefined" ? navigator : ({} as Navigator);
  const hasGpu = "gpu" in nav && !!nav.gpu;
  let gpuVendor: string | undefined;
  let gpuArchitecture: string | undefined;
  let gpuIsFallback: boolean | undefined;
  let gpuMaxBufferBytes: number | undefined;

  if (hasGpu) {
    try {
      const adapter = await nav.gpu!.requestAdapter({ powerPreference: "high-performance" });
      if (adapter) {
        const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : undefined);
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
  const uaData = (nav as unknown as { userAgentData?: { getHighEntropyValues?: (k: string[]) => Promise<{ mobile?: boolean; platform?: string }> } }).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const hep = await uaData.getHighEntropyValues(["mobile", "platform"]);
      if (typeof hep.mobile === "boolean") formFactor = hep.mobile ? "mobile" : "desktop";
    } catch { /* ignore */ }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter wasm-pipeline test src/capabilities.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/wasm-pipeline/src/capabilities.ts packages/wasm-pipeline/src/capabilities.test.ts
git commit -m "feat(wasm-pipeline): browser capability detection (GPU/CPU/OS)"
```

---

### Task 2 — `src/scenario.ts`: adaptive scenario selection

**Files:**
- Create: `packages/wasm-pipeline/src/scenario.ts`
- Test: `packages/wasm-pipeline/src/scenario.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { selectScenario } from "./scenario";
import type { DeviceProfile } from "./capabilities";

function profile(over: Partial<DeviceProfile>): DeviceProfile {
  return {
    webgpu: false, webgl: false, wasmSimd: true, hardwareConcurrency: 4,
    formFactor: "desktop", platform: "unknown", ...over,
  } as DeviceProfile;
}

describe("selectScenario", () => {
  it("picks WebGPU + INT8 on a discrete GPU laptop", () => {
    const s = selectScenario(profile({ webgpu: true, gpuVendor: "nvidia", gpuArchitecture: "turing", gpuMaxBufferBytes: 256 * 1024 * 1024, hardwareConcurrency: 8, deviceMemoryGb: 16 }));
    expect(s.executionProviders).toEqual(["webgpu", "webgl", "wasm"]);
    expect(s.quant).toBe("int8");
    expect(s.numThreads).toBe(8);
  });

  it("picks WASM-SIMD + INT4 on a low-RAM 4-thread laptop", () => {
    const s = selectScenario(profile({ webgpu: false, webgl: false, hardwareConcurrency: 4, deviceMemoryGb: 4 }));
    expect(s.executionProviders).toEqual(["wasm"]);
    expect(s.quant).toBe("int4");
    expect(s.deferPii).toBe(true);
    expect(s.chunkSize).toBeLessThanOrEqual(512);
  });

  it("picks INT4 + mobile knobs on a phone", () => {
    const s = selectScenario(profile({ webgpu: true, formFactor: "mobile", hardwareConcurrency: 6, deviceMemoryGb: 6 }));
    expect(s.quant).toBe("int4");
    expect(s.chunkSize).toBeLessThanOrEqual(384);
  });

  it("falls back to conservative defaults when GPU info is masked", () => {
    const s = selectScenario(profile({ webgpu: true, gpuVendor: "", gpuArchitecture: "", gpuMaxBufferBytes: undefined, hardwareConcurrency: 4 }));
    expect(s.quant).toBe("int4");
    expect(s.executionProviders[0]).toBe("webgpu");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter wasm-pipeline test src/scenario.test.ts`
Expected: FAIL — `Cannot find module './scenario'`.

- [ ] **Step 3: Write minimal implementation**

```ts
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

  // Quantization: discrete GPU + decent RAM → INT8; otherwise INT4 to fit.
  const quant: ModelScenario["quant"] =
    gpuLooksDiscrete && !lowRam && !isMobile ? "int8" : "int4";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter wasm-pipeline test src/scenario.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/wasm-pipeline/src/scenario.ts packages/wasm-pipeline/src/scenario.test.ts
git commit -m "feat(wasm-pipeline): adaptive model scenario selection"
```

---

### Task 3 — Wire scenario into `src/embed.ts`

**Files:**
- Modify: `packages/wasm-pipeline/src/embed.ts`

- [ ] **Step 1: Add a scenario-aware embed entry**

```ts
import type { Chunk } from "@xberg-io/core";
import type { ModelScenario } from "./scenario";

const API_BASE = "http://localhost:8787";

export async function embedChunks(chunks: Chunk[], scenario: ModelScenario): Promise<number[][]> {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = scenario.numThreads;
  const modelFile = scenario.modelVariant === "e5-small" ? "e5-small.onnx" : "e5.onnx";
  const quantTag = scenario.quant; // int8 | int4 — Node serves /models/e5.{quant}.onnx
  const resp = await fetch(`${API_BASE}/models/${modelFile.replace(".onnx", `.${quantTag}.onnx`)}`);
  const buf = await resp.arrayBuffer();
  const session = await ort.InferenceSession.create(buf, {
    executionProviders: scenario.executionProviders,
  });
  return chunks.map((c) => embedOne(session, c.text));
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter wasm-pipeline typecheck`
Expected: clean (strict + noUncheckedIndexedAccess).

- [ ] **Step 3: Commit**

```bash
git add packages/wasm-pipeline/src/embed.ts
git commit -m "feat(wasm-pipeline): embed honors adaptive scenario (EP + quant + threads)"
```

---

### Task 4 — Wire scenario into `src/ner.ts`

**Files:**
- Modify: `packages/wasm-pipeline/src/ner.ts`

- [ ] **Step 1: Add scenario-aware PII detection**

```ts
import type { PiiEntity } from "@xberg-io/core";
import type { ModelScenario } from "./scenario";

const API_BASE = "http://localhost:8787";
const PII_TYPES = ["person", "organization", "location", "email", "phone", "date", "ssn", "financial"];

export async function detectPii(text: string, scenario: ModelScenario): Promise<PiiEntity[]> {
  const { GLiNER } = await import("gliner");
  const quantTag = scenario.quant;
  const model = new GLiNER({
    tokenizerPath: "onnx-community/gliner_small-v2",
    onnxSettings: {
      modelPath: `${API_BASE}/models/gliner-pii.${quantTag}.onnx`,
      executionProviders: scenario.executionProviders,
    },
  });
  await model.initialize();
  const ents = await model.inference({ texts: [text], entities: PII_TYPES });
  return ents.map((e) => ({ kind: e.label, start: e.start, end: e.end, text: e.text }));
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter wasm-pipeline typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/wasm-pipeline/src/ner.ts
git commit -m "feat(wasm-pipeline): PII honors adaptive scenario (EP + quant)"
```

---

### Task 5 — Resolve scenario once in `src/ingest.ts`

**Files:**
- Modify: `packages/wasm-pipeline/src/ingest.ts`

- [ ] **Step 1: Detect + select at ingest start; thread scenario through**

```ts
import { detectCapabilities } from "./capabilities";
import { selectScenario } from "./scenario";

export async function ingestFolder(
  matter: Matter, folder: Folder, file: File, scopeToken: string,
): Promise<{ accepted: number }> {
  const profile = await detectCapabilities();
  const scenario = selectScenario(profile);

  const doc = await extractDocument(file, withTesseractOcr(defaultConfig()));
  const chunks = chunkExtraction(doc, { ...defaultChunking(), chunkSize: scenario.chunkSize });
  const vectors = await embedChunks(chunks, scenario);
  const pii = scenario.deferPii
    ? await runPiiWhenIdle(chunks, scenario)
    : (await Promise.all(chunks.map((c) => detectPii(c.text, scenario)))).flat();
  await buildIndex(matter.id, chunks, vectors);
  const { cipher } = await redactDocument(doc.text, pii);
  await pushMirror(matter, await serializeIndex(matter.id), cipher, scopeToken);
  return { accepted: chunks.length };
}

function runPiiWhenIdle(chunks: Chunk[], scenario: ModelScenario): Promise<PiiEntity[]> {
  const run = () => Promise.all(chunks.map((c) => detectPii(c.text, scenario))).then((r) => r.flat());
  const w = typeof window !== "undefined" ? (window as Window & { requestIdleCallback?: (cb: () => void) => number }) : undefined;
  if (w?.requestIdleCallback) {
    return new Promise((res) => { w.requestIdleCallback(() => { void run().then(res); }); });
  }
  return new Promise((res) => setTimeout(() => { void run().then(res); }, 0));
}
```

- [ ] **Step 2: Run typecheck + full test suite**

Run: `pnpm --filter wasm-pipeline typecheck && pnpm --filter wasm-pipeline test`
Expected: clean + PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/wasm-pipeline/src/ingest.ts
git commit -m "feat(wasm-pipeline): resolve adaptive scenario once at ingest"
```

---

### Task 6 — Re-export from `src/index.ts`

**Files:**
- Modify: `packages/wasm-pipeline/src/index.ts`

- [ ] **Step 1: Add public exports**

```ts
export { detectCapabilities, DeviceProfileSchema } from "./capabilities";
export type { DeviceProfile } from "./capabilities";
export { selectScenario, ModelScenarioSchema } from "./scenario";
export type { ModelScenario } from "./scenario";
```

- [ ] **Step 2: Run build + typecheck**

Run: `pnpm --filter wasm-pipeline build && pnpm --filter wasm-pipeline typecheck`
Expected: emits `dist/index.js` + `dist/index.d.ts`; clean.

- [ ] **Step 3: Commit**

```bash
git add packages/wasm-pipeline/src/index.ts
git commit -m "feat(wasm-pipeline): expose capability detection + scenario API"
```

---

## Knob reference (what each scenario field drives)

| Field | Drives | Example (your 8 GB / 4-thread box) |
|---|---|---|
| `executionProviders` | ORT-web EP chain order | `["wasm"]` if no WebGPU; `["webgpu","webgl","wasm"]` on modern laptop |
| `quant` | ONNX quant file served from Node (`e5.int8.onnx` vs `e5.int4.onnx`) | `int4` (low RAM + weak CPU) |
| `numThreads` | `ort.env.wasm.numThreads` | `4` |
| `chunkSize` | xberg chunker `chunkSize` | `512` |
| `deferPii` | GLiNER runs on `requestIdleCallback` | `true` |
| `modelVariant` | `e5-base` vs `e5-small` (latter gated OFF until Node serves it) | `e5-base` |

> **Node service contract addition (Plan 1 follow-up):** serve quantized variants `/models/e5.int8.onnx`, `/models/e5.int4.onnx`, `/models/e5-small.int8.onnx`, `/models/e5-small.int4.onnx`, `/models/gliner-pii.int8.onnx`, `/models/gliner-pii.int4.onnx`, all SHA256-pinned. The browser requests the variant the scenario selects — no HF egress.

---

## Verification

- [ ] `pnpm --filter wasm-pipeline test` — `capabilities.test.ts` + `scenario.test.ts` PASS.
- [ ] `pnpm --filter wasm-pipeline typecheck` — clean under `strict` + `noUncheckedIndexedAccess`.
- [ ] `pnpm --filter wasm-pipeline build` — emits ESM + dts.
- [ ] Manual: on a machine with WebGPU, `detectCapabilities()` shows `webgpu:true` + `gpuVendor`; `selectScenario` returns `int8` + `["webgpu","webgl","wasm"]`. On a 4-thread/4 GB box, returns `int4` + `["wasm"]` + `deferPii:true`.
- [ ] Confirm no code path throws when `adapter.info` fields are empty (privacy masking).

---

## Risks / Non-goals

- **No true VRAM number from WebGPU.** `gpuMaxBufferBytes` + `gpuArchitecture` are proxies. Scenario must stay conservative when these are `undefined`.
- **`navigator.deviceMemory` is Chromium-only** (`undefined` on Firefox/Safari) — treated as `8` default, never trusted as exact.
- **Wasm64 not required** — detection is host-side; wasm32 + ORT-web is sufficient. Do not add a memory64 build target for this feature.
- **Threaded WASM needs COOP/COEP** — `env.wasm.numThreads > 1` (WebGPU/threaded WASM EP) requires the page be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). The Node service must send these headers or `numThreads` silently falls back to 1. Already part of the parent architecture; restated to avoid silent perf loss.
- **`e5-small` gated OFF** — `selectScenario` returns `e5-base` until Plan 1's Node service serves `e5-small.*` ONNX (see `smallVariantsServed` flag). Default path never 404s.
- **No new models** — this plan only selects among existing/quantized variants served by the Node service.
- **`e5-small` variant** must be pinned + served by Node if `modelVariant:"e5-small"` is reachable; otherwise drop that branch and force `e5-base`.
