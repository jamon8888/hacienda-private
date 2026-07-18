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

/** High-level chunker selection exposed to callers of {@link withChunking}. */
export type ChunkerKind = "text" | "markdown" | "yaml" | "semantic";

/** Options controlling how extracted document text is split into chunks. */
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

/**
 * Return the chunks already produced for an extracted document.
 *
 * @param doc - An extracted document.
 * @returns The document's chunks, or an empty array if it has none.
 */
export function chunkExtraction(doc: WasmExtractedDocument): WasmChunk[] {
  return doc.chunks ?? [];
}

/**
 * Attach a chunking configuration to an extraction config.
 *
 * @param base - The extraction config to mutate and return.
 * @param opts - Chunk sizing/overlap/strategy options.
 * @returns The same config with its `chunking` field populated.
 */
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

/**
 * Return the (1-based) first page a chunk originates from, if known.
 *
 * @param chunk - A WASM chunk.
 * @returns The chunk's first page number, or `undefined`.
 */
export function chunkPage(chunk: WasmChunk): number | undefined {
  return chunk.metadata.firstPage;
}

/**
 * Build a stable citation string for a chunk within a document.
 *
 * @param docId - The owning document identifier.
 * @param chunk - The chunk to cite.
 * @returns A citation of the form `"<docId>#chunk-<index>"`.
 */
export function chunkCitation(docId: string, chunk: WasmChunk): string {
  return `${docId}#chunk-${chunk.metadata.chunkIndex}`;
}

// Map a wasm bounding box (x0,y0,x1,y1 corner coords) to the shared core
// `BoundingBox` (x,y top-left + width/height) shape used by `RetrievedChunk`.
/**
 * Convert a WASM corner-based bounding box to the shared core `BoundingBox`.
 *
 * @param box - A WASM bounding box with `x0,y0,x1,y1` corners.
 * @returns A core `BoundingBox` with top-left origin plus width/height.
 */
export function toBoundingBox(box: WasmBoundingBox): BoundingBox {
  const x = box.x0;
  const y = box.y0;
  return { x, y, w: box.x1 - x, h: box.y1 - y };
}

// Resolve a representative bounding box for a chunk. xberg's `WasmChunkMetadata`
// does not carry a bbox, but the document structure (`doc.document.nodes`) exposes
// `WasmDocumentNode`s with `bbox` + `page`. We pick the first node on the chunk's
// page that has a bbox, using that as the chunk's spatial anchor.
/**
 * Resolve a representative bounding box for a chunk from the document structure.
 *
 * Chunk metadata carries no bbox, so this scans `doc.document.nodes` for the
 * first node on the chunk's page that has one.
 *
 * @param doc - The extracted document (source of structure nodes).
 * @param chunk - The chunk to locate spatially.
 * @returns The anchoring `BoundingBox`, or `undefined` if none is found.
 */
export function chunkBoundingBox(
  doc: WasmExtractedDocument,
  chunk: WasmChunk,
): BoundingBox | undefined {
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

