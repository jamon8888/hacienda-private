import type { BoundingBox } from "@xberg-io/core";

export interface CitationTarget {
  page?: number;
  bbox?: BoundingBox;
}

function parseBbox(raw: string | null): BoundingBox | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const { x, y, w, h } = v;
    if ([x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) {
      return { x: x as number, y: y as number, w: w as number, h: h as number };
    }
  } catch {
    /* malformed bbox param — ignore, viewer opens normally */
  }
  return undefined;
}

// Reads the citation deep-link params emitted by RetrievedChunkCard (`page`, `bbox`). Both are
// optional and independently validated; anything malformed is dropped so the viewer still opens.
export function parseCitationTarget(params: URLSearchParams | { get(k: string): string | null }): CitationTarget {
  const target: CitationTarget = {};
  const pageRaw = params.get("page");
  if (pageRaw !== null) {
    const page = Number(pageRaw);
    if (Number.isInteger(page) && page > 0) target.page = page;
  }
  const bbox = parseBbox(params.get("bbox"));
  if (bbox) target.bbox = bbox;
  return target;
}
