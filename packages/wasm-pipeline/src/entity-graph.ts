import { detectGliner2 } from "./gliner2";

// One extracted legal entity, with provenance back to its exact source span.
export interface GraphNode {
  id: string;
  // Normalized entity type (e.g. "societe", "dirigeant") — see DROIT_DES_AFFAIRES_LABELS.
  type: string;
  // The real surface text (e.g. "SASU Dupont Conseil") — this graph is a lawyer-facing
  // analytical artifact, sealed the same way the PII vault is, never the redacted/tokenized form.
  label: string;
  attrs: Record<string, string>;
  docId: string;
  chunkIndex: number;
  // Chunk-local character offsets — the exact coordinate system PiiMarkdownEditor (PR #39) already
  // uses to highlight spans in the reconstructed original text, not a new addressing scheme.
  start: number;
  end: number;
}

export interface GraphEdge {
  id: string;
  type: string;
  from: string; // GraphNode.id
  to: string; // GraphNode.id
  docId: string;
  chunkIndex: number;
}

export interface EntityGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Droit des affaires (Phase A) entity schema — a flat label list, per GLiNER2's schema-prompt
 * grammar (crates/xberg-gliner/src/v2/preprocess.rs only supports one flat "entities" task, no
 * relation/triple template — confirmed via the architecture investigation this plan is based on).
 * Deliberately prompt-only for the first cut, no LoRA adapter — see the plan's go/no-go checkpoint:
 * only invest in an adapter if real-text accuracy on this vocabulary proves insufficient.
 */
export const DROIT_DES_AFFAIRES_LABELS = [
  "société",
  "dirigeant",
  "actionnaire",
  "capital social",
  "SIREN",
  "forme juridique",
  "organe de gouvernance",
  "commissaire aux comptes",
  "opération",
] as const;

function normalizeType(kind: string): string {
  return kind
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics (société -> societe) for a stable type key
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Canonicalize a label for entity-dedup comparison: trim, collapse whitespace, casefold. This is
 * deliberately the ONLY canonicalization strategy in this first cut — exact-normalized-match only,
 * per the plan's honest risk assessment. Fuzzy matching (abbreviations, legal-form suffixes like
 * SAS/SASU, SIREN-as-anchor-ID) is explicitly deferred until real documents prove it's needed.
 */
function canonicalKey(type: string, label: string): string {
  return `${type}::${label.trim().replace(/\s+/g, " ").toLowerCase()}`;
}

/**
 * Very small, deliberately minimal rule set for the droit des affaires vertical — pattern-matching
 * over entity spans that co-occur in the same sentence-ish window. This is a first cut meant to be
 * extended against real fixture text, not a finished design (see the plan's honest risk
 * assessment); low recall on real documents is an expected starting point, not a bug to silence.
 */
function inferRelations(nodes: GraphNode[], text: string, docId: string, chunkIndex: number): GraphEdge[] {
  const edges: GraphEdge[] = [];
  let edgeCounter = 0;

  const dirigeants = nodes.filter((n) => n.type === "dirigeant");
  const societes = nodes.filter((n) => n.type === "societe");
  const actionnaires = nodes.filter((n) => n.type === "actionnaire");

  // "<dirigeant>, gérant/président/... de <société>" — the dirigeant mention immediately precedes
  // the société mention, separated only by a short connective phrase (no sentence boundary between).
  for (const d of dirigeants) {
    for (const s of societes) {
      if (d.end > s.start) continue; // société must follow the dirigeant mention
      const between = text.slice(d.end, s.start);
      if (between.length > 60) continue; // not the same clause
      if (/\bde\b/i.test(between)) {
        edges.push({ id: `e${edgeCounter++}`, type: "dirige", from: d.id, to: s.id, docId, chunkIndex });
      }
    }
  }

  // "<actionnaire> détient ... % ... <société>" — same co-occurrence-window heuristic.
  for (const a of actionnaires) {
    for (const s of societes) {
      if (a.end > s.start) continue;
      const between = text.slice(a.end, s.start);
      if (between.length > 80) continue;
      if (/d[ée]tient|actionnaire de|associ[ée] de/i.test(between)) {
        edges.push({ id: `e${edgeCounter++}`, type: "detient", from: a.id, to: s.id, docId, chunkIndex });
      }
    }
  }

  return edges;
}

/**
 * Extract a droit-des-affaires entity graph from one chunk's RAW (pre-redaction) text — must run
 * at the same point buildRedaction does, while the real text is still in memory, since this graph
 * needs real entity values to be useful to a lawyer (unlike the tokenized RAG path).
 */
export async function extractEntityGraph(
  text: string,
  docId: string,
  chunkIndex: number,
  labels: readonly string[] = DROIT_DES_AFFAIRES_LABELS,
): Promise<EntityGraph> {
  const spans = await detectGliner2(text, labels);

  const rawNodes: GraphNode[] = spans.map((span, i) => ({
    id: `${docId}:C${chunkIndex}:${i}`,
    type: normalizeType(span.kind),
    label: span.text,
    attrs: {},
    docId,
    chunkIndex,
    start: span.start,
    end: span.end,
  }));

  // Relation inference runs on each mention's own real position, BEFORE canonicalization merges
  // duplicate mentions into one node below — otherwise a later mention's proximity to an entity
  // would incorrectly be tested against an earlier, unrelated occurrence's position instead of its
  // own.
  const rawEdges = inferRelations(rawNodes, text, docId, chunkIndex);

  // Exact-normalized-match canonicalization: merge duplicate mentions into one node (first mention
  // wins), remapping any edge endpoint that pointed at a since-merged duplicate.
  const canonicalIdByRawId = new Map<string, string>();
  const seen = new Map<string, GraphNode>();
  const nodes: GraphNode[] = [];
  for (const node of rawNodes) {
    const key = canonicalKey(node.type, node.label);
    const existing = seen.get(key);
    if (existing) {
      canonicalIdByRawId.set(node.id, existing.id);
      continue;
    }
    seen.set(key, node);
    canonicalIdByRawId.set(node.id, node.id);
    nodes.push(node);
  }

  const edges = rawEdges.map((e) => ({
    ...e,
    from: canonicalIdByRawId.get(e.from) ?? e.from,
    to: canonicalIdByRawId.get(e.to) ?? e.to,
  }));

  return { nodes, edges };
}

/** Merge per-chunk graphs produced across a document's chunks into one. */
export function mergeEntityGraphs(graphs: EntityGraph[]): EntityGraph {
  return {
    nodes: graphs.flatMap((g) => g.nodes),
    edges: graphs.flatMap((g) => g.edges),
  };
}
