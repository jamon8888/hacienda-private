import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./error.js";

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
  constructor(private readonly mirrorsDir: string) {
    mkdirSync(mirrorsDir, { recursive: true });
  }

  private indexPath(matterId: string): string {
    return `${this.mirrorsDir}/${encodeURIComponent(matterId)}.bin`;
  }

  private metaPath(matterId: string): string {
    return `${this.mirrorsDir}/${encodeURIComponent(matterId)}.json`;
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
    writeFileSync(this.metaPath(matterId), JSON.stringify({ matter_id: matterId, synced_at: syncedAt }));
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

  async loadMirror(matterId: string): Promise<LoadedMirror> {
    const idx = this.indexPath(matterId);
    if (!existsSync(idx)) {
      throw new AppError("not_found", `no mirror for matter ${matterId}`);
    }
    const bytes = readFileSync(idx);
    try {
      const mod = await import("edgevec");
      if (typeof mod.init === "function") {
        await mod.init();
      }
      const ev = new mod.EdgeVec();
      await ev.loadFromSerialized(bytes);
      return { matter_id: matterId, bytes: bytes.length, loaded: true };
    } catch (err) {
      return {
        matter_id: matterId,
        bytes: bytes.length,
        loaded: false,
        reason: err instanceof Error ? err.message : "edgevec load unavailable",
      };
    }
  }
}

export function generateMirrorId(): string {
  return randomUUID();
}
