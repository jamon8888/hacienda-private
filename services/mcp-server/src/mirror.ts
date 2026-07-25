import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PiiEntity, RetrievedChunk } from "@xberg-io/core";
import { AppError } from "./error.js";

export const SHARED_EMBEDDING_IDENTITY =
  "ibm-granite/granite-embedding-97m-multilingual-r2@835ad14087e140460703cf0fae09f97d469d65c2;bf16->f32;modernbert-384;cls;normalize=true";

// Wire format written by the browser engine (`@xberg-io/wasm-pipeline` `serializeMirrorToBytes`):
// a JSON `MirrorBundle` wrapping the raw EdgeVec index bytes + the curtain-privacy vault bytes plus
// the light metadata the server needs to answer MCP tools without running any engine: PII spans
// (tokens, never plaintext) and the last-mirrored cited chunks. The server NEVER imports edgevec —
// the browser owns live retrieval/rehydration; the server serves from this stored metadata.
interface MirrorPiiSpan {
  doc_id: string;
  kind: string;
  start: number;
  end: number;
  token: string;
  ciphertext?: string;
}

interface MirrorChunk {
  doc_id: string;
  chunk_index: number;
  text: string;
  page?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  score: number;
  citation: string;
}

interface MirrorBundle {
  version: number;
  embedding_identity: string;
  index: number[];
  vault: number[];
  vaultSalt: number[];
  pii: MirrorPiiSpan[];
  chunks: MirrorChunk[];
}

export interface MirrorStatus {
  matter_id: string;
  synced_at: string | null;
  bytes: number;
}

export interface MirrorPiiSpanInput {
  doc_id: string;
  kind: string;
  start: number;
  end: number;
  token: string;
  ciphertext?: string;
}

export interface MirrorChunkInput {
  doc_id: string;
  chunk_index: number;
  text: string;
  page?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  score: number;
  citation: string;
}

export interface LoadedMirror {
  matter_id: string;
  bytes: number;
  loaded: boolean;
  reason?: string;
}

export class MirrorStore {
  // Parsed bundles kept in memory keyed by matterId so listPii/retrieve/loadCipher can read
  // metadata without re-parsing the on-disk bundle every call.
  private readonly bundles = new Map<string, MirrorBundle>();

  constructor(private readonly mirrorsDir: string) {
    mkdirSync(mirrorsDir, { recursive: true });
  }

  private validateMatterId(matterId: string): void {
    if (matterId === "" || matterId === "." || matterId === "..") {
      throw new AppError("bad_request", "matter_id must not be empty, '.' or '..'");
    }
  }

  // Every matter's mirror files live under one directory, so a re-save can swap the whole
  // directory in with a single atomic rename (see saveMirror) instead of writing 3 files
  // independently, which could leave a crash-torn mix of old/new files on disk.
  private matterDir(matterId: string): string {
    this.validateMatterId(matterId);
    return `${this.mirrorsDir}/${encodeURIComponent(matterId)}`;
  }

  private indexPath(matterId: string): string {
    return `${this.matterDir(matterId)}/index.bin`;
  }

  private vaultPath(matterId: string): string {
    return `${this.matterDir(matterId)}/vault.bin`;
  }

  private metaPath(matterId: string): string {
    return `${this.matterDir(matterId)}/meta.json`;
  }

  // The full JSON MirrorBundle, kept at its own path so it survives loadMirror() overwriting
  // indexPath() with the raw (non-JSON) EdgeVec index bytes — see getBundle().
  private bundlePath(matterId: string): string {
    return `${this.matterDir(matterId)}/bundle.json`;
  }

