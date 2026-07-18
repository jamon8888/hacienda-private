import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ConsentGrant,
  ConsentRecord,
  Folder,
  Matter,
} from "@xberg-io/core";
import { AppError } from "./error.js";

export interface AuditEntry {
  id: string;
  actor: string;
  scope: string;
  action: string;
  matter_id: string | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id),
  name TEXT NOT NULL,
  path TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consent (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  matter_id TEXT NULL,
  created_at TEXT NOT NULL
);
`;

export class MetadataStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createMatter(name: string): Matter {
    const matter: Matter = {
      id: randomUUID(),
      name,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO matters (id, name, created_at) VALUES (?, ?, ?)")
      .run(matter.id, matter.name, matter.created_at);
    return matter;
  }

  getMatters(): Matter[] {
    return this.db.prepare("SELECT id, name, created_at FROM matters ORDER BY created_at DESC").all() as Matter[];
  }

  getMatter(id: string): Matter | undefined {
    return this.db
      .prepare("SELECT id, name, created_at FROM matters WHERE id = ?")
      .get(id) as Matter | undefined;
  }

  createFolder(matterId: string, name: string, path?: string): Folder {
    if (!this.getMatter(matterId)) {
      throw new AppError("not_found", `matter ${matterId} not found`);
    }
    const folder: Folder = {
      id: randomUUID(),
      matter_id: matterId,
      name,
      path,
    };
    this.db
      .prepare("INSERT INTO folders (id, matter_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(folder.id, folder.matter_id, folder.name, folder.path ?? null, new Date().toISOString());
    return folder;
  }

  getFolders(matterId: string): Folder[] {
    return this.db
      .prepare("SELECT id, matter_id, name, path FROM folders WHERE matter_id = ? ORDER BY name")
      .all(matterId) as Folder[];
  }

  grantConsent(grant: ConsentGrant): ConsentRecord {
    const record: ConsentRecord = {
      id: randomUUID(),
      subject: grant.subject,
      matter_id: grant.matter_id,
      scope: grant.scope,
      granted_at: new Date().toISOString(),
      expires_at: grant.expires_at,
    };
    this.db
      .prepare(
        "INSERT INTO consent (id, subject, matter_id, scope, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(record.id, record.subject, record.matter_id, record.scope, record.granted_at, record.expires_at ?? null);
    return record;
  }

  getConsent(matterId: string): ConsentRecord[] {
    return this.db
      .prepare("SELECT id, subject, matter_id, scope, granted_at, expires_at FROM consent WHERE matter_id = ?")
      .all(matterId) as ConsentRecord[];
  }

  isConsentActive(subject: string, matterId: string, scope: string): boolean {
    const now = Date.now();
    const rows = this.db
      .prepare(
        "SELECT expires_at FROM consent WHERE subject = ? AND matter_id = ? AND scope = ?",
      )
      .all(subject, matterId, scope) as { expires_at: string | null }[];
    return rows.some((r) => r.expires_at === null || new Date(r.expires_at).getTime() > now);
  }

  recordAudit(actor: string, scope: string, action: string, matterId?: string): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      actor,
      scope,
      action,
      matter_id: matterId ?? null,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO audit_log (id, actor, scope, action, matter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.id, entry.actor, entry.scope, entry.action, entry.matter_id, entry.created_at);
    return entry;
  }

  getAudit(matterId?: string): AuditEntry[] {
    if (matterId) {
      return this.db
        .prepare("SELECT id, actor, scope, action, matter_id, created_at FROM audit_log WHERE matter_id = ? ORDER BY created_at DESC")
        .all(matterId) as AuditEntry[];
    }
    return this.db
      .prepare("SELECT id, actor, scope, action, matter_id, created_at FROM audit_log ORDER BY created_at DESC")
      .all() as AuditEntry[];
  }
}

export function openStore(dbPath: string): MetadataStore {
  if (!existsSync(dirname(dbPath))) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  return new MetadataStore(dbPath);
}
