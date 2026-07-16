// Thin client surface for the on-device engine.
//
// IN REAL DEPLOYMENT this module is replaced by the real `packages/wasm-pipeline`
// workspace package (Plan 2): extract+OCR+chunk via `@xberg-io/xberg-wasm`,
// e5 embeddings (onnxruntime-web), GLiNER PII, EdgeVec RAG, and curtain-privacy
// reversible redaction. The UI must never reimplement any of that logic — it only
// calls these functions.
//
// This adapter is the single seam the UI imports as `@xberg-io/wasm-pipeline`.
// It depends ONLY on shared types from `@xberg-io/core` and contains no engine logic.

import type {
  PiiEntity,
  RetrievedChunk,
} from "@xberg-io/core";

export interface ExtractedDocument {
  doc_id: string;
  name: string;
  text: string;
  pages: number;
  pii: PiiEntity[];
}

export interface IngestResult {
  doc_id: string;
  name: string;
  text: string;
  pages: number;
  pii: PiiEntity[];
  chunks: RetrievedChunk[];
  /** Serialized EdgeVec mirror payload pushed to the Node `/rag/mirror` endpoint. */
  mirror: unknown;
}

export interface IngestProgress {
  doc_id: string;
  name: string;
  stage: "extract" | "ocr" | "chunk" | "embed" | "pii" | "index" | "done" | "error";
  progress: number;
}

/**
 * Run the full on-device pipeline for a set of dropped files: extract + Tesseract
 * OCR + chunk + e5 embed + GLiNER PII + EdgeVec index + curtain redaction, then push
 * the EdgeVec mirror to the Node service. Resolves per-file with an `IngestResult`.
 */
export async function ingestFolder(
  files: File[],
  onProgress?: (progress: IngestProgress) => void,
): Promise<IngestResult[]> {
  throw new Error(
    "engine: ingestFolder is not available — the real @xberg-io/wasm-pipeline package is required at runtime.",
  );
}

/** Extract text + OCR + chunk for a single document (used by tests and previews). */
export async function extractDocument(file: File): Promise<ExtractedDocument> {
  throw new Error(
    "engine: extractDocument is not available — the real @xberg-io/wasm-pipeline package is required at runtime.",
  );
}

/**
 * Reversible curtain-privacy redaction: originals are encrypted into the browser
 * AES-GCM key vault and replaced with reversible tokens. A mirrored redaction marker
 * is pushed to the Node service via `/rag/mirror`.
 */
export async function redactDocument(
  docId: string,
  entityIds: string[],
): Promise<void> {
  throw new Error(
    "engine: redactDocument is not available — the real @xberg-io/wasm-pipeline package is required at runtime.",
  );
}

/** In-browser EdgeVec hybrid retrieval over the local RAG index. */
export async function queryRag(
  folderId: string,
  question: string,
  topK?: number,
): Promise<RetrievedChunk[]> {
  throw new Error(
    "engine: queryRag is not available — the real @xberg-io/wasm-pipeline package is required at runtime.",
  );
}
