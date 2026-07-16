import type { Matter } from "@xberg-io/core";
import { API_BASE } from "./constants";

// The Plan 1 server (`services/mcp-server/src/mirror.ts`) stores the *entire raw request body* as
// the mirror payload: `saveMirror(matterId, await readBody(req))` writes `<matterId>.bin` +
// `<matterId>.json`. It reads `matter_id` from `req.url.searchParams` and does NOT parse multipart
// or read a `curtain_vault` field. Because the server stores the whole raw body as the index, the
// vault must be embedded inside that binary blob — we bundle index + vault into a single
// `MirrorBundle` and serialize it as JSON-wrapped binary so the server can later hand the blob back
// verbatim to `loadIndex` (Plan 4 cross-plan dependency).
export interface MirrorBundle {
  version: 1;
  index: number[];
  vault: number[];
}

export function serializeMirror(index: Uint8Array, vault: Uint8Array): MirrorBundle {
  return {
    version: 1,
    index: Array.from(index),
    vault: Array.from(vault),
  };
}

export function serializeMirrorToBytes(index: Uint8Array, vault: Uint8Array): Uint8Array {
  const bundle = serializeMirror(index, vault);
  return new TextEncoder().encode(JSON.stringify(bundle));
}

export async function pushMirror(
  matter: Matter,
  payload: Uint8Array,
  scopeToken: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/rag/mirror?matter_id=${encodeURIComponent(matter.id)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${scopeToken}`,
        "content-type": "application/octet-stream",
      },
      body: payload as unknown as BodyInit,
    },
  );
  if (!res.ok) {
    throw new Error(`mirror failed: ${res.status}`);
  }
}
