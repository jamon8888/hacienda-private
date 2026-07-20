import type {
  WasmExtractedDocument,
  WasmChunk,
  WasmExtractionConfig,
  WasmChunkingConfig,
  WasmChunkerType,
  WasmBoundingBox,
} from "@xberg-io/xberg-wasm";
import type { XbergWasm } from "./runtime";
import { getWasm } from "./runtime";
import type { BoundingBox } from "@xberg-io/core";

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

// Map a wasm bounding box (x0,y0,x1,y1 corner coords) to the shared core
// `BoundingBox` (x,y top-left + width/height) shape used by `RetrievedChunk`.
export function toBoundingBox(box: WasmBoundingBox): BoundingBox {
  const x = box.x0;
  const y = box.y0;
  return { x, y, w: box.x1 - x, h: box.y1 - y };
}

// Resolve a representative bounding box for a chunk. xberg's `WasmChunkMetadata`
// does not carry a bbox, but the document structure (`doc.document.nodes`) exposes
// `WasmDocumentNode`s with `bbox` + `page`. We pick the first node on the chunk's
// page that has a bbox, using that as the chunk's spatial anchor.
export function chunkBoundingBox(doc: WasmExtractedDocument, chunk: WasmChunk): BoundingBox | undefined {
  const page = chunk.metadata.firstPage;
  const structure = doc.document;
  if (!structure) return undefined;
  const nodes = structure.nodes ?? [];
  for (const node of nodes) {
    if (page !== undefined && node.page !== page) continue;
    const box = node.bbox;
    if (box) return toBoundingBox(box);
  }
  return undefined;
}
