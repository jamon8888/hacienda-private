// packages/node-pipeline/src/ner.ts
import type { Gliner, IEntityResult, InitConfig, IONNXWebSettings, ITransformersSettings } from "gliner";

export const RUST_ALIGNED_PII_TYPES = [
  "person", "organization", "location", "date", "time", "money", "percent", "email", "phone", "url",
  "ssn", "financial",
] as const;

export interface DetectedEntity {
  kind: string;
  start: number;
  end: number;
  text: string;
}

async function disableRemoteModels(): Promise<void> {
  try {
    const { env } = await import("@xenova/transformers");
    env.allowRemoteModels = false;
  } catch {
    // transformers runtime unavailable — no-op.
  }
}

const modelCache = new Map<string, Promise<Gliner>>();

async function getModel(modelPath: string, tokenizerPath: string): Promise<Gliner> {
  const key = `${modelPath}::${tokenizerPath}`;
  let cached = modelCache.get(key);
  if (!cached) {
    cached = (async () => {
      const { Gliner: GlinerClass } = await import("gliner");
      await disableRemoteModels();
      const transformersSettings: ITransformersSettings = { allowLocalModels: true, useBrowserCache: false };
      const onnxSettings: IONNXWebSettings = { modelPath, executionProvider: "wasm" };
      const config: InitConfig = { tokenizerPath, onnxSettings, transformersSettings };
      const model = new GlinerClass(config);
      await model.initialize();
      return model;
    })();
    modelCache.set(key, cached);
  }
  return cached;
}

export async function detectPii(
  text: string,
  modelPath: string,
  tokenizerPath: string,
  types: readonly string[] = RUST_ALIGNED_PII_TYPES,
): Promise<DetectedEntity[]> {
  const model = await getModel(modelPath, tokenizerPath);
  const result = await model.inference({ texts: [text], entities: [...types], flatNer: true, threshold: 0.5 });
  const ents = result[0] ?? [];
  return ents.map((e: IEntityResult) => ({ kind: e.label, start: e.start, end: e.end, text: e.spanText }));
}