  // Atomic (crash-safe) mirror write: stage all 3 files in a temp directory, then swap it into
  // place with directory renames, which POSIX guarantees are atomic on the same filesystem. A
  // crash never leaves a torn mix of old/new files — either the previous mirror is intact, or
  // the new one is, in full. On re-save there's a sub-millisecond window between moving the old
  // directory aside and moving the new one in; a crash exactly there leaves the mirror
  // temporarily absent (never corrupted) until the next ingest — an accepted, documented
  // residual risk for this single-owner deployment.
  saveMirror(matterId: string, body: Buffer): MirrorStatus {
    this.validateMatterId(matterId);
    if (body.length === 0) {
      throw new AppError("bad_request", "mirror payload is empty");
    }
    const syncedAt = new Date().toISOString();
    const staging = `${this.mirrorsDir}/${encodeURIComponent(matterId)}.staging-${randomUUID()}`;
    mkdirSync(staging, { recursive: true });
    writeFileSync(`${staging}/index.bin`, body);
    writeFileSync(`${staging}/bundle.json`, body);
    writeFileSync(`${staging}/meta.json`, JSON.stringify({ matter_id: matterId, synced_at: syncedAt }));

    const finalDir = this.matterDir(matterId);
    if (existsSync(finalDir)) {
      const stale = `${this.mirrorsDir}/${encodeURIComponent(matterId)}.stale-${randomUUID()}`;
      renameSync(finalDir, stale);
      renameSync(staging, finalDir);
      // Best-effort cleanup: the swap above already completed, so a failure here doesn't
      // affect correctness, only leaves a harmless orphaned directory behind.
      try {
        rmSync(stale, { recursive: true, force: true });
      } catch {
        /* not correctness-critical */
      }
    } else {
      renameSync(staging, finalDir);
    }

    // A re-save must not leave listPii/retrieve/loadCipher serving the previous bundle.
    this.bundles.delete(matterId);
    return { matter_id: matterId, synced_at: syncedAt, bytes: body.length };
  }

  // Merges one document's PII spans/chunks into a matter's existing bundle (or starts an empty
  // one) and re-saves via saveMirror. index/vault are deliberately left untouched — those are
  // browser-owned EdgeVec/curtain-privacy bytes this Node-side code never constructs (see the
  // "server NEVER imports edgevec" note above).
  appendMirror(matterId: string, additions: { pii: MirrorPiiSpanInput[]; chunks: MirrorChunkInput[] }): MirrorStatus {
    this.validateMatterId(matterId);
    const bundleFile = this.bundlePath(matterId);
    const existing: MirrorBundle = existsSync(bundleFile)
      ? this.parseBundle(matterId, readFileSync(bundleFile))
      : {
          version: 2,
          embedding_identity: SHARED_EMBEDDING_IDENTITY,
          index: [],
          vault: [],
          vaultSalt: [],
          pii: [],
          chunks: [],
        };

    const merged: MirrorBundle = {
      version: 2,
      embedding_identity: existing.embedding_identity,
      index: existing.index,
      vault: existing.vault,
      vaultSalt: existing.vaultSalt,
      pii: [...existing.pii, ...additions.pii],
      chunks: [...existing.chunks, ...additions.chunks],
    };

    return this.saveMirror(matterId, Buffer.from(JSON.stringify(merged), "utf8"));
  }

  status(matterId: string): MirrorStatus | null {
    this.validateMatterId(matterId);
    const meta = this.metaPath(matterId);
    if (!existsSync(meta)) return null;
    const raw = JSON.parse(readFileSync(meta, "utf8")) as {
      matter_id: string;
      synced_at: string;
    };
    const idx = this.indexPath(matterId);
    const bytes = existsSync(idx) ? readFileSync(idx).length : 0;
    return { matter_id: raw.matter_id, synced_at: raw.synced_at, bytes };
  }

  private parseBundle(matterId: string, bytes: Buffer): MirrorBundle {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new AppError("store", `mirror for matter ${matterId} is not a valid JSON MirrorBundle`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      (parsed as MirrorBundle).version !== 2 ||
      (parsed as MirrorBundle).embedding_identity !== SHARED_EMBEDDING_IDENTITY ||
      !Array.isArray((parsed as MirrorBundle).index) ||
      !Array.isArray((parsed as MirrorBundle).vault) ||
      !Array.isArray((parsed as MirrorBundle).vaultSalt) ||
      !Array.isArray((parsed as MirrorBundle).pii) ||
      !Array.isArray((parsed as MirrorBundle).chunks)
    ) {
      throw new AppError("store", `mirror for matter ${matterId} has an unexpected bundle shape`);
    }
    return parsed as MirrorBundle;
  }

