export {
  ingestFolder,
  extractDocumentForUi as extractDocument,
  queryRagForUi as queryRag,
  redactDocumentForUi as redactDocument,
  rehydrateSpanForUi,
  warmupModels,
  type ExtractedDocument,
  type IngestResult,
  type IngestProgress,
  type IngestContext,
  type WarmupProgress,
  type WarmupResult,
} from "./adapter";
