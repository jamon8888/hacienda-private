import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { PiiEntity, RetrievedChunk } from "@xberg-io/core";
import { AppError } from "./error.js";

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
  index: number[];
  vault: number[];
  pii: MirrorPiiSpan[];
  chunks: MirrorChunk[];
}

export interface MirrorStatus {
  matter_id: string;
  synced_at: string | null;
  bytes: number;
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

  private indexPath(matterId: string): string {
    return `${this.mirrorsDir}/${encodeURIComponent(matterId)}.bin`;
  }

  private vaultPath(matterId: string): string {
    return `${this.mirrorsDir}/${encodeURIComponent(matterId)}.vault.bin`;
  }

  private metaPath(matterId: string): string {
    return `${this.mirrorsDir}/${encodeURIComponent(matterId)}.json`;
  }

  // The full JSON MirrorBundle, kept at its own path so it survives loadMirror() overwriting
  // indexPath() with the raw (non-JSON) EdgeVec index bytes — see getBundle().
  private bundlePath(matterId: string): string {
    return `${this.mirrorsDir}/${encodeURIComponent(matterId)}.bundle.json`;
  }

  saveMirror(matterId: string, body: Buffer): MirrorStatus {
    if (!matterId) {
      throw new AppError("bad_request", "matter_id is required");
    }
    if (body.length === 0) {
      throw new AppError("bad_request", "mirror payload is empty");
    }
    mkdirSync(dirname(this.indexPath(matterId)), { recursive: true });
    const syncedAt = new Date().toISOString();
    writeFileSync(this.indexPath(matterId), body);
    writeFileSync(this.bundlePath(matterId), body);
    writeFileSync(this.metaPath(matterId), JSON.stringify({ matter_id: matterId, synced_at: syncedAt }));
    // A re-save must not leave listPii/retrieve/loadCipher serving the previous bundle.
    this.bundles.delete(matterId);
    return { matter_id: matterId, synced_at: syncedAt, bytes: body.length };
  }

  status(matterId: string): MirrorStatus | null {
    const meta = this.metaPath(matterId);
    if (!existsSync(meta)) return null;
    const raw = JSON.parse(readFileSync(meta, "utf8")) as { matter_id: string; synced_at: string };
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
      (parsed as MirrorBundle).version !== 1 ||
      !Array.isArray((parsed as MirrorBundle).index) ||
      !Array.isArray((parsed as MirrorBundle).vault) ||
      !Array.isArray((parsed as MirrorBundle).pii) ||
      !Array.isArray((parsed as MirrorBundle).chunks)
    ) {
      throw new AppError("store", `mirror for matter ${matterId} has an unexpected bundle shape`);
    }
    return parsed as MirrorBundle;
  }

  async loadMirror(matterId: string): Promise<LoadedMirror> {
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
    this.bundles.delete(matterId);
    for (const p of [
      this.indexPath(matterId),
      this.vaultPath(matterId),
      this.metaPath(matterId),
      this.bundlePath(matterId),
    ]) {
      if (existsSync(p)) {
        unlinkSync(p);
      }
    }
  }
}

export function generateMirrorId(): string {
  return randomUUID();
}
