import type {
  WasmExtractedDocument,
  WasmChunk,
  WasmExtractionConfig,
  WasmChunkingConfig,
  WasmChunkerType,
} from "@xberg-io/xberg-wasm";
import type { XbergWasm } from "./runtime";
import { getWasm } from "./runtime";

export type ChunkerKind = "text" | "markdown" | "yaml" | "semantic";

export interface ChunkingOptions {
  maxCharacters?: number;
  overlap?: number;
  chunkerType?: ChunkerKind;
}

function mapChunker(m: XbergWasm, kind: ChunkerKind): WasmChunkerType {
  switch (kind) {
    case "markdown":
      return m.WasmChunkerType.Markdown;
    case "yaml":
      return m.WasmChunkerType.Yaml;
    case "semantic":
      return m.WasmChunkerType.Semantic;
    case "text":
    default:
      return m.WasmChunkerType.Text;
  }
}

export function chunkExtraction(doc: WasmExtractedDocument): WasmChunk[] {
  return doc.chunks ?? [];
}

export async function withChunking(
  base: WasmExtractionConfig,
  opts: ChunkingOptions = {},
): Promise<WasmExtractionConfig> {
  const m = await getWasm();
  const chunker = opts.chunkerType ? mapChunker(m, opts.chunkerType) : null;
  const cfg: WasmChunkingConfig = new m.WasmChunkingConfig(
    opts.maxCharacters ?? 1000,
    opts.overlap ?? 0,
    true,
    chunker,
    null,
    true,
    null,
    null,
    null,
    null,
  );
  base.chunking = cfg;
  return base;
}

export function chunkPage(chunk: WasmChunk): number | undefined {
  return chunk.metadata.firstPage;
}

export function chunkCitation(docId: string, chunk: WasmChunk): string {
  return `${docId}#chunk-${chunk.metadata.chunkIndex}`;
}
