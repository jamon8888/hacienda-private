import type { PiiEntity } from "@xberg-io/core";
import type { Gliner, IEntityResult, InitConfig, IONNXWebSettings, ITransformersSettings } from "gliner";
import { GLINER_MODEL_URL, GLINER_TOKENIZER_URL } from "./constants";

// Remote-model guard: gliner's `initialize()` calls `AutoTokenizer.from_pretrained(tokenizerPath)`
// via `@xenova/transformers`. Turn off remote fetching up-front so it can never fall back to
// huggingface.co / hf.co. `env` only exists in the browser/Node transformers build; guard the import.
async function disableRemoteModels(): Promise<void> {
  try {
    const { env } = await import("@xenova/transformers");
    env.allowRemoteModels = false;
  } catch {
    // transformers runtime unavailable here (e.g. typecheck-only) — no-op.
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

let modelPromise: Promise<Gliner> | null = null;

// Local tokenizer loading (no Hugging Face egress).
//
// gliner's `initialize()` calls `AutoTokenizer.from_pretrained(tokenizerPath)` internally via
// `@xenova/transformers`. We point `tokenizerPath` at the Node-served local tokenizer JSON
// (`${API_BASE}/models/gliner-tokenizer.json`) rather than an HF repo id, so no runtime request
// to huggingface.co / hf.co is made. We also disable remote model loading in transformers.js
// (`env.allowRemoteModels = false`) and tell gliner to only use local models, as belt-and-suspenders
// guards so the library can never fall back to a remote HF fetch.
//
// NOTE (cross-plan dependency): this requires Plan 1's `services/mcp-server` ModelCache to serve a
// GLiNER tokenizer file at `/models/gliner-tokenizer.json` (standard transformers tokenizer.json
// layout). If the Node service serves it under a different name, update `GLINER_TOKENIZER_URL`.
async function getModel(): Promise<Gliner> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { Gliner: GlinerClass } = await import("gliner");
      await disableRemoteModels();
      const transformersSettings: ITransformersSettings = {
        allowLocalModels: true,
        useBrowserCache: false,
      };
      const onnxSettings: IONNXWebSettings = {
        modelPath: GLINER_MODEL_URL,
        executionProvider: "webgpu",
      };
      const config: InitConfig = {
        tokenizerPath: GLINER_TOKENIZER_URL,
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
): Promise<PiiEntity[]> {
  const model = await getModel();
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
