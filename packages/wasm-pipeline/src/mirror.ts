import { API_BASE } from "./constants";
import { graniteEmbeddingIdentity } from "./embed";

// The Plan 1 server (`services/mcp-server/src/mirror.ts`) stores the *entire raw request body* as
// the mirror payload: `saveMirror(matterId, await readBody(req))` writes `<matterId>.bin` +
// `<matterId>.json`. It reads `matter_id` from `req.url.searchParams` and does NOT parse multipart
// or read a `curtain_vault` field. Because the server stores the whole raw body as the index, the
// vault must be embedded inside that binary blob — we bundle index + vault into a single
// `MirrorBundle` and serialize it as JSON-wrapped binary so the server can later hand the blob back
// verbatim to `loadIndex` (Plan 4 cross-plan dependency).
export interface MirrorPiiSpan {
  doc_id: string;
  kind: string;
  start: number;
  end: number;
  // token only — NOT the plaintext value (privacy)
  token: string;
  // ciphertext present for owner-rehydratable spans (base64 string is fine)
  ciphertext?: string;
}

export interface MirrorChunk {
  doc_id: string;
  chunk_index: number;
  text: string; // redacted text
  page?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  score: number; // mirror-time relevance placeholder
  citation: string;
}

// Sealed entity-graph payload (packages/wasm-pipeline/src/entity-graph.ts's EntityGraph, sealed via
// redact.ts's sealPayload — same PBKDF2/AES-256-GCM scheme as `vault`/`vaultSalt`). Optional: only
// present once the entity-graph extraction pass is wired into ingestFolder. Unknown top-level keys
// are already ignored by the Rust legacy-bundle parser (crates/xberg-rag/src/legacy.rs's
// RawBundle/RawChunk only declare `version`/`chunks`), so adding this field needs no Rust change —
// it travels as an opaque blob until a future `graph_query` MCP tool decrypts it.
export interface MirrorGraph {
  cipher: number[];
  salt: number[];
}

export interface MirrorBundle {
  version: 2;
  embedding_identity: string;
  index: number[]; // raw EdgeVec bytes (browser uses)
  vault: number[]; // raw curtain-vault bytes (browser uses)
  // PBKDF2 salt used to seal `vault` (see redact.ts sealVault/openVault). Required to re-derive
  // the AES-GCM key from the passphrase later — without it the vault can never be opened again,
  // even with the correct passphrase.
  vaultSalt: number[];
  pii: MirrorPiiSpan[]; // server answers list_pii from this
  chunks: MirrorChunk[]; // server answers rag_query from this (cited)
  graph?: MirrorGraph;
}

export function serializeMirror(
  index: Uint8Array,
  vault: Uint8Array,
  vaultSalt: Uint8Array,
  pii: MirrorPiiSpan[] = [],
  chunks: MirrorChunk[] = [],
  graph?: MirrorGraph,
): MirrorBundle {
  return {
    version: 2,
    embedding_identity: graniteEmbeddingIdentity(),
    index: Array.from(index),
    vault: Array.from(vault),
    vaultSalt: Array.from(vaultSalt),
    pii,
    chunks,
    ...(graph ? { graph } : {}),
  };
}

export function serializeMirrorToBytes(
  index: Uint8Array,
  vault: Uint8Array,
  vaultSalt: Uint8Array,
  pii: MirrorPiiSpan[] = [],
  chunks: MirrorChunk[] = [],
  graph?: MirrorGraph,
): Uint8Array {
  const bundle = serializeMirror(index, vault, vaultSalt, pii, chunks, graph);
  return new TextEncoder().encode(JSON.stringify(bundle));
}

export async function pushMirror(matterId: string, payload: Uint8Array, scopeToken: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/rag/mirror?matter_id=${encodeURIComponent(matterId)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${scopeToken}`,
      "content-type": "application/octet-stream",
    },
    body: payload as unknown as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`mirror failed: ${res.status}`);
  }
}
