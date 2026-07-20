import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AuthScopes,
  ConsentGrant,
  ConsentRecord,
  Document,
  DocumentPiiEntity,
  Folder,
  FolderStatus,
  IngestSource,
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
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  matter_id TEXT NOT NULL REFERENCES matters(id),
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  pii_count INTEGER NOT NULL DEFAULT 0,
  ingested_via TEXT NOT NULL,
  error_message TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_hash ON documents(folder_id, content_hash);
CREATE TABLE IF NOT EXISTS document_pii (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  kind TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  text TEXT NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_document_pii_document ON document_pii(document_id);
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

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// `CREATE UNIQUE INDEX IF NOT EXISTS` is a no-op against an existing dev database whose
// same-named index was created non-unique by an older schema version — SQLite's IF NOT EXISTS
// checks the name, not the definition. Drop and recreate it as unique if it isn't already, so
// the dedupe-by-hash guarantee (idx_documents_hash) is actually enforced on upgrade, not just
// on a fresh database.
function ensureUniqueIndex(db: Database.Database, indexName: string, createUniqueSql: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName) as
    | { sql: string | null }
    | undefined;
  if (row && row.sql && !/UNIQUE/i.test(row.sql)) {
    db.exec(`DROP INDEX ${indexName}`);
    try {
      db.exec(createUniqueSql);
    } catch {
      // A dev database from before this constraint existed may already hold duplicate
      // (folder_id, content_hash) rows — don't crash store construction over it; leave the
      // index absent rather than half-applied. Fresh databases never hit this path.
    }
  }
}

