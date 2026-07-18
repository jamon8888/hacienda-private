import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AuthScopes,
  ConsentGrant,
  ConsentRecord,
  Folder,
  Matter,
} from "@xberg-io/core";
import { AppError } from "./error.js";

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
CREATE TABLE IF NOT EXISTS ingests (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS redactions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  entity_ids TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL
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

  getFolder(id: string): Folder | undefined {
    return this.db
      .prepare("SELECT id, matter_id, name, path FROM folders WHERE id = ?")
      .get(id) as Folder | undefined;
  }

  recordIngest(
    folderId: string,
    matterId: string,
  ): { folder_id: string; matter_id: string; recorded_at: string } {
    if (!this.getMatter(matterId)) {
      throw new AppError("not_found", `matter ${matterId} not found`);
    }
    const folder = this.getFolder(folderId);
    if (!folder) {
      throw new AppError("not_found", `folder ${folderId} not found`);
    }
    if (folder.matter_id !== matterId) {
      throw new AppError("bad_request", `folder ${folderId} does not belong to matter ${matterId}`);
    }
    const recordedAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO ingests (id, folder_id, matter_id, recorded_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), folderId, matterId, recordedAt);
    return { folder_id: folderId, matter_id: matterId, recorded_at: recordedAt };
  }

  recordRedaction(
    docId: string,
    matterId: string,
    entityIds: string[] = [],
  ): { doc_id: string; matter_id: string; entity_ids: string[]; recorded_at: string } {
    if (!this.getMatter(matterId)) {
      throw new AppError("not_found", `matter ${matterId} not found`);
    }
    const recordedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO redactions (id, doc_id, matter_id, entity_ids, recorded_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), docId, matterId, JSON.stringify(entityIds), recordedAt);
    return { doc_id: docId, matter_id: matterId, entity_ids: entityIds, recorded_at: recordedAt };
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

  recordAudit(actor: string, scope: AuthScopes, action: string, matterId: string): void {
    this.db
      .prepare(
        "INSERT INTO audit_log (id, actor, scope, action, matter_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), actor, scope, action, matterId, new Date().toISOString());
  }

  getAuditLog(matterId: string): {
    id: string;
    actor: string;
    scope: string;
    action: string;
    matter_id: string;
    recorded_at: string;
  }[] {
    return this.db
      .prepare(
        "SELECT id, actor, scope, action, matter_id, recorded_at FROM audit_log WHERE matter_id = ? ORDER BY recorded_at DESC",
      )
      .all(matterId) as {
      id: string;
      actor: string;
      scope: string;
      action: string;
      matter_id: string;
      recorded_at: string;
    }[];
  }

  forgetMatter(
    matterId: string,
  ): {
    matters: number;
    folders: number;
    consents: number;
    ingests: number;
    redactions: number;
    audits: number;
  } {
    if (!this.getMatter(matterId)) {
      throw new AppError("not_found", `matter ${matterId} not found`);
    }
    const r = (sql: string): number => this.db.prepare(sql).run(matterId).changes;
    // All-or-nothing: a mid-sequence failure must not leave the matter half-deleted.
    const forgetTxn = this.db.transaction((id: string) => {
      const folders = r("DELETE FROM folders WHERE matter_id = ?");
      const consents = r("DELETE FROM consent WHERE matter_id = ?");
      const ingests = r("DELETE FROM ingests WHERE matter_id = ?");
      const redactions = r("DELETE FROM redactions WHERE matter_id = ?");
      const audits = r("DELETE FROM audit_log WHERE matter_id = ?");
      const matters = this.db.prepare("DELETE FROM matters WHERE id = ?").run(id).changes;
      return { matters, folders, consents, ingests, redactions, audits };
    });
    return forgetTxn(matterId);
  }
}

export function openStore(dbPath: string): MetadataStore {
  if (!existsSync(dirname(dbPath))) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  return new MetadataStore(dbPath);
}
