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
  // When set, drops this document's prior pii/chunks/vault entries before merging in `add` —
  // otherwise a re-review of an already-ingested document would duplicate it in the accumulator
  // (stale + corrected copies both present) instead of replacing it.
  replaceDocId?: string,
): Promise<MatterMirrorAccumulator> {
  const priorEntries = prior
    ? await openVault(
        { cipher: Uint8Array.from(prior.vaultCipher), salt: Uint8Array.from(prior.vaultSalt) },
        passphrase,
      )
    : [];
  // Vault entries sealed before this PR shipped have no `docId` of their own (it's a new,
  // optional field on RedactionEntry) — fall back to the doc_id already recorded on the matching
  // `prior.pii` span (by token) so a legacy entry can still be correctly evicted on replace
  // instead of being kept alongside its corrected copy forever. Tokens are chunk-scoped, not
  // document-scoped (two different documents' chunk-0 first PERSON span both mint
  // "{{C0_PERSON_1}}"), so only trust the backfill when a token maps to exactly one doc_id —
  // otherwise it's ambiguous and must be left alone rather than risk evicting the wrong document.
  const tokenDocIds = new Map<string, Set<string>>();
  for (const p of prior?.pii ?? []) {
    const set = tokenDocIds.get(p.token) ?? new Set<string>();
    set.add(p.doc_id);
    tokenDocIds.set(p.token, set);
  }
  const priorPiiDocIdByToken = new Map(
    [...tokenDocIds].filter(([, ids]) => ids.size === 1).map(([token, ids]) => [token, [...ids][0] as string]),
  );
  const keptEntries = replaceDocId
    ? priorEntries.filter((e) => (e.docId ?? priorPiiDocIdByToken.get(e.token)) !== replaceDocId)
    : priorEntries;
  const keptPii = replaceDocId ? (prior?.pii ?? []).filter((p) => p.doc_id !== replaceDocId) : (prior?.pii ?? []);
  const keptChunks = replaceDocId
    ? (prior?.chunks ?? []).filter((c) => c.doc_id !== replaceDocId)
    : (prior?.chunks ?? []);
  const sealed = await sealVault([...keptEntries, ...add.entries], passphrase);
  return {
    pii: [...keptPii, ...add.pii],
    chunks: [...keptChunks, ...add.chunks],
    vaultCipher: Array.from(sealed.cipher),
    vaultSalt: Array.from(sealed.salt),
  };
}
