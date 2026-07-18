import type { Matter } from "@xberg-io/core";
import { API_BASE } from "./constants";

// The Plan 1 server (`services/mcp-server/src/mirror.ts`) stores the *entire raw request body* as
// the mirror payload: `saveMirror(matterId, await readBody(req))` writes `<matterId>.bin` +
// `<matterId>.json`. It reads `matter_id` from `req.url.searchParams` and does NOT parse multipart
// or read a `curtain_vault` field. Because the server stores the whole raw body as the index, the
// vault must be embedded inside that binary blob — we bundle index + vault into a single
// `MirrorBundle` and serialize it as JSON-wrapped binary so the server can later hand the blob back
// verbatim to `loadIndex` (Plan 4 cross-plan dependency).
/** A PII span in the mirror payload: token-only, optionally owner-decryptable. */
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

/** A redacted, citeable chunk carried in the mirror payload for server RAG. */
export interface MirrorChunk {
  doc_id: string;
  chunk_index: number;
  text: string; // redacted text
  page?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  score: number; // mirror-time relevance placeholder
  citation: string;
}

/** The complete mirror payload bundling index bytes, vault bytes, PII, and chunks. */
export interface MirrorBundle {
  version: 1;
  index: number[]; // raw EdgeVec bytes (browser uses)
  vault: number[]; // raw curtain-vault bytes (browser uses)
  pii: MirrorPiiSpan[]; // server answers list_pii from this
  chunks: MirrorChunk[]; // server answers rag_query from this (cited)
}

/**
 * Assemble a {@link MirrorBundle} from raw index/vault bytes and metadata.
 *
 * @param index - Serialized EdgeVec index bytes.
 * @param vault - Serialized curtain-vault bytes.
 * @param pii - PII spans (token-only) to mirror.
 * @param chunks - Redacted, citeable chunks to mirror.
 * @returns The versioned mirror bundle object.
 */
export function serializeMirror(
  index: Uint8Array,
  vault: Uint8Array,
  pii: MirrorPiiSpan[] = [],
  chunks: MirrorChunk[] = [],
): MirrorBundle {
  return {
    version: 1,
    index: Array.from(index),
    vault: Array.from(vault),
    pii,
    chunks,
  };
}

/**
 * Serialize a mirror bundle to UTF-8 JSON bytes for upload.
 *
 * @param index - Serialized EdgeVec index bytes.
 * @param vault - Serialized curtain-vault bytes.
 * @param pii - PII spans (token-only) to mirror.
 * @param chunks - Redacted, citeable chunks to mirror.
 * @returns The bundle encoded as a {@link Uint8Array}.
 */
export function serializeMirrorToBytes(
  index: Uint8Array,
  vault: Uint8Array,
  pii: MirrorPiiSpan[] = [],
  chunks: MirrorChunk[] = [],
): Uint8Array {
  const bundle = serializeMirror(index, vault, pii, chunks);
  return new TextEncoder().encode(JSON.stringify(bundle));
}

/**
 * Upload a serialized mirror payload to the Node service for a matter.
 *
 * @param matter - The matter the mirror belongs to.
 * @param payload - The serialized mirror bytes (see {@link serializeMirrorToBytes}).
 * @param scopeToken - Bearer scope token authorizing the mirror write.
 * @throws Error if the server responds with a non-OK status.
 */
export async function pushMirror(matter: Matter, payload: Uint8Array, scopeToken: string): Promise<void> {
  const res = await fetch(`${API_BASE}/rag/mirror?matter_id=${encodeURIComponent(matter.id)}`, {
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
