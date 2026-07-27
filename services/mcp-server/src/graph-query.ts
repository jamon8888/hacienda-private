import Database from "better-sqlite3";
import { AppError } from "./error.js";
import { decryptBrowserVault } from "./graph-vault.js";

// Node-host mirror of crates/xberg/src/mcp/graph.rs's `imp` module, on better-sqlite3 instead of
// rusqlite. No sqlite-vec/embeddings involved — the entity graph is a small nodes/edges
// structure, so a plain in-memory connection and a recursive-CTE traversal are enough.

// One node/edge as sealed by packages/wasm-pipeline/src/entity-graph.ts's GraphNode/GraphEdge —
// this is TS-to-TS, so the camelCase field names line up directly with no remapping needed
// (unlike the Rust side's PlainNode/PlainEdge camelCase-to-snake_case bridge).
interface PlainNode {
  id: string;
  type: string;
  label: string;
  attrs?: Record<string, string>;
  docId: string;
  chunkIndex: number;
}

interface PlainEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  docId: string;
  chunkIndex: number;
}

interface PlainGraph {
  nodes: PlainNode[];
  edges: PlainEdge[];
}

export interface GraphNodeOutput {
  id: string;
  type: string;
  label: string;
  doc_id: string;
  chunk_index: number;
}

export interface GraphEdgeOutput {
  id: string;
  type: string;
  from: string;
  to: string;
  doc_id: string;
  chunk_index: number;
}

export interface GraphQueryOutput {
  nodes: GraphNodeOutput[];
  edges: GraphEdgeOutput[];
}

export interface GraphQueryOptions {
  nodeType?: string;
  labelContains?: string;
  fromLabel?: string;
  maxHops?: number;
  limit?: number;
}

function isPlainGraph(value: unknown): value is PlainGraph {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as PlainGraph).nodes) &&
    Array.isArray((value as PlainGraph).edges)
  );
}

// The main database is already :memory:, but SQLite's transient indices for UNION, DISTINCT, and
// ORDER BY (all used by the queries below) can still spill to a temp file on disk unless
// temp_store is forced to memory — decrypted node/edge data must never touch disk in any form.
// Same reasoning as graph.rs's build_graph_db.
function buildGraphDb(graph: PlainGraph): Database.Database {
  const db = new Database(":memory:");
  db.pragma("temp_store = MEMORY");
  db.exec(
    `CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL,
                          doc_id TEXT NOT NULL, chunk_index INTEGER NOT NULL);
     CREATE TABLE edges (id TEXT PRIMARY KEY, type TEXT NOT NULL,
                          from_id TEXT NOT NULL, to_id TEXT NOT NULL,
                          doc_id TEXT NOT NULL, chunk_index INTEGER NOT NULL);
     CREATE INDEX idx_edges_from ON edges(from_id);
     CREATE INDEX idx_edges_to ON edges(to_id);`,
  );

  const insertNode = db.prepare("INSERT INTO nodes (id, type, label, doc_id, chunk_index) VALUES (?, ?, ?, ?, ?)");
  for (const n of graph.nodes) {
    insertNode.run(n.id, n.type, n.label, n.docId, n.chunkIndex);
  }
  const insertEdge = db.prepare(
    "INSERT INTO edges (id, type, from_id, to_id, doc_id, chunk_index) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const e of graph.edges) {
    insertEdge.run(e.id, e.type, e.from, e.to, e.docId, e.chunkIndex);
  }
  return db;
}

interface NodeRow {
  id: string;
  type: string;
  label: string;
  doc_id: string;
  chunk_index: number;
}
interface EdgeRow {
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  doc_id: string;
  chunk_index: number;
}

