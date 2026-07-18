/**
 * Public entry point (barrel) for the `@xberg-io/wasm-pipeline` package.
 *
 * Re-exports the browser-side document-intelligence pipeline: WASM runtime,
 * OCR/chunking config, embeddings, PII detection, EdgeVec RAG, reversible
 * redaction, mirror serialization, ingest/query orchestration, the browser
 * vault, the local-first egress guard, and device-capability/scenario helpers.
 *
 * @module
 */
export { initWasm, extractDocument, getWasm, firstDocument, extractText } from "./runtime";
export type {
  WasmExtractionConfig,
  WasmExtractionResult,
  WasmExtractedDocument,
  WasmChunk,
  WasmChunkingConfig,
  WasmOcrConfig,
} from "./runtime";

export * from "./ocr";
export * from "./chunk";
export * from "./embed";
export * from "./ner";
export * from "./rag";
export * from "./redact";
export * from "./mirror";
export * from "./ingest";
export * from "./query";
export { BrowserVault } from "./vault";
export type { CipherBundle } from "./vault";
export { assertLocalFirst } from "./egress";

export { detectCapabilities, DeviceProfileSchema } from "./capabilities";
export type { DeviceProfile } from "./capabilities";
export { selectScenario, ModelScenarioSchema } from "./scenario";
export type { ModelScenario } from "./scenario";

export {
  API_BASE,
  E5_TOKENIZER_URL,
  E5_TOKENIZER_CONFIG_URL,
  GLINER_TOKENIZER_URL,
  EMBED_DIM,
} from "./constants";

export type { Matter, Folder, PiiEntity, RetrievedChunk, AuthScopes } from "@xberg-io/core";