export class MetadataStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    ensureColumn(this.db, "folders", "status", "TEXT NOT NULL DEFAULT 'pending'");
    ensureColumn(this.db, "folders", "last_ingested_at", "TEXT NULL");
    ensureUniqueIndex(
      this.db,
      "idx_documents_hash",
      "CREATE UNIQUE INDEX idx_documents_hash ON documents(folder_id, content_hash)",
    );
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
    return this.db.prepare("SELECT id, name, created_at FROM matters WHERE id = ?").get(id) as Matter | undefined;
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
      status: "pending",
      document_count: 0,
      pii_count: 0,
    };
    this.db
      .prepare("INSERT INTO folders (id, matter_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(folder.id, folder.matter_id, folder.name, folder.path ?? null, new Date().toISOString());
    return folder;
  }

  getFolders(matterId: string): Folder[] {
    return this.db
      .prepare(
        `SELECT f.id, f.matter_id, f.name, f.path, f.status, f.last_ingested_at,
                COUNT(d.id) AS document_count,
                COALESCE(SUM(d.pii_count), 0) AS pii_count
         FROM folders f
         LEFT JOIN documents d ON d.folder_id = f.id
         WHERE f.matter_id = ?
         GROUP BY f.id
         ORDER BY f.name`,
      )
      .all(matterId) as Folder[];
  }

  getFolder(id: string): Folder | undefined {
    return this.db
      .prepare(
        `SELECT f.id, f.matter_id, f.name, f.path, f.status, f.last_ingested_at,
                COUNT(d.id) AS document_count,
                COALESCE(SUM(d.pii_count), 0) AS pii_count
         FROM folders f
         LEFT JOIN documents d ON d.folder_id = f.id
         WHERE f.id = ?
         GROUP BY f.id`,
      )
      .get(id) as Folder | undefined;
  }

  createDocument(input: {
    folder_id: string;
    matter_id: string;
    path: string;
    content_hash: string;
    ingested_via: IngestSource;
  }): Document {
    if (!this.getFolder(input.folder_id)) {
      throw new AppError("not_found", `folder ${input.folder_id} not found`);
    }
    const doc: Document = {
      id: randomUUID(),
      folder_id: input.folder_id,
      matter_id: input.matter_id,
      path: input.path,
      content_hash: input.content_hash,
      status: "processing",
      pages: 0,
      chunk_count: 0,
      pii_count: 0,
      ingested_via: input.ingested_via,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO documents
         (id, folder_id, matter_id, path, content_hash, status, pages, chunk_count, pii_count, ingested_via, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        doc.id,
        doc.folder_id,
        doc.matter_id,
        doc.path,
        doc.content_hash,
        doc.status,
        doc.pages,
        doc.chunk_count,
        doc.pii_count,
        doc.ingested_via,
        doc.created_at,
      );
    return doc;
  }

  findDocumentByHash(folderId: string, contentHash: string): Document | undefined {
    return this.db
      .prepare(
        `SELECT id, folder_id, matter_id, path, content_hash, status, pages, chunk_count, pii_count, ingested_via, error_message, created_at
         FROM documents WHERE folder_id = ? AND content_hash = ?`,
      )
      .get(folderId, contentHash) as Document | undefined;
  }

  getDocument(id: string): Document | undefined {
    return this.db
      .prepare(
        `SELECT id, folder_id, matter_id, path, content_hash, status, pages, chunk_count, pii_count, ingested_via, error_message, created_at
         FROM documents WHERE id = ?`,
      )
      .get(id) as Document | undefined;
  }

  updateDocumentStatus(
    id: string,
    status: FolderStatus,
    fields: { pages?: number; chunk_count?: number; pii_count?: number; error_message?: string } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE documents SET status = ?, pages = COALESCE(?, pages), chunk_count = COALESCE(?, chunk_count),
         pii_count = COALESCE(?, pii_count), error_message = ? WHERE id = ?`,
      )
      .run(
        status,
        fields.pages ?? null,
        fields.chunk_count ?? null,
        fields.pii_count ?? null,
        fields.error_message ?? null,
        id,
      );
  }

  getDocumentsByFolder(folderId: string): Document[] {
    return this.db
      .prepare(
        `SELECT id, folder_id, matter_id, path, content_hash, status, pages, chunk_count, pii_count, ingested_via, error_message, created_at
         FROM documents WHERE folder_id = ? ORDER BY created_at`,
      )
      .all(folderId) as Document[];
  }

  insertPiiEntities(
    documentId: string,
    entities: { kind: string; start: number; end: number; text: string }[],
  ): DocumentPiiEntity[] {
    const insert = this.db.prepare(
      "INSERT INTO document_pii (id, document_id, kind, start_offset, end_offset, text, reviewed) VALUES (?, ?, ?, ?, ?, ?, 0)",
    );
    const insertAll = this.db.transaction((rows: typeof entities) => {
      const out: DocumentPiiEntity[] = [];
      for (const row of rows) {
        const id = randomUUID();
        insert.run(id, documentId, row.kind, row.start, row.end, row.text);
        out.push({
          id,
          document_id: documentId,
          kind: row.kind,
          start: row.start,
          end: row.end,
          text: row.text,
          reviewed: false,
        });
      }
      return out;
    });
    return insertAll(entities);
  }

  getPiiByDocument(documentId: string): DocumentPiiEntity[] {
    const rows = this.db
      .prepare(
        "SELECT id, document_id, kind, start_offset AS start, end_offset AS end, text, reviewed FROM document_pii WHERE document_id = ? ORDER BY start_offset",
      )
      .all(documentId) as (Omit<DocumentPiiEntity, "reviewed"> & { reviewed: number })[];
    return rows.map((r) => ({ ...r, reviewed: r.reviewed === 1 }));
  }

  updateFolderStatus(folderId: string, status: FolderStatus): void {
    this.db
      .prepare("UPDATE folders SET status = ?, last_ingested_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), folderId);
  }

  recordIngest(folderId: string, matterId: string): { folder_id: string; matter_id: string; recorded_at: string } {
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
      .prepare("INSERT INTO redactions (id, doc_id, matter_id, entity_ids, recorded_at) VALUES (?, ?, ?, ?, ?)")
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
      .prepare("INSERT INTO consent (id, subject, matter_id, scope, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
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
      .prepare("SELECT expires_at FROM consent WHERE subject = ? AND matter_id = ? AND scope = ?")
      .all(subject, matterId, scope) as { expires_at: string | null }[];
    return rows.some((r) => r.expires_at === null || new Date(r.expires_at).getTime() > now);
  }

  recordAudit(actor: string, scope: AuthScopes, action: string, matterId: string): void {
    this.db
      .prepare("INSERT INTO audit_log (id, actor, scope, action, matter_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
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

  forgetMatter(matterId: string): {
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
