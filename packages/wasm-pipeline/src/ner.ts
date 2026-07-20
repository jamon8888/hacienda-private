import type { PiiEntity } from "@xberg-io/core";
import type { Gliner, IEntityResult, InitConfig, IONNXWebSettings, ITransformersSettings } from "gliner";
import { API_BASE, GLINER_TOKENIZER_MODEL_ID, glinerModelUrl, ONNXRUNTIME_WEB_WASM_PATHS } from "./constants";
import type { ModelScenario } from "./scenario";

// DEFAULT_SCENARIO is a defensive fallback; ingest.ts and query.ts now pass a real selectScenario() output.
const DEFAULT_SCENARIO: ModelScenario = {
  executionProviders: ["webgpu", "wasm"],
  quant: "int8",
  numThreads: 4,
  chunkSize: 1024,
  deferPii: false,
  modelVariant: "e5-base",
};
let warnedDefaultScenario = false;

// gliner's `initialize()` calls `AutoTokenizer.from_pretrained(tokenizerPath)` via
// `@xenova/transformers`. That function never treats `tokenizerPath` as a literal URL — it's
// always inserted as the `{model}` segment of transformers.js's hub URL template
// (`${env.remoteHost}${tokenizerPath}${env.remotePathTemplate}${filename}`), which defaults to
// `https://huggingface.co/{model}/resolve/{revision}/{filename}`. Passing an absolute URL as
// `tokenizerPath` (an earlier, incorrect fix) produced a mangled request like
// "https://huggingface.co/http://localhost:8787/models/gliner-tokenizer/resolve/main/tokenizer.json"
// — a real, non-huggingface.co host string doesn't parse as a URL, so the browser rejects it with
// a bare "TypeError: Failed to fetch" (no network request is even attempted). The correct fix:
// repoint `env.remoteHost`/`env.remotePathTemplate` at our own server, and pass a bare model id
// (GLINER_TOKENIZER_MODEL_ID) so the template produces `${API_BASE}/models/gliner-tokenizer/tokenizer.json`
// — exactly what services/mcp-server's ModelCache serves.
//
// Also does the same as embed.ts's getSession(): forces single-threaded wasm so it never
// constructs a Worker, and repoints onnxruntime-web's wasmPaths at our own served copy —
// gliner's `AutoTokenizer.from_pretrained()` call (inside model.initialize(), below) imports
// @xenova/transformers internally, which clobbers that same global with its own CDN default on
// import (see constants.ts's ONNXRUNTIME_WEB_WASM_PATHS doc comment). Called both before
// initialize() and again right before the actual inference call, since it's unclear which
// internal step first constructs gliner's onnx session, and re-asserting is cheap and idempotent.
async function configureOrtEnv(): Promise<void> {
  try {
    const { env: transformersEnv } = await import("@xenova/transformers");
    transformersEnv.remoteHost = `${API_BASE}/models/`;
    transformersEnv.remotePathTemplate = "{model}/";
  } catch (e) {
    // Module-resolution failure (e.g. typecheck-only / not installed) is expected and harmless.
    if ((e as NodeJS.ErrnoException)?.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("wasm-pipeline: failed to configure @xenova/transformers remote paths", e);
    }
  }
  try {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = ONNXRUNTIME_WEB_WASM_PATHS;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("wasm-pipeline: failed to configure onnxruntime-web wasmPaths", e);
    }
  }
}

const PII_TYPES = [
  "person",
  "organization",
  "location",
  "email",
  "phone",
  "date",
  "ssn",
  "financial",
] as const;

export function listPiiTypes(): readonly string[] {
  return PII_TYPES;
}

let cachedSig: string | null = null;
let modelPromise: Promise<Gliner> | null = null;

// Local tokenizer loading (no Hugging Face egress).
//
// gliner's `initialize()` calls `AutoTokenizer.from_pretrained(tokenizerPath)` internally via
// `@xenova/transformers`, which configureOrtEnv() (above) has repointed at our own server — see
// its doc comment for exactly how GLINER_TOKENIZER_MODEL_ID resolves to a servable file.
//
// NOTE (cross-plan dependency): this requires Plan 1's `services/mcp-server` ModelCache to serve
// the GLiNER tokenizer file at `/models/gliner-tokenizer/tokenizer.json`. If the Node service
// serves it under a different name, update `GLINER_TOKENIZER_MODEL_ID`.
async function getModel(scenario: ModelScenario): Promise<Gliner> {
  // executionProvider is always "wasm" (see onnxSettings below), so only quant affects which
  // model actually gets (re)loaded.
  const sig = scenario.quant;
  if (!modelPromise || sig !== cachedSig) {
    cachedSig = sig;
    modelPromise = (async () => {
      const { Gliner: GlinerClass } = await import("gliner");
      await configureOrtEnv();
      const transformersSettings: ITransformersSettings = {
        allowLocalModels: true,
        useBrowserCache: false,
      };
      // Unlike our own onnxruntime-web session (embed.ts), gliner's `executionProvider` is a
      // single string with no fallback chain — if it fails, GLiNER has no automatic wasm
      // retry the way ORT's own multi-provider `executionProviders` array does. webgpu (when
      // scenario.executionProviders[0]) can pass capability detection (a real adapter is
      // obtainable, e.g. a software/SwiftShader adapter) yet still fail at actual ONNX
      // execution time ("no available backend found"), with nothing to fall back to. Always
      // use wasm here — the one backend verified to work reliably.
      const onnxSettings: IONNXWebSettings = {
        modelPath: glinerModelUrl(scenario.quant),
        executionProvider: "wasm",
      };
      const config: InitConfig = {
        tokenizerPath: GLINER_TOKENIZER_MODEL_ID,
        onnxSettings,
        transformersSettings,
      };
      const model = new GlinerClass(config);
      await model.initialize();
      return model;
    })();
  }
  return modelPromise;
}

export async function detectPii(
  text: string,
  types: readonly string[] = PII_TYPES,
  scenario: ModelScenario = DEFAULT_SCENARIO,
): Promise<PiiEntity[]> {
  if (scenario === DEFAULT_SCENARIO && !warnedDefaultScenario) {
    warnedDefaultScenario = true;
    console.warn("[wasm-pipeline] detectPii called without a ModelScenario — using DEFAULT_SCENARIO; callers should pass selectScenario() output (see plan task 4-5)");
  }
  const model = await getModel(scenario);
  await configureOrtEnv();
  const result = await model.inference({
    texts: [text],
    entities: [...types],
    flatNer: true,
    threshold: 0.5,
  });
  const ents = result[0] ?? [];
  return ents.map((e: IEntityResult) => ({
    kind: e.label,
    start: e.start,
    end: e.end,
    text: e.spanText,
  }));
}
