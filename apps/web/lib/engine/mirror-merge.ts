import { sealVault, openVault, type RedactionEntry } from "@xberg-io/wasm-pipeline-real";

export interface MirrorPiiSpan {
  doc_id: string;
  kind: string;
  start: number;
  end: number;
  token: string;
  ciphertext?: string;
}

export interface MirrorChunk {
  doc_id: string;
  chunk_index: number;
  text: string;
  page?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  score: number;
  citation: string;
}

// Per-matter cumulative mirror state kept in IndexedDB (idb-keyval). Tokenized only: `pii`/`chunks`
// carry redaction tokens, never plaintext, and the vault stays AES-GCM sealed at rest — merging a
// new document opens it in memory, appends, and reseals. This is the browser-owned source of truth
// the server can never reconstruct (it never imports edgevec and cannot reseal the vault).
export interface MatterMirrorAccumulator {
  pii: MirrorPiiSpan[];
  chunks: MirrorChunk[];
  vaultCipher: number[];
  vaultSalt: number[];
}

export function accumulatorKey(matterId: string): string {
  return `xberg:matter-mirror:${matterId}`;
}

export async function mergeIntoAccumulator(
  prior: MatterMirrorAccumulator | undefined,
  add: { entries: RedactionEntry[]; pii: MirrorPiiSpan[]; chunks: MirrorChunk[] },
  passphrase: string,
): Promise<MatterMirrorAccumulator> {
  const priorEntries = prior
    ? await openVault({ cipher: Uint8Array.from(prior.vaultCipher), salt: Uint8Array.from(prior.vaultSalt) }, passphrase)
    : [];
  const sealed = await sealVault([...priorEntries, ...add.entries], passphrase);
  return {
    pii: [...(prior?.pii ?? []), ...add.pii],
    chunks: [...(prior?.chunks ?? []), ...add.chunks],
    vaultCipher: Array.from(sealed.cipher),
    vaultSalt: Array.from(sealed.salt),
  };
}