  async loadMirror(matterId: string): Promise<LoadedMirror> {
    this.validateMatterId(matterId);
    const bundleFile = this.bundlePath(matterId);
    if (!existsSync(bundleFile)) {
      throw new AppError("not_found", `no mirror for matter ${matterId}`);
    }
    const bytes = readFileSync(bundleFile);
    try {
      const bundle = this.parseBundle(matterId, bytes);
      const indexBytes = Buffer.from(bundle.index);
      const vaultBytes = Buffer.from(bundle.vault);
      // Persist the raw index + vault bytes verbatim; the browser rehydrates the live EdgeVec
      // index from these. The server never loads them into any engine.
      writeFileSync(this.indexPath(matterId), indexBytes);
      writeFileSync(this.vaultPath(matterId), vaultBytes);
      this.bundles.set(matterId, bundle);
      return { matter_id: matterId, bytes: bytes.length, loaded: true };
    } catch (err) {
      if (err instanceof AppError && err.code === "not_found") {
        throw err;
      }
      return {
        matter_id: matterId,
        bytes: bytes.length,
        loaded: false,
        reason: err instanceof Error ? err.message : "mirror bundle parse failed",
      };
    }
  }

  private getBundle(matterId: string): MirrorBundle {
    const bundle = this.bundles.get(matterId);
    if (bundle) return bundle;
    const bundleFile = this.bundlePath(matterId);
    if (!existsSync(bundleFile)) {
      throw new AppError("not_found", `no mirror loaded for matter ${matterId}`);
    }
    const bundle2 = this.parseBundle(matterId, readFileSync(bundleFile));
    this.bundles.set(matterId, bundle2);
    return bundle2;
  }

  listPii(matterId: string, docId: string): PiiEntity[] {
    this.validateMatterId(matterId);
    const bundle = this.getBundle(matterId);
    return bundle.pii
      .filter((s) => s.doc_id === docId)
      .map((s) => {
        const entity: PiiEntity = {
          kind: s.kind,
          start: s.start,
          end: s.end,
          // token only — never the plaintext value.
          text: s.token,
        };
        if (s.ciphertext) {
          entity.ciphertext = new Uint8Array(Buffer.from(s.ciphertext, "base64"));
        }
        return entity;
      });
  }

  // True vector retrieval is browser-side; the server serves the last-mirrored cited chunks,
  // sorted by their mirror-time relevance placeholder score.
  retrieve(matterId: string, _query: string, topK = 8): RetrievedChunk[] {
    this.validateMatterId(matterId);
    const bundle = this.getBundle(matterId);
    return bundle.chunks
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((c) => {
        const chunk: RetrievedChunk = {
          doc_id: c.doc_id,
          chunk_index: c.chunk_index,
          text: c.text,
          score: c.score,
          citation: c.citation,
        };
        if (c.page !== undefined) chunk.page = c.page;
        if (c.bbox !== undefined) chunk.bbox = c.bbox;
        return chunk;
      });
  }

  loadCipher(matterId: string, chunkId: string): Uint8Array {
    this.validateMatterId(matterId);
    const bundle = this.getBundle(matterId);
    const sep = chunkId.lastIndexOf(":");
    if (sep <= 0) {
      throw new AppError("not_found", `invalid chunk id ${chunkId}`);
    }
    const docId = chunkId.slice(0, sep);
    const ref = chunkId.slice(sep + 1);

    const span = bundle.pii.find((s) => s.doc_id === docId && s.token === ref && s.ciphertext !== undefined);
    if (span?.ciphertext) {
      return new Uint8Array(Buffer.from(span.ciphertext, "base64"));
    }

    const asIndex = Number.parseInt(ref, 10);
    if (Number.isInteger(asIndex)) {
      const byIndex = bundle.pii.find((s) => s.doc_id === docId && s.start === asIndex && s.ciphertext !== undefined);
      if (byIndex?.ciphertext) {
        return new Uint8Array(Buffer.from(byIndex.ciphertext, "base64"));
      }
    }

    throw new AppError("not_found", `no ciphertext for chunk ${chunkId}`);
  }

  // Idempotent: a matter may legitimately have no mirror yet (never ingested), and the HTTP
  // DELETE flow already removes the matter's DB rows before calling this — throwing here would
  // leave that deletion half-applied and skip the audit entry that follows.
  forget(matterId: string): void {
    this.validateMatterId(matterId);
    this.bundles.delete(matterId);
    const dir = this.matterDir(matterId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function generateMirrorId(): string {
  return randomUUID();
}
