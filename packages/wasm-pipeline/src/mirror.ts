import type { Matter } from "@xberg-io/core";
import { API_BASE } from "./constants";

export function buildMirrorFormData(
  matterId: string,
  index: Uint8Array | Blob,
  vault: Uint8Array,
): FormData {
  const fd = new FormData();
  fd.append("matter_id", matterId);
  const indexBlob = index instanceof Blob ? index : new Blob([index as unknown as BlobPart]);
  fd.append("index", indexBlob, `${matterId}.edgevec`);
  fd.append(
    "curtain_vault",
    new Blob([vault as unknown as BlobPart], { type: "application/octet-stream" }),
    `${matterId}.vault`,
  );
  return fd;
}

export async function pushMirror(
  matter: Matter,
  index: Uint8Array | Blob,
  vault: Uint8Array,
  scopeToken: string,
): Promise<void> {
  const fd = buildMirrorFormData(matter.id, index, vault);
  const res = await fetch(`${API_BASE}/rag/mirror`, {
    method: "POST",
    headers: { authorization: `Bearer ${scopeToken}` },
    body: fd,
  });
  if (!res.ok) {
    throw new Error(`mirror failed: ${res.status}`);
  }
}