function toNodeOutput(row: NodeRow): GraphNodeOutput {
  return { id: row.id, type: row.type, label: row.label, doc_id: row.doc_id, chunk_index: row.chunk_index };
}
function toEdgeOutput(row: EdgeRow): GraphEdgeOutput {
  return {
    id: row.id,
    type: row.type,
    from: row.from_id,
    to: row.to_id,
    doc_id: row.doc_id,
    chunk_index: row.chunk_index,
  };
}

// Traverse from the node whose label exactly matches fromLabel (case-insensitive) out to maxHops
// edges away, returning every reached node plus the edges connecting them.
function traverse(db: Database.Database, fromLabel: string, maxHops: number, limit: number): GraphQueryOutput {
  const nodes = db
    .prepare(
      `WITH RECURSIVE reachable(id, hops) AS (
         SELECT id, 0 FROM nodes WHERE lower(label) = lower(?)
         UNION
         SELECT CASE WHEN e.from_id = r.id THEN e.to_id ELSE e.from_id END, r.hops + 1
         FROM edges e JOIN reachable r ON e.from_id = r.id OR e.to_id = r.id
         WHERE r.hops < ?
       )
       SELECT DISTINCT n.id, n.type, n.label, n.doc_id, n.chunk_index
       FROM nodes n JOIN reachable r ON r.id = n.id
       LIMIT ?`,
    )
    .all(fromLabel, maxHops, limit) as NodeRow[];

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = (db.prepare("SELECT id, type, from_id, to_id, doc_id, chunk_index FROM edges").all() as EdgeRow[])
    .filter((e) => nodeIds.has(e.from_id) && nodeIds.has(e.to_id))
    .map(toEdgeOutput);

  return { nodes: nodes.map(toNodeOutput), edges };
}

// Filter nodes by exact type and/or a case-insensitive label substring. Returns no edges — a
// flat filter has no natural "which edges belong to this result set" answer the way a traversal
// does; callers wanting relations use fromLabel instead.
function filter(
  db: Database.Database,
  nodeType: string | undefined,
  labelContains: string | undefined,
  limit: number,
): GraphQueryOutput {
  const conditions: string[] = [];
  const sqlParams: (string | number)[] = [];
  if (nodeType !== undefined) {
    conditions.push("type = ?");
    sqlParams.push(nodeType);
  }
  if (labelContains !== undefined) {
    // instr(), not LIKE — LIKE treats % and _ as wildcards, so a literal search for e.g. "100%"
    // (a real capital-social figure) would match unrelated labels under LIKE.
    conditions.push("instr(lower(label), lower(?)) > 0");
    sqlParams.push(labelContains);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  sqlParams.push(limit);

  const nodes = db
    .prepare(`SELECT id, type, label, doc_id, chunk_index FROM nodes ${whereClause} LIMIT ?`)
    .all(...sqlParams) as NodeRow[];

  return { nodes: nodes.map(toNodeOutput), edges: [] };
}

/**
 * Decrypt the sealed entity graph, query it in an ephemeral in-memory SQLite database, and
 * discard everything at the end of the call — nothing decrypted is ever written to disk.
 */
export function queryGraph(
  sealed: { cipher: Uint8Array; salt: Uint8Array },
  passphrase: string,
  opts: GraphQueryOptions,
): GraphQueryOutput {
  if (!passphrase) {
    throw new AppError("bad_request", "passphrase must not be empty");
  }
  const plaintext = decryptBrowserVault(sealed.cipher, sealed.salt, passphrase);

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new AppError("store", "sealed entity graph payload is not valid JSON");
  }
  if (!isPlainGraph(parsed)) {
    throw new AppError("store", "sealed entity graph payload has an unexpected shape");
  }

  const db = buildGraphDb(parsed);
  try {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    if (opts.fromLabel !== undefined) {
      const maxHops = Math.min(Math.max(opts.maxHops ?? 2, 1), 6);
      return traverse(db, opts.fromLabel, maxHops, limit);
    }
    return filter(db, opts.nodeType, opts.labelContains, limit);
  } finally {
    db.close();
  }
}
