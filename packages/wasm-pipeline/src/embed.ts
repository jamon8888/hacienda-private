import type { FetchProgress } from "./model-cache";
import type { ModelScenario } from "./scenario";
import {
  embedChunks as embedGraniteChunks,
  embedQuery as embedGraniteQuery,
  ensureGraniteEmbedder,
  resetGraniteEmbedder,
} from "./granite-embed";

export interface EmbeddableChunk {
  text: string;
}

/** Embed chunks through the Rust-owned Granite backend in a dedicated Worker. */
export function embedChunks(
  chunks: EmbeddableChunk[],
  onProgress?: (progress: FetchProgress) => void,
): Promise<Float32Array[]> {
  return embedGraniteChunks(chunks, onProgress);
}

/** Embed a query with the same model, tokenizer, pooling, and normalization as documents. */
export function embedQuery(text: string, onProgress?: (progress: FetchProgress) => void): Promise<Float32Array> {
  return embedGraniteQuery(text, onProgress);
}

/** Compatibility warmup entry point; the shared model has one fixed profile. */
export function ensureEmbedSession(
  _scenario: ModelScenario,
  onProgress?: (progress: FetchProgress) => void,
): Promise<void> {
  return ensureGraniteEmbedder(onProgress);
}

export function resetEmbedSession(): void {
  resetGraniteEmbedder();
}

export {
  ensureGraniteEmbedder,
  graniteEmbeddingDimension,
  graniteEmbeddingIdentity,
  resetGraniteEmbedder,
} from "./granite-embed";
