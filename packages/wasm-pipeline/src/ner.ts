import type { PiiEntity } from "@xberg-io/core";
import type { Gliner, IEntityResult, InitConfig, IONNXWebSettings } from "gliner";
import { GLINER_MODEL_URL, GLINER_TOKENIZER_REPO } from "./constants";

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

async function getModel(): Promise<Gliner> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { Gliner: GlinerClass } = await import("gliner");
      const onnxSettings: IONNXWebSettings = {
        modelPath: GLINER_MODEL_URL,
        executionProvider: "webgpu",
      };
      const config: InitConfig = {
        tokenizerPath: GLINER_TOKENIZER_REPO,
        onnxSettings,
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
