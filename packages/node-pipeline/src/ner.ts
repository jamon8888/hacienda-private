// packages/node-pipeline/src/ner.ts
import { createRequire } from "node:module";
import { dirname } from "node:path";
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

/**
 * Resolves the local filesystem directory holding onnxruntime-web's WASM
 * binaries, via Node's own module resolution against the package's
 * published export map — never a hardcoded `node_modules` layout, which
 * pnpm hoisting/symlinking can rearrange at any time.
 *
 * `onnxruntime-web/package.json` isn't itself an exported subpath (its
 * exports map has no "./package.json" entry), so we resolve one of the
 * package's actually-exported WASM binaries instead — the file gliner's
 * ONNXWebWrapper looks for at inference time — and take its directory.
 *
 * Returned with a trailing "/" because ONNXWebWrapper builds binary URLs
 * via plain string concatenation: `wasmPaths + "ort-wasm-simd-threaded.wasm"`.
 */
export function resolveLocalOnnxWasmPaths(): string {
  const require = createRequire(import.meta.url);
  const wasmBinaryPath = require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm");
  const wasmDir = dirname(wasmBinaryPath).replaceAll("\\", "/");
  return `${wasmDir}/`;
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
      const onnxSettings: IONNXWebSettings = {
        modelPath,
        executionProvider: "wasm",
        wasmPaths: resolveLocalOnnxWasmPaths(),
      };
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
