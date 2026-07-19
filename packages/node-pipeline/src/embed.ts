// packages/node-pipeline/src/embed.ts
import type { InferenceSession, Tensor } from "onnxruntime-web";

const EMBED_DIM = 768;
const sessionCache = new Map<string, Promise<InferenceSession>>();

// Unlike ner.ts's use of onnxruntime-web through gliner's ONNXWebWrapper,
// this module imports onnxruntime-web directly. No explicit local wasmPaths
// resolution (mirroring resolveLocalOnnxWasmPaths in ner.ts) is needed here:
// Task 6's CDN-egress bug lived entirely in gliner's own ONNXWebWrapper,
// which hardcodes `ort.env.wasm.wasmPaths` to a jsdelivr CDN URL by default
// (see gliner/src/web/ONNXWebWrapper.ts: `ONNX_WASM_CDN_URL` /
// `DEFAULT_WASM_PATHS`) — that default is gliner's own code, not
// onnxruntime-web's. onnxruntime-web's package.json "exports" map resolves
// the bare `"onnxruntime-web"` specifier under Node's own "node" condition
// to its dedicated Node build (dist/ort.node.min.mjs), whose default WASM
// binary loader (when `env.wasm.wasmPaths` is left unset, as it is here)
// resolves the engine binary via a relative dynamic `import()` against its
// own installed package directory — a genuine local file load, never a
// network fetch. This was confirmed by probing the installed package
// directly: with wasmPaths unset, `InferenceSession.create()` against a
// nonexistent local model path fails with a local ENOENT (i.e. the WASM
// engine already initialized from local files before even attempting to
// read the model), never a CDN network attempt.
async function getSession(modelPath: string): Promise<InferenceSession> {
  let cached = sessionCache.get(modelPath);
  if (!cached) {
    cached = (async () => {
      const ort = await import("onnxruntime-web");
      return ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] });
    })();
    sessionCache.set(modelPath, cached);
  }
  return cached;
}

export async function embedText(text: string, modelPath: string, tokenizerPath: string): Promise<number[]> {
  if (!text.trim()) {
    throw new Error("embedText: input text must not be empty");
  }
  const { AutoTokenizer } = await import("@xenova/transformers");
  const tokenizer = await AutoTokenizer.from_pretrained(tokenizerPath, { local_files_only: true });
  const encoded = await tokenizer(text, { padding: true, truncation: true });

  const ort = await import("onnxruntime-web");
  const session = await getSession(modelPath);
  const feeds: Record<string, Tensor> = {
    input_ids: new ort.Tensor("int64", encoded.input_ids.data, encoded.input_ids.dims),
    attention_mask: new ort.Tensor("int64", encoded.attention_mask.data, encoded.attention_mask.dims),
  };
  const output = await session.run(feeds);
  const embedding = output["sentence_embedding"] ?? Object.values(output)[0];
  if (!embedding) {
    throw new Error("embedText: model produced no output tensor");
  }
  const values = Array.from(embedding.data as Float32Array);
  if (values.length !== EMBED_DIM) {
    throw new Error(`embedText: expected ${EMBED_DIM}-dim output, got ${values.length}`);
  }
  return values;
}
