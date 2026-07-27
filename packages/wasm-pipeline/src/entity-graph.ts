import { detectGliner2 } from "./gliner2";
import { sealPayload, openPayload } from "./redact";
import type { MirrorGraph } from "./mirror";

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

/**
 * Droit commercial (Phase B) entity schema — same flat-label-list shape as Phase A, covering the
 * core building blocks of a commercial-law document (a business's ownership/operation of its
 * fonds de commerce, its commercial lease, its RCS registration) rather than the corporate-
 * governance concerns Phase A covers. Same go/no-go caveat as Phase A: prompt-only for this first
 * cut, real-text accuracy not yet validated (this sandbox can't run the real GLiNER2 model — see
 * fixtures/legal-fr/droit-commercial/README.md).
 */
export const DROIT_COMMERCIAL_LABELS = [
  "commerçant",
  "société commerciale",
  "fonds de commerce",
  "bail commercial",
  "immatriculation RCS",
  "contrat commercial",
  "clause de non-concurrence",
  "tribunal de commerce",
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
 * One relation-inference rule: a `from`-typed node followed (within `maxGap` characters, no
 * sentence boundary in between) by a `to`-typed node, with `connector` matching the text between
 * them, produces a `type`-typed edge. Deliberately minimal pattern-matching — a first cut meant to
 * be extended against real fixture text, not a finished design (see the plan's honest risk
 * assessment); low recall on real documents is an expected starting point, not a bug to silence.
 */
interface RelationRule {
  type: string;
  fromType: string;
  toType: string;
  connector: RegExp;
  maxGap: number;
}

// Droit des affaires (Phase A) relation rules.
const DROIT_DES_AFFAIRES_RULES: readonly RelationRule[] = [
  // "<dirigeant>, gérant/président/... de <société>" — the dirigeant mention immediately precedes
  // the société mention, separated only by a short connective phrase (no sentence boundary between).
  { type: "dirige", fromType: "dirigeant", toType: "societe", connector: /\bde\b/i, maxGap: 60 },
  // "<actionnaire> détient ... % ... <société>" — same co-occurrence-window heuristic.
  {
    type: "detient",
    fromType: "actionnaire",
    toType: "societe",
    connector: /d[ée]tient|actionnaire de|associ[ée] de/i,
    maxGap: 80,
  },
];

// Droit commercial (Phase B) relation rules, same fromType ("commercant") across all three since
// each captures a distinct thing a commerçant does: run a business, hold its lease, be registered.
export const DROIT_COMMERCIAL_RULES: readonly RelationRule[] = [
  // "<commerçant> exploite/est propriétaire du/gérant du <fonds de commerce>"
  {
    type: "exploite",
    fromType: "commercant",
    toType: "fonds_de_commerce",
    connector: /exploite|propri[ée]taire|g[ée]rant/i,
    maxGap: 60,
  },
  // "<commerçant> est titulaire d'un/locataire du/bénéficie d'un <bail commercial>"
  {
    type: "loue",
    fromType: "commercant",
    toType: "bail_commercial",
    connector: /titulaire|locataire|b[ée]n[ée]ficie/i,
    maxGap: 60,
  },
  // "<commerçant> est immatriculé ... sous le numéro d'<immatriculation RCS>"
  {
    type: "immatricule",
    fromType: "commercant",
    toType: "immatriculation_rcs",
    connector: /immatricul/i,
    maxGap: 80,
  },
];

/**
 * Applies a vertical's relation rules over entity spans that co-occur in the same sentence-ish
 * window, generalizing what was originally a droit-des-affaires-only inferRelations() into a
 * reusable engine now that a second vertical (droit commercial) needs the identical shape —
 * extracting this once two real call sites exist, not speculatively ahead of them.
 */
function inferRelationsFromRules(
  nodes: GraphNode[],
  text: string,
  docId: string,
  chunkIndex: number,
  rules: readonly RelationRule[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  let edgeCounter = 0;

  for (const rule of rules) {
    const froms = nodes.filter((n) => n.type === rule.fromType);
    const tos = nodes.filter((n) => n.type === rule.toType);
    for (const f of froms) {
      for (const t of tos) {
        if (f.end > t.start) continue; // "to" must follow the "from" mention
        const between = text.slice(f.end, t.start);
        if (between.length > rule.maxGap) continue; // not the same clause
        if (rule.connector.test(between)) {
          edges.push({ id: `e${edgeCounter++}`, type: rule.type, from: f.id, to: t.id, docId, chunkIndex });
        }
      }
    }
  }

  return edges;
}

/**
 * Extract an entity graph (droit des affaires by default, or another vertical via `labels`/
 * `relationRules` — see DROIT_COMMERCIAL_LABELS/DROIT_COMMERCIAL_RULES) from one chunk's RAW
 * (pre-redaction) text — must run at the same point buildRedaction does, while the real text is
 * still in memory, since this graph needs real entity values to be useful to a lawyer (unlike the
 * tokenized RAG path).
 */
export async function extractEntityGraph(
  text: string,
  docId: string,
  chunkIndex: number,
  labels: readonly string[] = DROIT_DES_AFFAIRES_LABELS,
  relationRules: readonly RelationRule[] = DROIT_DES_AFFAIRES_RULES,
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
  const rawEdges = inferRelationsFromRules(rawNodes, text, docId, chunkIndex, relationRules);

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

// Seals/opens an EntityGraph as a MirrorGraph (the number[]-based wire shape mirror.ts's
// MirrorBundle carries), centralizing the sealPayload/openPayload <-> Array.from/Uint8Array.from
// conversion so every caller that persists a sealed graph (this package's own ingestFolder, and
// apps/web's cumulative matter accumulator) shares one implementation instead of hand-rolling it.
export async function sealEntityGraph(graph: EntityGraph, passphrase: string): Promise<MirrorGraph> {
  const sealed = await sealPayload(graph, passphrase);
  return { cipher: Array.from(sealed.cipher), salt: Array.from(sealed.salt) };
}

export async function openEntityGraph(sealed: MirrorGraph, passphrase: string): Promise<EntityGraph> {
  return openPayload<EntityGraph>(
    { cipher: Uint8Array.from(sealed.cipher), salt: Uint8Array.from(sealed.salt) },
    passphrase,
  );
}
