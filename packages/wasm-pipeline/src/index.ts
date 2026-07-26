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
export { ensureGliner2Model, resetGliner2Model } from "./gliner2";
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

export { API_BASE, GLINER_TOKENIZER_REPO_ID, EMBED_DIM } from "./constants";

export type { Matter, Folder, PiiEntity, RetrievedChunk, AuthScopes } from "@xberg-io/core";

export { warmupModels } from "./warmup";
export type { WarmupProgress, WarmupResult, WarmupStage } from "./warmup";
