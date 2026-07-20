# MCP Folder Ingest + GLiNER Catalog Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ingest_folder` actually process a real folder on disk when called from Claude Desktop (extraction, chunking, embedding, GLiNER PII), persist both a human-reviewable output and a redacted/encrypted RAG output, and have the Web UI show the result as an ingested folder — while closing the two auth gaps found during design and consolidating Node-side GLiNER on the same pinned model catalog the Rust engine uses.

**Architecture:** A new `packages/node-pipeline` package runs extraction (`@xberg-io/xberg-wasm`), chunking, e5 embedding, and GLiNER PII detection inside the Node MCP server process, using `onnxruntime-web`'s WASM backend (not `onnxruntime-node` — see Deviation below) so it works identically on Windows/macOS/Linux with no native binary. `services/mcp-server` gains a `documents`/`document_pii` schema, a rewritten `ingest_folder` MCP tool that drives the pipeline, two new MCP tools (`list_matters`, `create_matter`), a per-launch REST bearer token, and non-admin-by-default MCP scopes. The Web UI polls existing/extended REST routes to show ingest status.

**Tech Stack:** TypeScript (Node 22, ESM), `better-sqlite3`, `onnxruntime-web` (WASM backend, run directly under Node), `gliner` npm package, `@xenova/transformers`, `@xberg-io/xberg-wasm`, `@modelcontextprotocol/sdk`, `zod`, `vitest`.

## Deviation from the approved spec

`docs/superpowers/specs/2026-07-18-mcp-folder-ingest-design.md` section B specifies
`onnxruntime-node` as the Node runtime. While planning the concrete GLiNER
integration, `packages/wasm-pipeline`'s existing `ner.ts` turned out to be built
against the `gliner` npm package's `IONNXWebSettings` type, which is
`onnxruntime-web`-specific — there is no evidence it supports swapping in
`onnxruntime-node`. Rather than write a new native GLiNER span-mode decoder from
scratch (a large, easy-to-get-subtly-wrong port of `crates/xberg-gliner/src/decode.rs`),
this plan reuses `onnxruntime-web`'s WASM execution provider directly under Node —
its `wasm` backend has no browser-DOM dependency and runs fine in plain Node,
which is how `packages/wasm-pipeline`'s own vitest suite already exercises it. This
is also a smaller, safer delta from the proven browser code, and it avoids adding a
third ONNX runtime family (`onnxruntime-node`) alongside `onnxruntime-web`
(browser + now Node) and native `ort` (Rust). The spec doc's section B has been
updated to match (see Task 0).

## Global Constraints

- Follow the repo's existing TDD/TypeScript conventions: `strict` + `noUncheckedIndexedAccess`, ESM, `vitest` for tests, no default exports.
- No new runtime dependency may require a native/platform-specific binary on Windows (this is the whole reason `onnxruntime-node`/native `ort` are out — see Deviation above). Clarified during Task 4 review: this means the *executed code path* must never invoke a Windows-broken native binary — it does not forbid a dependency (like `gliner`, which lists `onnxruntime-node` as a peer) from having an unused native package present in `node_modules`, as long as the code always configures it for the WASM backend and never touches the native one. `packages/wasm-pipeline` already carries this exact dependency set and installs/runs cleanly on Windows; `packages/node-pipeline` (Task 4+) intentionally mirrors it rather than re-litigating the same constraint per task.
- Every new SQLite column/table addition must be idempotent across repeated `MetadataStore` construction (existing dev databases must not break on upgrade).
- Every new `/api/*` route must go through the auth guard added in Task 11 — no route may bypass it.
- MCP tool scope checks must use the existing `authorize()`/`requireConsent()` helpers in `services/mcp-server/src/mcp/scopes.ts` / `consent.ts` — do not add a parallel authorization mechanism.

---

### Task 0: Reconcile the spec with the onnxruntime-web decision

**Files:**

- Modify: `docs/superpowers/specs/2026-07-18-mcp-folder-ingest-design.md`

- [ ] **Step 1: Update section B's runtime line**

Change:

```markdown
- **Runtime:** `onnxruntime-node` (Microsoft's prebuilt Node bindings — supported
  on Windows, unlike the Rust `ort` build). CPU execution provider only; no
  capability-detection needed since it's one fixed server machine.
```

to:

```markdown
- **Runtime:** `onnxruntime-web`'s WASM execution provider, run directly under
  Node (no browser DOM needed for the `wasm` backend — only `webgpu`/`webgl`
  require browser globals). Reuses the exact runtime `packages/wasm-pipeline`
  already proves works, just with local filesystem model access instead of
  `fetch`. CPU-only; no capability-detection needed since it's one fixed server
  machine, not arbitrary browser hardware.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-18-mcp-folder-ingest-design.md
git commit -m "docs(spec): switch Node GLiNER/embedding runtime to onnxruntime-web-under-Node"
```

---

## Group A — Data model

### Task 1: `documents` table + folder status columns

**Files:**

- Modify: `packages/core/src/types.ts`
- Modify: `services/mcp-server/src/store.ts`
- Test: `services/mcp-server/tests/store.documents.test.ts`

**Interfaces:**

- Produces: `Document` type, `MetadataStore.createDocument()`, `MetadataStore.findDocumentByHash()`, `MetadataStore.updateDocumentStatus()`, `MetadataStore.getDocumentsByFolder()`, `MetadataStore.getFolders()` (now returns aggregate counts).

- [ ] **Step 1: Extend shared types**

In `packages/core/src/types.ts`, change `Folder` and add `Document`:

```ts
export type FolderStatus = "pending" | "processing" | "done" | "error";

export interface Folder {
  id: string;
  matter_id: string;
  name: string;
  path?: string;
  status: FolderStatus;
  last_ingested_at?: string;
  document_count: number;
  pii_count: number;
}

export type IngestSource = "mcp" | "browser";

export interface Document {
  id: string;
  folder_id: string;
  matter_id: string;
  path: string;
  content_hash: string;
  status: FolderStatus;
  pages: number;
  chunk_count: number;
  pii_count: number;
  ingested_via: IngestSource;
  error_message?: string;
  created_at: string;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// services/mcp-server/tests/store.documents.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../src/store.js";

let dirs: string[] = [];
function makeStore(): MetadataStore {
  const dir = mkdtempSync(join(tmpdir(), "xberg-docs-"));
  dirs.push(dir);
  return new MetadataStore(join(dir, "meta.sqlite"));
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("documents", () => {
  it("creates a document and finds it by content hash", () => {
    const store = makeStore();
    const matter = store.createMatter("Acme v Doe");
    const folder = store.createFolder(matter.id, "Discovery", "/tmp/discovery");

    const doc = store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/discovery/a.txt",
      content_hash: "abc123",
      ingested_via: "mcp",
    });

    expect(doc.status).toBe("processing");
    expect(store.findDocumentByHash(folder.id, "abc123")?.id).toBe(doc.id);
    expect(store.findDocumentByHash(folder.id, "not-there")).toBeUndefined();
  });

  it("updates document status and rolls up into folder aggregates", () => {
    const store = makeStore();
    const matter = store.createMatter("Acme v Doe");
    const folder = store.createFolder(matter.id, "Discovery");
    const doc = store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/a.txt",
      content_hash: "h1",
      ingested_via: "mcp",
    });

    store.updateDocumentStatus(doc.id, "done", { pages: 3, chunk_count: 5, pii_count: 2 });
    store.updateFolderStatus(folder.id, "done");

    const folders = store.getFolders(matter.id);
    expect(folders).toHaveLength(1);
    expect(folders[0]?.status).toBe("done");
    expect(folders[0]?.document_count).toBe(1);
    expect(folders[0]?.pii_count).toBe(2);

    const docs = store.getDocumentsByFolder(folder.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.status).toBe("done");
    expect(docs[0]?.pages).toBe(3);
  });

  it("records an error status with a message", () => {
    const store = makeStore();
    const matter = store.createMatter("Acme v Doe");
    const folder = store.createFolder(matter.id, "Discovery");
    const doc = store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/bad.pdf",
      content_hash: "h2",
      ingested_via: "mcp",
    });

    store.updateDocumentStatus(doc.id, "error", { error_message: "corrupt PDF" });

    const docs = store.getDocumentsByFolder(folder.id);
    expect(docs[0]?.status).toBe("error");
    expect(docs[0]?.error_message).toBe("corrupt PDF");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/mcp-server test tests/store.documents.test.ts`
Expected: FAIL — `store.createDocument is not a function`.

- [ ] **Step 4: Implement schema + methods**

In `services/mcp-server/src/store.ts`, add to `SCHEMA` (after the `folders` table):

```sql
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
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(folder_id, content_hash);
```

Add a migration helper and call it in the constructor (existing `folders` table
predates `status`/`last_ingested_at`, and `ALTER TABLE ... ADD COLUMN` is not
idempotent, so guard it):

```ts
function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
```

In the constructor, after `this.db.exec(SCHEMA)`:

```ts
ensureColumn(this.db, "folders", "status", "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn(this.db, "folders", "last_ingested_at", "TEXT NULL");
```

Add methods (place near `createFolder`/`getFolders`):

```ts
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
    .run(doc.id, doc.folder_id, doc.matter_id, doc.path, doc.content_hash, doc.status, doc.pages, doc.chunk_count, doc.pii_count, doc.ingested_via, doc.created_at);
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
    .run(status, fields.pages ?? null, fields.chunk_count ?? null, fields.pii_count ?? null, fields.error_message ?? null, id);
}

getDocumentsByFolder(folderId: string): Document[] {
  return this.db
    .prepare(
      `SELECT id, folder_id, matter_id, path, content_hash, status, pages, chunk_count, pii_count, ingested_via, error_message, created_at
       FROM documents WHERE folder_id = ? ORDER BY created_at`,
    )
    .all(folderId) as Document[];
}

updateFolderStatus(folderId: string, status: FolderStatus): void {
  this.db
    .prepare("UPDATE folders SET status = ?, last_ingested_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), folderId);
}
```

Replace the existing `getFolders` method with an aggregate query:

```ts
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
```

Update `createFolder`'s return value to include the new fields (it has no
documents yet):

```ts
const folder: Folder = {
  id: randomUUID(),
  matter_id: matterId,
  name,
  path,
  status: "pending",
  document_count: 0,
  pii_count: 0,
};
```

(the INSERT statement is unchanged — `status`/`document_count`/`pii_count` are
either DB-defaulted or computed, not stored columns beyond `status`).

Add the `Document`/`IngestSource`/`FolderStatus` imports to
`services/mcp-server/src/store.ts`'s existing `@xberg-io/core` import.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/mcp-server test tests/store.documents.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full existing store/tools test suite to check for regressions**

Run: `pnpm --filter @xberg-io/mcp-server test`
Expected: PASS (the `getFolders`/`Folder` shape change must not break
`tests/tools.test.ts` or `tests/static.test.ts` — if it does, update those
fixtures' expectations to the new fields).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts services/mcp-server/src/store.ts services/mcp-server/tests/store.documents.test.ts
git commit -m "feat(mcp-server): add documents table and folder status aggregates"
```

---

### Task 2: `document_pii` table (human-reviewable output)

**Files:**

- Modify: `packages/core/src/types.ts`
- Modify: `services/mcp-server/src/store.ts`
- Test: `services/mcp-server/tests/store.documentPii.test.ts`

**Interfaces:**

- Consumes: `Document` from Task 1.
- Produces: `DocumentPiiEntity` type, `MetadataStore.insertPiiEntities()`, `MetadataStore.getPiiByDocument()`.

- [ ] **Step 1: Extend shared types**

In `packages/core/src/types.ts`:

```ts
export interface DocumentPiiEntity {
  id: string;
  document_id: string;
  kind: string;
  start: number;
  end: number;
  text: string;
  reviewed: boolean;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// services/mcp-server/tests/store.documentPii.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../src/store.js";

let dirs: string[] = [];
function makeStore(): MetadataStore {
  const dir = mkdtempSync(join(tmpdir(), "xberg-pii-"));
  dirs.push(dir);
  return new MetadataStore(join(dir, "meta.sqlite"));
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("document_pii", () => {
  it("inserts and lists PII entities for a document", () => {
    const store = makeStore();
    const matter = store.createMatter("Acme v Doe");
    const folder = store.createFolder(matter.id, "Discovery");
    const doc = store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/a.txt",
      content_hash: "h1",
      ingested_via: "mcp",
    });

    const inserted = store.insertPiiEntities(doc.id, [
      { kind: "person", start: 0, end: 9, text: "Jane Doe" },
      { kind: "email", start: 20, end: 38, text: "jane@example.com" },
    ]);

    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.reviewed).toBe(false);

    const listed = store.getPiiByDocument(doc.id);
    expect(listed.map((e) => e.kind)).toEqual(["person", "email"]);
  });

  it("returns an empty array for a document with no PII", () => {
    const store = makeStore();
    const matter = store.createMatter("Acme v Doe");
    const folder = store.createFolder(matter.id, "Discovery");
    const doc = store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/clean.txt",
      content_hash: "h2",
      ingested_via: "mcp",
    });

    expect(store.getPiiByDocument(doc.id)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/mcp-server test tests/store.documentPii.test.ts`
Expected: FAIL — `store.insertPiiEntities is not a function`.

- [ ] **Step 4: Implement schema + methods**

Add to `SCHEMA` in `services/mcp-server/src/store.ts`:

```sql
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
```

(`start`/`end` are SQL-reserved-adjacent and error-prone in some SQLite
tooling; columns are `start_offset`/`end_offset`, mapped back to
`start`/`end` in the `DocumentPiiEntity` the store returns.)

Add methods:

```ts
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
      out.push({ id, document_id: documentId, kind: row.kind, start: row.start, end: row.end, text: row.text, reviewed: false });
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
```

Add `DocumentPiiEntity` to the `@xberg-io/core` import.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/mcp-server test tests/store.documentPii.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts services/mcp-server/src/store.ts services/mcp-server/tests/store.documentPii.test.ts
git commit -m "feat(mcp-server): add document_pii table for human-reviewable PII"
```

---

### Task 3: `MirrorStore.appendMirror()`

**Files:**

- Modify: `services/mcp-server/src/mirror.ts`
- Test: `services/mcp-server/tests/mirror.append.test.ts`

**Interfaces:**

- Produces: `MirrorStore.appendMirror(matterId, additions: { pii: MirrorPiiSpanInput[]; chunks: MirrorChunkInput[] })`.

`saveMirror` fully replaces a matter's bundle; there is no existing way to add
one document's chunks/PII to an already-ingested matter without clobbering
prior documents. This task adds a merge-and-save method the Node pipeline can
call per document. It deliberately leaves `index`/`vault` byte arrays
untouched (empty on first write) — the Node pipeline never constructs a real
EdgeVec index or curtain-privacy vault; that stays browser-owned, matching the
existing "the server NEVER imports edgevec" design note in this file. A
browser session that later opens the same matter still works: it gets the
merged `pii`/`chunks` metadata immediately, and rebuilds `index`/`vault` next
time it performs its own ingest.

- [ ] **Step 1: Write the failing test**

```ts
// services/mcp-server/tests/mirror.append.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorStore } from "../src/mirror.js";

let dirs: string[] = [];
function makeMirror(): MirrorStore {
  const dir = mkdtempSync(join(tmpdir(), "xberg-mirror-"));
  dirs.push(dir);
  return new MirrorStore(dir);
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("MirrorStore.appendMirror", () => {
  it("creates a bundle on first append with empty index/vault", async () => {
    const mirror = makeMirror();
    mirror.appendMirror("m1", {
      pii: [{ doc_id: "d1", kind: "person", start: 0, end: 8, token: "PERSON_1" }],
      chunks: [{ doc_id: "d1", chunk_index: 0, text: "redacted chunk", score: 1, citation: "d1#0" }],
    });

    await mirror.loadMirror("m1");
    expect(mirror.listPii("m1", "d1")).toHaveLength(1);
    expect(mirror.retrieve("m1", "", 8)).toHaveLength(1);
  });

  it("merges a second document's data without dropping the first", async () => {
    const mirror = makeMirror();
    mirror.appendMirror("m1", {
      pii: [{ doc_id: "d1", kind: "person", start: 0, end: 8, token: "PERSON_1" }],
      chunks: [{ doc_id: "d1", chunk_index: 0, text: "first doc", score: 1, citation: "d1#0" }],
    });
    mirror.appendMirror("m1", {
      pii: [{ doc_id: "d2", kind: "email", start: 0, end: 10, token: "EMAIL_1" }],
      chunks: [{ doc_id: "d2", chunk_index: 0, text: "second doc", score: 1, citation: "d2#0" }],
    });

    await mirror.loadMirror("m1");
    expect(mirror.listPii("m1", "d1")).toHaveLength(1);
    expect(mirror.listPii("m1", "d2")).toHaveLength(1);
    expect(mirror.retrieve("m1", "", 8)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/mcp-server test tests/mirror.append.test.ts`
Expected: FAIL — `mirror.appendMirror is not a function`.

- [ ] **Step 3: Implement `appendMirror`**

In `services/mcp-server/src/mirror.ts`, export the two input shapes and add
the method (place after `saveMirror`):

```ts
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

appendMirror(matterId: string, additions: { pii: MirrorPiiSpanInput[]; chunks: MirrorChunkInput[] }): MirrorStatus {
  const bundleFile = this.bundlePath(matterId);
  const existing: MirrorBundle = existsSync(bundleFile)
    ? this.parseBundle(matterId, readFileSync(bundleFile))
    : { version: 1, index: [], vault: [], pii: [], chunks: [] };

  const merged: MirrorBundle = {
    version: 1,
    index: existing.index,
    vault: existing.vault,
    pii: [...existing.pii, ...additions.pii],
    chunks: [...existing.chunks, ...additions.chunks],
  };

  return this.saveMirror(matterId, Buffer.from(JSON.stringify(merged), "utf8"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/mcp-server test tests/mirror.append.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/mirror.ts services/mcp-server/tests/mirror.append.test.ts
git commit -m "feat(mcp-server): add MirrorStore.appendMirror for incremental document ingest"
```

---

## Group B — Node pipeline package

### Task 4: Scaffold `packages/node-pipeline` + folder walk

**Files:**

- Create: `packages/node-pipeline/package.json`
- Create: `packages/node-pipeline/tsconfig.json`
- Create: `packages/node-pipeline/src/walk.ts`
- Create: `packages/node-pipeline/src/index.ts`
- Test: `packages/node-pipeline/src/walk.test.ts`

**Interfaces:**

- Produces: `walkFolder(rootDir: string): Promise<WalkedFile[]>`, `hashBytes(bytes: Buffer): string`, `WalkedFile { path: string; contentHash: string }`.

- [ ] **Step 1: Scaffold the package**

```json
// packages/node-pipeline/package.json
{
  "name": "@xberg-io/node-pipeline",
  "version": "1.0.0-rc.27",
  "type": "module",
  "private": true,
  "description": "Node-side document-intelligence pipeline for MCP-triggered ingest: xberg-wasm extraction, on-device e5 embedding and GLiNER PII via onnxruntime-web's WASM backend run under Node.",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --clean",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@xberg-io/core": "workspace:*",
    "@xberg-io/xberg-wasm": "1.0.0-rc.26",
    "@xenova/transformers": "^2.17.2",
    "onnxruntime-web": "^1.24.2",
    "gliner": "^0.0.19",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsup": "^8.0.0",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

```json
// packages/node-pipeline/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

```ts
// packages/node-pipeline/src/index.ts
export { walkFolder, hashBytes } from "./walk.js";
export type { WalkedFile } from "./walk.js";
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/node-pipeline/src/walk.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFolder, hashBytes } from "./walk.js";

let dirs: string[] = [];
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "xberg-walk-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.txt"), "hello");
  writeFileSync(join(dir, "b.png"), "not a document");
  writeFileSync(join(dir, ".hidden.txt"), "skip me");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "c.md"), "# nested");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "config"), "skip this dir");
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("walkFolder", () => {
  it("recursively finds supported files, skipping hidden files/dirs and unsupported extensions", async () => {
    const dir = makeFixture();
    const files = await walkFolder(dir);
    const relPaths = files.map((f) => f.path.replace(dir, "").replace(/\\/g, "/")).sort();

    expect(relPaths).toEqual(["/a.txt", "/sub/c.md"]);
    expect(files.every((f) => f.contentHash.length === 64)).toBe(true);
  });

  it("hashBytes is stable for identical content", () => {
    const a = hashBytes(Buffer.from("hello"));
    const b = hashBytes(Buffer.from("hello"));
    const c = hashBytes(Buffer.from("world"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/node-pipeline test`
Expected: FAIL — `Cannot find module './walk.js'`.

- [ ] **Step 4: Implement `walk.ts`**

```ts
// packages/node-pipeline/src/walk.ts
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".txt", ".md", ".markdown", ".csv", ".html", ".htm", ".json", ".rtf",
]);

export interface WalkedFile {
  path: string;
  contentHash: string;
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function walkFolder(rootDir: string): Promise<WalkedFile[]> {
  const results: WalkedFile[] = [];
  await walkDir(rootDir, results);
  return results;
}

async function walkDir(dir: string, results: WalkedFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, results);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const bytes = await readFile(fullPath);
    results.push({ path: fullPath, contentHash: hashBytes(bytes) });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/node-pipeline test`
Expected: PASS

- [ ] **Step 6: Register the workspace package and install**

Run: `pnpm install`
Expected: `packages/node-pipeline` resolves via the existing `pnpm-workspace.yaml` `packages/*` glob — no config change needed. Also flip the placeholder in `pnpm-workspace.yaml`'s `allowBuilds` for any package this pipeline needs a native postinstall step for; `onnxruntime-web` needs none, so no change should be required here — confirm `pnpm install` completes without an `allowBuilds` prompt for this package.

- [ ] **Step 7: Commit**

```bash
git add packages/node-pipeline
git commit -m "feat(node-pipeline): scaffold package with recursive folder walk + content hashing"
```

---

### Task 5: Shared GLiNER model catalog

**Files:**

- Create: `packages/node-pipeline/src/gliner-catalog.ts`
- Create: `packages/node-pipeline/src/gliner-catalog.test.ts`

**Interfaces:**

- Produces: `GLINER_MODEL_DEFINITIONS`, `parseGlinerChecksums(text: string): Record<string,string>`, `buildGlinerManifestEntries(checksums: Record<string,string>): ModelManifestEntry[]`.

This mirrors `crates/xberg/src/text/ner/gline.rs`'s `GLINER_MODELS` table and
checksum-manifest format exactly (that Rust *core crate* module wraps the
lower-level `crates/xberg-gliner` ONNX engine and owns the model catalog +
pinned manifest — `crates/xberg-gliner` itself has no catalog, only the
inference/decode plumbing), so Node and Rust download and verify the
identical artifacts from the identical `xberg-io/gliner-models` HF repo. The
checksum values themselves are **not** retyped here — copying
`crates/xberg/src/text/ner/gliner-models.sha256` verbatim (Step 1) is a
mechanical `cp`, not a re-derivation, so there is no risk of transcription
error diverging from the pinned values Rust already verifies against.

- [ ] **Step 1: Copy the pinned checksum manifest verbatim**

```bash
cp "crates/xberg/src/text/ner/gliner-models.sha256" "packages/node-pipeline/src/gliner-models.sha256"
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/node-pipeline/src/gliner-catalog.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GLINER_MODEL_DEFINITIONS, parseGlinerChecksums, buildGlinerManifestEntries } from "./gliner-catalog.js";

describe("gliner-catalog", () => {
  it("parses the copied checksum manifest and finds every declared model file", () => {
    const text = readFileSync(join(import.meta.dirname, "gliner-models.sha256"), "utf8");
    const checksums = parseGlinerChecksums(text);

    for (const def of GLINER_MODEL_DEFINITIONS) {
      expect(checksums[def.modelFile], `missing checksum for ${def.modelFile}`).toBeTruthy();
      expect(checksums[def.tokenizerFile], `missing checksum for ${def.tokenizerFile}`).toBeTruthy();
    }
  });

  it("builds one manifest entry per model + tokenizer file, named for local caching", () => {
    const checksums = {
      "models/gliner_small-v2.5/span/fp32/model.onnx": "a".repeat(64),
      "models/gliner_small-v2.5/span/fp32/tokenizer.json": "b".repeat(64),
      "models/gliner_medium-v2.5/span/fp32/model.onnx": "c".repeat(64),
      "models/gliner_medium-v2.5/span/fp32/tokenizer.json": "d".repeat(64),
      "models/gliner_large-v2.5/span/fp32/model.onnx": "e".repeat(64),
      "models/gliner_large-v2.5/span/fp32/tokenizer.json": "f".repeat(64),
    };
    const entries = buildGlinerManifestEntries(checksums);

    expect(entries).toHaveLength(6);
    const balanced = entries.find((e) => e.name === "gliner_medium-v2.5.model");
    expect(balanced?.sha256).toBe("c".repeat(64));
    expect(balanced?.file).toBe("gliner/gliner_medium-v2.5/model.onnx");
    expect(balanced?.url).toBe(
      "https://huggingface.co/xberg-io/gliner-models/resolve/main/models/gliner_medium-v2.5/span/fp32/model.onnx",
    );
  });

  it("throws when a declared model file has no checksum entry", () => {
    expect(() => buildGlinerManifestEntries({})).toThrow(/missing checksum/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/node-pipeline test src/gliner-catalog.test.ts`
Expected: FAIL — `Cannot find module './gliner-catalog.js'`.

- [ ] **Step 4: Implement `gliner-catalog.ts`**

```ts
// packages/node-pipeline/src/gliner-catalog.ts
import type { ModelManifestEntry } from "@xberg-io/core";

export const GLINER_MODELS_REPO = "xberg-io/gliner-models";

export interface GlinerModelDefinition {
  id: string;
  aliases: string[];
  modelFile: string;
  tokenizerFile: string;
}

// Mirrors crates/xberg/src/text/ner/gline.rs::GLINER_MODELS exactly.
export const GLINER_MODEL_DEFINITIONS: GlinerModelDefinition[] = [
  {
    id: "gliner_small-v2.5",
    aliases: ["fast"],
    modelFile: "models/gliner_small-v2.5/span/fp32/model.onnx",
    tokenizerFile: "models/gliner_small-v2.5/span/fp32/tokenizer.json",
  },
  {
    id: "gliner_medium-v2.5",
    aliases: ["balanced", "multilingual"],
    modelFile: "models/gliner_medium-v2.5/span/fp32/model.onnx",
    tokenizerFile: "models/gliner_medium-v2.5/span/fp32/tokenizer.json",
  },
  {
    id: "gliner_large-v2.5",
    aliases: ["quality"],
    modelFile: "models/gliner_large-v2.5/span/fp32/model.onnx",
    tokenizerFile: "models/gliner_large-v2.5/span/fp32/tokenizer.json",
  },
];

export const DEFAULT_GLINER_MODEL = "gliner_medium-v2.5";

export function parseGlinerChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\.?\/?(.+)$/i);
    if (!match) continue;
    const [, sha, path] = match;
    if (sha && path) out[path] = sha.toLowerCase();
  }
  return out;
}

function localFileFor(modelId: string, kind: "model.onnx" | "tokenizer.json"): string {
  return `gliner/${modelId}/${kind}`;
}

export function buildGlinerManifestEntries(checksums: Record<string, string>): ModelManifestEntry[] {
  const entries: ModelManifestEntry[] = [];
  for (const def of GLINER_MODEL_DEFINITIONS) {
    for (const [remoteFile, localKind, suffix] of [
      [def.modelFile, "model.onnx", "model"],
      [def.tokenizerFile, "tokenizer.json", "tokenizer"],
    ] as const) {
      const sha256 = checksums[remoteFile];
      if (!sha256) {
        throw new Error(`missing checksum for ${remoteFile} (model ${def.id})`);
      }
      entries.push({
        name: `${def.id}.${suffix}`,
        url: `https://huggingface.co/${GLINER_MODELS_REPO}/resolve/main/${remoteFile}`,
        file: localFileFor(def.id, localKind),
        sha256,
      });
    }
  }
  return entries;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/node-pipeline test src/gliner-catalog.test.ts`
Expected: PASS

- [ ] **Step 6: Add `loadGlinerManifestEntries()` — self-relative, no cross-package path**

**Files:**

- Modify: `packages/node-pipeline/src/gliner-catalog.ts` (append)

The checksum file must be located relative to `gliner-catalog.ts`'s own
`import.meta.url`, never via a path that assumes another package's directory
layout — that path changes shape between `src/` (dev) and `dist/` (built) and
was wrong in an earlier draft of this plan (`services/mcp-server` cannot know
where `packages/node-pipeline` lives on disk). Resolving relative to *this
file* works unchanged in both cases, because the `.sha256` file travels with
whichever copy of `gliner-catalog.js` is actually running:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHECKSUM_FILE_PATH = fileURLToPath(new URL("./gliner-models.sha256", import.meta.url));

export function loadGlinerManifestEntries(): ModelManifestEntry[] {
  const text = readFileSync(CHECKSUM_FILE_PATH, "utf8");
  return buildGlinerManifestEntries(parseGlinerChecksums(text));
}
```

Re-export it from the package index:

```ts
// packages/node-pipeline/src/index.ts (append)
export { loadGlinerManifestEntries } from "./gliner-catalog.js";
```

Ensure the checksum file ships alongside the built output — add a copy step
to `packages/node-pipeline/package.json`'s `build` script so `dist/` isn't
missing it after `tsup` (which only compiles `.ts`, it does not copy other
files):

```json
"build": "tsup src/index.ts --format esm --clean && cp src/gliner-models.sha256 dist/gliner-models.sha256"
```

- [ ] **Step 7: Wire the catalog into the Node service's `ModelCache`**

**Files:**

- Modify: `services/mcp-server/src/models.ts:19-42` (constructor)

Merge the GLiNER catalog entries into whatever base manifest loads, so GLiNER
models are servable even before a release-time `manifest.json` includes them
natively. This is a one-directional dependency (`mcp-server` → `node-pipeline`
only) — `node-pipeline` never imports anything from `mcp-server` (see Task 8's
structural-interface note for why that direction stays closed):

```ts
import { loadGlinerManifestEntries } from "@xberg-io/node-pipeline";
```

In the constructor, after `parsed = { models: [] }` fallback / validation but
before `this.manifest = parsed;`:

```ts
try {
  const glinerEntries = loadGlinerManifestEntries();
  const existingNames = new Set(parsed.models.map((m) => m.name));
  for (const entry of glinerEntries) {
    if (!existingNames.has(entry.name)) parsed.models.push(entry);
  }
} catch {
  // GLiNER catalog unavailable (e.g. package not built yet) — base manifest still serves.
}
```

Add `"@xberg-io/node-pipeline": "workspace:*"` to
`services/mcp-server/package.json` dependencies.

- [ ] **Step 8: Run the mcp-server test suite**

Run: `pnpm --filter @xberg-io/mcp-server test`
Expected: PASS (existing `ModelCache` tests in `tests/static.test.ts` and
`tests/tools.test.ts` still pass with the merged manifest).

- [ ] **Step 9: Commit**

```bash
git add packages/node-pipeline/src/gliner-catalog.ts packages/node-pipeline/src/gliner-catalog.test.ts packages/node-pipeline/src/gliner-models.sha256 packages/node-pipeline/src/index.ts packages/node-pipeline/package.json services/mcp-server/src/models.ts services/mcp-server/package.json
git commit -m "feat(node-pipeline): pin GLiNER model catalog to the same manifest crates/xberg's gline.rs uses"
```

---

### Task 6: Node GLiNER inference (`ner.ts`)

**Files:**

- Create: `packages/node-pipeline/src/ner.ts`
- Test: `packages/node-pipeline/src/ner.test.ts`

**Interfaces:**

- Consumes: `DEFAULT_GLINER_MODEL`, `GLINER_MODEL_DEFINITIONS` (Task 5).
- Produces: `detectPii(text: string, modelPath: string, tokenizerPath: string, types?: readonly string[]): Promise<DetectedEntity[]>`, `DetectedEntity { kind: string; start: number; end: number; text: string }`, `RUST_ALIGNED_PII_TYPES`.

Adopts the Rust `EntityCategory` taxonomy
(`person/organization/location/date/time/money/percent/email/phone/url`) as
canonical, plus the two extra labels the browser pipeline already added
(`ssn`, `financial`) passed through as GLiNER zero-shot labels — no retraining
needed, this is just the label string list handed to the model.

- [ ] **Step 1: Write the failing test**

This test is marked `skip` by default because it needs a real downloaded
GLiNER model (network + several hundred MB) — it is the equivalent of
`crates/xberg/src/text/ner/gline.rs`'s own `#[ignore] smoke_test_real_inference`. Run it
explicitly during implementation to prove the integration works, then leave it
skipped in CI (mirroring the Rust smoke test's `--ignored` convention).

```ts
// packages/node-pipeline/src/ner.test.ts
import { describe, expect, it } from "vitest";
import { detectPii, RUST_ALIGNED_PII_TYPES } from "./ner.js";

describe("RUST_ALIGNED_PII_TYPES", () => {
  it("matches the Rust EntityCategory taxonomy plus the two custom labels", () => {
    expect(RUST_ALIGNED_PII_TYPES).toEqual([
      "person", "organization", "location", "date", "time", "money", "percent", "email", "phone", "url",
      "ssn", "financial",
    ]);
  });
});

describe.skip("detectPii (real model — run manually, needs network)", () => {
  it("detects a person and organization", async () => {
    const entities = await detectPii(
      "Elon Musk founded SpaceX in Hawthorne, California.",
      process.env.GLINER_MODEL_PATH ?? "",
      process.env.GLINER_TOKENIZER_PATH ?? "",
    );
    const texts = entities.map((e) => e.text);
    expect(texts).toEqual(expect.arrayContaining([expect.stringContaining("Musk")]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/node-pipeline test src/ner.test.ts`
Expected: FAIL — `Cannot find module './ner.js'`.

- [ ] **Step 3: Implement `ner.ts`**

Adapts `packages/wasm-pipeline/src/ner.ts` for local filesystem model paths
instead of HTTP `fetch`, and drops the `ModelScenario`/capability-detection
machinery (single fixed server, not arbitrary browser hardware):

```ts
// packages/node-pipeline/src/ner.ts
import type { Gliner, IEntityResult, InitConfig, IONNXWebSettings, ITransformersSettings } from "gliner";

export const RUST_ALIGNED_PII_TYPES = [
  "person", "organization", "location", "date", "time", "money", "percent", "email", "phone", "url",
  "ssn", "financial",
] as const;

export interface DetectedEntity {
  kind: string;
  start: number;
  end: number;
  text: string;
}

async function disableRemoteModels(): Promise<void> {
  try {
    const { env } = await import("@xenova/transformers");
    env.allowRemoteModels = false;
  } catch {
    // transformers runtime unavailable — no-op.
  }
}

const modelCache = new Map<string, Promise<Gliner>>();

async function getModel(modelPath: string, tokenizerPath: string): Promise<Gliner> {
  const key = `${modelPath}::${tokenizerPath}`;
  let cached = modelCache.get(key);
  if (!cached) {
    cached = (async () => {
      const { Gliner: GlinerClass } = await import("gliner");
      await disableRemoteModels();
      const transformersSettings: ITransformersSettings = { allowLocalModels: true, useBrowserCache: false };
      const onnxSettings: IONNXWebSettings = { modelPath, executionProvider: "wasm" };
      const config: InitConfig = { tokenizerPath, onnxSettings, transformersSettings };
      const model = new GlinerClass(config);
      await model.initialize();
      return model;
    })();
    modelCache.set(key, cached);
  }
  return cached;
}

export async function detectPii(
  text: string,
  modelPath: string,
  tokenizerPath: string,
  types: readonly string[] = RUST_ALIGNED_PII_TYPES,
): Promise<DetectedEntity[]> {
  const model = await getModel(modelPath, tokenizerPath);
  const result = await model.inference({ texts: [text], entities: [...types], flatNer: true, threshold: 0.5 });
  const ents = result[0] ?? [];
  return ents.map((e: IEntityResult) => ({ kind: e.label, start: e.start, end: e.end, text: e.spanText }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/node-pipeline test src/ner.test.ts`
Expected: PASS (the taxonomy test runs; the `describe.skip` block is skipped).

- [ ] **Step 5: Manually verify real inference once**

Download a GLiNER model/tokenizer pair (e.g. via the existing
`ModelCache.ensureModel` path exercised manually, or `crates/xberg`'s
`xberg cache warm --ner`, which populates the identical files since Task 5
pinned the same catalog), then run:

```bash
GLINER_MODEL_PATH=/path/to/model.onnx GLINER_TOKENIZER_PATH=/path/to/tokenizer.json \
  pnpm --filter @xberg-io/node-pipeline exec vitest run src/ner.test.ts -t "detects a person"
```

Expected: PASS, confirming `onnxruntime-web`'s wasm backend runs GLiNER
correctly under plain Node with no browser.

- [ ] **Step 6: Commit**

```bash
git add packages/node-pipeline/src/ner.ts packages/node-pipeline/src/ner.test.ts
git commit -m "feat(node-pipeline): GLiNER PII detection via onnxruntime-web under Node"
```

---

### Task 7: Node embedding (`embed.ts`)

**Files:**

- Create: `packages/node-pipeline/src/embed.ts`
- Test: `packages/node-pipeline/src/embed.test.ts`

**Interfaces:**

- Produces: `embedText(text: string, modelPath: string, tokenizerPath: string): Promise<number[]>`.

Same runtime/pattern as Task 6, for the existing e5 embedding model (already
served by `ModelCache` today — no new catalog needed, unlike GLiNER).

- [ ] **Step 1: Write the failing test**

```ts
// packages/node-pipeline/src/embed.test.ts
import { describe, expect, it } from "vitest";
import { embedText } from "./embed.js";

describe.skip("embedText (real model — run manually, needs network)", () => {
  it("returns a 768-dim vector", async () => {
    const vec = await embedText(
      "hello world",
      process.env.E5_MODEL_PATH ?? "",
      process.env.E5_TOKENIZER_PATH ?? "",
    );
    expect(vec).toHaveLength(768);
  });
});

describe("embedText input validation", () => {
  it("rejects empty text without loading a model", async () => {
    await expect(embedText("", "unused", "unused")).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/node-pipeline test src/embed.test.ts`
Expected: FAIL — `Cannot find module './embed.js'`.

- [ ] **Step 3: Implement `embed.ts`**

```ts
// packages/node-pipeline/src/embed.ts
import type { InferenceSession, Tensor } from "onnxruntime-web";

const EMBED_DIM = 768;
const sessionCache = new Map<string, Promise<InferenceSession>>();

async function getSession(modelPath: string): Promise<InferenceSession> {
  let cached = sessionCache.get(modelPath);
  if (!cached) {
    cached = (async () => {
      const ort = await import("onnxruntime-web");
      return ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] });
    })();
    sessionCache.set(modelPath, cached);
  }
  return cached;
}

export async function embedText(text: string, modelPath: string, tokenizerPath: string): Promise<number[]> {
  if (!text.trim()) {
    throw new Error("embedText: input text must not be empty");
  }
  const { AutoTokenizer } = await import("@xenova/transformers");
  const tokenizer = await AutoTokenizer.from_pretrained(tokenizerPath, { local_files_only: true });
  const encoded = await tokenizer(text, { padding: true, truncation: true });

  const ort = await import("onnxruntime-web");
  const session = await getSession(modelPath);
  const feeds: Record<string, Tensor> = {
    input_ids: new ort.Tensor("int64", encoded.input_ids.data, encoded.input_ids.dims),
    attention_mask: new ort.Tensor("int64", encoded.attention_mask.data, encoded.attention_mask.dims),
  };
  const output = await session.run(feeds);
  const embedding = output["sentence_embedding"] ?? Object.values(output)[0];
  if (!embedding) {
    throw new Error("embedText: model produced no output tensor");
  }
  const values = Array.from(embedding.data as Float32Array);
  if (values.length !== EMBED_DIM) {
    throw new Error(`embedText: expected ${EMBED_DIM}-dim output, got ${values.length}`);
  }
  return values;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/node-pipeline test src/embed.test.ts`
Expected: PASS (validation test runs; the `describe.skip` block is skipped).

- [ ] **Step 5: Manually verify real inference once**

```bash
E5_MODEL_PATH=/path/to/e5.fp32.onnx E5_TOKENIZER_PATH=/path/to/e5.tokenizer.json \
  pnpm --filter @xberg-io/node-pipeline exec vitest run src/embed.test.ts -t "768-dim"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/node-pipeline/src/embed.ts packages/node-pipeline/src/embed.test.ts
git commit -m "feat(node-pipeline): e5 embedding via onnxruntime-web under Node"
```

---

### Task 8: Ingest orchestration (`ingestFile`)

**Files:**

- Create: `packages/node-pipeline/src/ingest.ts`
- Test: `packages/node-pipeline/src/ingest.test.ts`
- Modify: `packages/node-pipeline/src/index.ts` (re-export)

**Interfaces:**

- Consumes: `walkFolder`, `hashBytes` (Task 4); `detectPii` (Task 6); `embedText` (Task 7).
- Produces: `ingestFile(deps: IngestDeps, file: WalkedFile, ctx: IngestFileContext): Promise<Document>`, `IngestDeps`, `IngestFileContext`, `DocumentStore`, `MirrorSink` (structural interfaces — see note below).

This is the per-file pipeline the MCP tool (Task 10) drives in a loop over
`walkFolder`'s output: extract → chunk → embed → PII → persist both outputs.
`IngestDeps` is an explicit dependency-injection object so the function is
unit-testable without real ONNX models or a real database — tests inject fake
`embed`/`detectPii` functions and an in-memory fake store/mirror, and assert
the orchestration/persistence logic, matching how `crates/xberg`'s `gline.rs`
tests separate model-dependent smoke tests from pure-logic tests.

**Why structural interfaces, not the real classes:** `packages/node-pipeline`
must never import from `services/mcp-server` — Task 5/10 already have
`mcp-server` importing *from* `node-pipeline` (the GLiNER catalog, `walkFolder`,
`ingestFile`), and a workspace package cannot depend on a package that depends
on it (neither can build first). So `IngestDeps.store`/`mirror` are typed as
narrow interfaces covering only the methods `ingestFile` actually calls.
`services/mcp-server/src/mcp/tools.ts` (Task 10) passes its real
`ctx.store`/`ctx.mirror` at the call site — `MetadataStore`/`MirrorStore`
already implement these methods with matching signatures, so no adapter code
is needed, TypeScript's structural typing accepts them directly.

- [ ] **Step 1: Write the failing test**

```ts
// packages/node-pipeline/src/ingest.test.ts
import { describe, expect, it, vi } from "vitest";
import { hashBytes } from "./walk.js";
import { ingestFile } from "./ingest.js";
import type { Document, DocumentPiiEntity } from "@xberg-io/core";
import type { DocumentStore, MirrorSink } from "./ingest.js";

function makeFakeStore(): DocumentStore & { documents: Document[]; pii: Record<string, DocumentPiiEntity[]> } {
  const documents: Document[] = [];
  const pii: Record<string, DocumentPiiEntity[]> = {};
  return {
    documents,
    pii,
    findDocumentByHash: (folderId, contentHash) =>
      documents.find((d) => d.folder_id === folderId && d.content_hash === contentHash),
    createDocument: (input) => {
      const doc: Document = {
        id: `doc-${documents.length + 1}`,
        folder_id: input.folder_id,
        matter_id: input.matter_id,
        path: input.path,
        content_hash: input.content_hash,
        status: "processing",
        pages: 0,
        chunk_count: 0,
        pii_count: 0,
        ingested_via: input.ingested_via,
        created_at: new Date(0).toISOString(),
      };
      documents.push(doc);
      return doc;
    },
    updateDocumentStatus: (id, status, fields = {}) => {
      const doc = documents.find((d) => d.id === id);
      if (!doc) throw new Error(`unknown document ${id}`);
      doc.status = status;
      if (fields.pages !== undefined) doc.pages = fields.pages;
      if (fields.chunk_count !== undefined) doc.chunk_count = fields.chunk_count;
      if (fields.pii_count !== undefined) doc.pii_count = fields.pii_count;
      if (fields.error_message !== undefined) doc.error_message = fields.error_message;
    },
    insertPiiEntities: (documentId, entities) => {
      const inserted = entities.map((e, i) => ({ id: `pii-${documentId}-${i}`, document_id: documentId, reviewed: false, ...e }));
      pii[documentId] = inserted;
      return inserted;
    },
    getDocumentsByFolder: (folderId) => documents.filter((d) => d.folder_id === folderId),
  };
}

function makeFakeMirror(): MirrorSink & { appended: { matterId: string; pii: unknown[]; chunks: unknown[] }[] } {
  const appended: { matterId: string; pii: unknown[]; chunks: unknown[] }[] = [];
  return {
    appended,
    appendMirror: (matterId, additions) => {
      appended.push({ matterId, pii: additions.pii, chunks: additions.chunks });
    },
  };
}

describe("ingestFile", () => {
  it("extracts, chunks, embeds, detects PII, and persists both outputs", async () => {
    const store = makeFakeStore();
    const mirror = makeFakeMirror();
    const extract = vi.fn().mockResolvedValue({ content: "Jane Doe works at Acme Corp.", pageCount: 1 });
    const chunk = vi.fn().mockReturnValue(["Jane Doe works at Acme Corp."]);
    const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
    const detectPii = vi.fn().mockResolvedValue([{ kind: "person", start: 0, end: 8, text: "Jane Doe" }]);

    const file = { path: "/tmp/a.txt", contentHash: hashBytes(Buffer.from("Jane Doe works at Acme Corp.")) };
    const doc = await ingestFile(
      { extract, chunk, embed, detectPii, store, mirror },
      file,
      { folderId: "folder-1", matterId: "matter-1", ingestedVia: "mcp" },
    );

    expect(doc.status).toBe("done");
    expect(doc.pages).toBe(1);
    expect(doc.chunk_count).toBe(1);
    expect(doc.pii_count).toBe(1);
    expect(store.pii[doc.id]).toHaveLength(1);
    expect(mirror.appended).toHaveLength(1);
    expect(mirror.appended[0]?.matterId).toBe("matter-1");
    expect(mirror.appended[0]?.chunks).toHaveLength(1);
    expect(embed).toHaveBeenCalledWith("Jane Doe works at Acme Corp.");
  });

  it("skips a file whose content hash was already ingested for the folder", async () => {
    const store = makeFakeStore();
    const mirror = makeFakeMirror();
    const file = { path: "/tmp/a.txt", contentHash: hashBytes(Buffer.from("duplicate content")) };
    const deps = {
      extract: vi.fn().mockResolvedValue({ content: "duplicate content", pageCount: 1 }),
      chunk: vi.fn().mockReturnValue(["duplicate content"]),
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      detectPii: vi.fn().mockResolvedValue([]),
      store,
      mirror,
    };

    const first = await ingestFile(deps, file, { folderId: "folder-1", matterId: "matter-1", ingestedVia: "mcp" });
    const second = await ingestFile(deps, file, { folderId: "folder-1", matterId: "matter-1", ingestedVia: "mcp" });

    expect(second.id).toBe(first.id);
    expect(deps.extract).toHaveBeenCalledTimes(1);
  });

  it("records status='error' with a message when extraction throws, without persisting PII", async () => {
    const store = makeFakeStore();
    const mirror = makeFakeMirror();
    const file = { path: "/tmp/bad.pdf", contentHash: hashBytes(Buffer.from("not a real pdf")) };
    const deps = {
      extract: vi.fn().mockRejectedValue(new Error("corrupt PDF")),
      chunk: vi.fn(),
      embed: vi.fn(),
      detectPii: vi.fn(),
      store,
      mirror,
    };

    const doc = await ingestFile(deps, file, { folderId: "folder-1", matterId: "matter-1", ingestedVia: "mcp" });

    expect(doc.status).toBe("error");
    expect(doc.error_message).toBe("corrupt PDF");
    expect(store.pii[doc.id]).toBeUndefined();
    expect(mirror.appended).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/node-pipeline test src/ingest.test.ts`
Expected: FAIL — `Cannot find module './ingest.js'`.

- [ ] **Step 3: Implement `ingest.ts`**

```ts
// packages/node-pipeline/src/ingest.ts
import type { Document, DocumentPiiEntity, IngestSource } from "@xberg-io/core";
import type { WalkedFile } from "./walk.js";

export interface ExtractedDoc {
  content: string;
  pageCount: number;
}

// Narrow, structural subset of MetadataStore — see the task note on why this
// is not imported from @xberg-io/mcp-server.
export interface DocumentStore {
  findDocumentByHash(folderId: string, contentHash: string): Document | undefined;
  createDocument(input: {
    folder_id: string;
    matter_id: string;
    path: string;
    content_hash: string;
    ingested_via: IngestSource;
  }): Document;
  updateDocumentStatus(
    id: string,
    status: Document["status"],
    fields?: { pages?: number; chunk_count?: number; pii_count?: number; error_message?: string },
  ): void;
  insertPiiEntities(
    documentId: string,
    entities: { kind: string; start: number; end: number; text: string }[],
  ): DocumentPiiEntity[];
  getDocumentsByFolder(folderId: string): Document[];
}

// Narrow, structural subset of MirrorStore.
export interface MirrorSink {
  appendMirror(
    matterId: string,
    additions: {
      pii: { doc_id: string; kind: string; start: number; end: number; token: string }[];
      chunks: { doc_id: string; chunk_index: number; text: string; score: number; citation: string }[];
    },
  ): void;
}

export interface IngestDeps {
  extract: (path: string) => Promise<ExtractedDoc>;
  chunk: (content: string) => string[];
  embed: (text: string) => Promise<number[]>;
  detectPii: (text: string) => Promise<{ kind: string; start: number; end: number; text: string }[]>;
  store: DocumentStore;
  mirror: MirrorSink;
}

export interface IngestFileContext {
  folderId: string;
  matterId: string;
  ingestedVia: IngestSource;
}

export async function ingestFile(deps: IngestDeps, file: WalkedFile, ctx: IngestFileContext): Promise<Document> {
  const existing = deps.store.findDocumentByHash(ctx.folderId, file.contentHash);
  if (existing) return existing;

  const doc = deps.store.createDocument({
    folder_id: ctx.folderId,
    matter_id: ctx.matterId,
    path: file.path,
    content_hash: file.contentHash,
    ingested_via: ctx.ingestedVia,
  });

  try {
    const extracted = await deps.extract(file.path);
    const chunks = deps.chunk(extracted.content);
    const piiEntities = await deps.detectPii(extracted.content);

    const mirrorChunks = await Promise.all(
      chunks.map(async (text, chunkIndex) => {
        await deps.embed(text); // computed for future real-ranking use; score below stays static
        return { doc_id: doc.id, chunk_index: chunkIndex, text, score: 1, citation: `${doc.id}#${chunkIndex}` };
      }),
    );

    deps.store.insertPiiEntities(doc.id, piiEntities);
    deps.mirror.appendMirror(ctx.matterId, {
      pii: piiEntities.map((e) => ({ doc_id: doc.id, kind: e.kind, start: e.start, end: e.end, token: e.kind })),
      chunks: mirrorChunks,
    });

    deps.store.updateDocumentStatus(doc.id, "done", {
      pages: extracted.pageCount,
      chunk_count: chunks.length,
      pii_count: piiEntities.length,
    });
  } catch (error) {
    deps.store.updateDocumentStatus(doc.id, "error", {
      error_message: error instanceof Error ? error.message : "ingest failed",
    });
  }

  const documents = deps.store.getDocumentsByFolder(ctx.folderId);
  const updated = documents.find((d) => d.id === doc.id);
  if (!updated) throw new Error(`document ${doc.id} disappeared after status update`);
  return updated;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/node-pipeline test src/ingest.test.ts`
Expected: PASS

- [ ] **Step 5: Re-export from the package index**

```ts
// packages/node-pipeline/src/index.ts (append)
export { ingestFile } from "./ingest.js";
export type { IngestDeps, IngestFileContext, ExtractedDoc, DocumentStore, MirrorSink } from "./ingest.js";
export { detectPii, RUST_ALIGNED_PII_TYPES } from "./ner.js";
export type { DetectedEntity } from "./ner.js";
export { embedText } from "./embed.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/node-pipeline
git commit -m "feat(node-pipeline): orchestrate extract/chunk/embed/PII into documents + mirror"
```

---

## Group C — MCP tool surface

### Task 9: `list_matters` + `create_matter` tools

**Files:**

- Modify: `services/mcp-server/src/mcp/tools.ts`
- Modify: `services/mcp-server/tests/tools.test.ts`

**Interfaces:**

- Produces: `listMatters(ctx: AppContext): ToolResult`, `createMatter(ctx: AppContext, args: { name: string }): ToolResult`, registered as MCP tools `list_matters`/`create_matter`.

- [ ] **Step 1: Write the failing test**

Add to `services/mcp-server/tests/tools.test.ts` (reusing the existing
`harness()` helper already defined in that file):

```ts
import { createMatter, listMatters } from "../src/mcp/tools.js";

describe("list_matters / create_matter", () => {
  it("lists existing matters", async () => {
    const { ctx, matter } = await harness(["read"], false);
    const result = listMatters(ctx);
    const parsed = JSON.parse(result.content[0]!.text) as { matters: { id: string }[] };
    expect(parsed.matters.some((m) => m.id === matter.id)).toBe(true);
  });

  it("rejects list_matters without read scope", async () => {
    const { ctx } = await harness([], false);
    expect(() => listMatters(ctx)).toThrow(/missing required scope/);
  });

  it("creates a new matter", async () => {
    const { ctx } = await harness(["ingest"], false);
    const result = createMatter(ctx, { name: "Roe v Wade" });
    const parsed = JSON.parse(result.content[0]!.text) as { name: string };
    expect(parsed.name).toBe("Roe v Wade");
  });

  it("rejects create_matter without ingest scope", async () => {
    const { ctx } = await harness(["read"], false);
    expect(() => createMatter(ctx, { name: "x" })).toThrow(/missing required scope/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/mcp-server test tests/tools.test.ts -t "list_matters"`
Expected: FAIL — `listMatters is not exported`.

- [ ] **Step 3: Implement the tools**

In `services/mcp-server/src/mcp/tools.ts`, add (near `ragQuery`):

```ts
export function listMatters(ctx: AppContext): ToolResult {
  return wrap(() => {
    if (!ctx.tokenScopes.includes("read") && !ctx.tokenScopes.includes("admin")) {
      throw new AppError("scope", "missing required scope: read");
    }
    return jsonResult({ matters: ctx.store.getMatters() });
  });
}

export interface CreateMatterArgs {
  name: string;
}

export function createMatter(ctx: AppContext, args: CreateMatterArgs): ToolResult {
  return wrap(() => {
    if (!ctx.tokenScopes.includes("ingest") && !ctx.tokenScopes.includes("admin")) {
      throw new AppError("scope", "missing required scope: ingest");
    }
    const matter = ctx.store.createMatter(args.name);
    ctx.store.recordAudit(actorFor(ctx), "ingest", "create_matter", matter.id);
    return jsonResult(matter);
  });
}
```

Register both in `registerTools`:

```ts
server.tool("list_matters", {}, async () => listMatters(ctx));
server.tool("create_matter", { name: z.string() }, async (args) => createMatter(ctx, args));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/mcp-server test tests/tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/mcp/tools.ts services/mcp-server/tests/tools.test.ts
git commit -m "feat(mcp-server): add list_matters and create_matter MCP tools"
```

---

### Task 10: Rewrite `ingest_folder` to actually process files

**Files:**

- Modify: `services/mcp-server/src/mcp/tools.ts`
- Modify: `services/mcp-server/src/index.ts` (wire real `extract`/`chunk` deps into `AppContext`)
- Modify: `services/mcp-server/tests/tools.test.ts`

**Interfaces:**

- Consumes: `walkFolder`, `ingestFile`, `IngestDeps` (Group B).
- Produces: rewritten `ingestFolder(ctx: AppContext, args: IngestFolderArgs): Promise<ToolResult>` returning `{ folder, documents_processed, documents_skipped, pii_entities_found, errors }`.

- [ ] **Step 1: Write the failing test**

```ts
// services/mcp-server/tests/tools.test.ts (add)
import { mkdtempSync, writeFileSync as writeFileSyncNode } from "node:fs";
import { tmpdir as tmpdirNode } from "node:os";
import { ingestFolder } from "../src/mcp/tools.js";

describe("ingest_folder", () => {
  it("walks a real folder and produces documents + mirror data", async () => {
    const { ctx, matter } = await harness(["ingest"], false);
    const folderDir = mkdtempSync(join(tmpdirNode(), "xberg-ingest-folder-"));
    writeFileSyncNode(join(folderDir, "one.txt"), "Jane Doe met Acme Corp.");
    writeFileSyncNode(join(folderDir, "two.txt"), "Second document, no PII here.");

    const result = await ingestFolder(ctx, { matter_id: matter.id, path: folderDir });
    const parsed = JSON.parse(result.content[0]!.text) as {
      documents_processed: number;
      documents_skipped: number;
      errors: { path: string; message: string }[];
    };

    expect(parsed.documents_processed).toBe(2);
    expect(parsed.documents_skipped).toBe(0);
    expect(parsed.errors).toHaveLength(0);
  });

  it("skips unchanged files on a second call and reports the count", async () => {
    const { ctx, matter } = await harness(["ingest"], false);
    const folderDir = mkdtempSync(join(tmpdirNode(), "xberg-ingest-folder-2-"));
    writeFileSyncNode(join(folderDir, "one.txt"), "stable content");

    await ingestFolder(ctx, { matter_id: matter.id, path: folderDir });
    const second = await ingestFolder(ctx, { matter_id: matter.id, path: folderDir });
    const parsed = JSON.parse(second.content[0]!.text) as { documents_skipped: number };

    expect(parsed.documents_skipped).toBe(1);
  });

  it("rejects ingest_folder without ingest scope", async () => {
    const { ctx, matter } = await harness(["read"], false);
    await expect(ingestFolder(ctx, { matter_id: matter.id, path: "." })).rejects.toThrow(/missing required scope/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/mcp-server test tests/tools.test.ts -t "ingest_folder"`
Expected: FAIL — old `ingestFolder` signature doesn't process real files
(returns a stub `{folder, ingest}` shape, `documents_processed` is
`undefined`).

- [ ] **Step 3: Extend `AppContext` with pipeline deps**

In `services/mcp-server/src/index.ts`, extend `AppContext`:

```ts
import type { IngestDeps } from "@xberg-io/node-pipeline";

export interface AppContext {
  config: AppConfig;
  store: MetadataStore;
  models: ModelCache;
  mirror: MirrorStore;
  vault: KeyVault;
  tokenScopes: AuthScopes[];
  pipeline: Omit<IngestDeps, "store" | "mirror">;
}
```

In `createAppContext`, build `pipeline` from the real
extract/chunk/embed/detectPii functions, resolving GLiNER/e5 model paths via
`models.ensureModel(...)`:

```ts
import { detectPii, embedText, RUST_ALIGNED_PII_TYPES } from "@xberg-io/node-pipeline";
import { DEFAULT_GLINER_MODEL } from "@xberg-io/node-pipeline";

// inside createAppContext, after `models` is constructed:
const pipeline: AppContext["pipeline"] = {
  extract: async (path: string) => {
    const { extract, initWasm } = await import("@xberg-io/xberg-wasm");
    await initWasm();
    const bytes = await import("node:fs/promises").then((fs) => fs.readFile(path));
    const output = await extract({ kind: "bytes", bytes, filename: path });
    const first = output.results[0];
    if (!first) throw new Error(`extraction produced no result for ${path}`);
    return { content: first.content ?? "", pageCount: first.metadata?.pageCount ?? 1 };
  },
  chunk: (content: string) => {
    const CHUNK_SIZE = 1024;
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += CHUNK_SIZE) {
      chunks.push(content.slice(i, i + CHUNK_SIZE));
    }
    return chunks.length > 0 ? chunks : [content];
  },
  embed: async (text: string) => {
    const modelPath = await models.ensureModel("e5.model");
    const tokenizerPath = await models.ensureModel("e5.tokenizer");
    return embedText(text, modelPath, tokenizerPath);
  },
  detectPii: async (text: string) => {
    const modelPath = await models.ensureModel(`${DEFAULT_GLINER_MODEL}.model`);
    const tokenizerPath = await models.ensureModel(`${DEFAULT_GLINER_MODEL}.tokenizer`);
    return detectPii(text, modelPath, tokenizerPath, RUST_ALIGNED_PII_TYPES);
  },
};
```

(This assumes `e5.model`/`e5.tokenizer` manifest entry names — align these to
whatever names the release `manifest.json` actually uses for the e5 model;
`grep` the current manifest generation tooling for the real names before
finalizing this step if they differ.)

Add `"@xberg-io/node-pipeline": "workspace:*"` to
`services/mcp-server/package.json`.

- [ ] **Step 4: Rewrite the `ingest_folder` tool**

Replace the existing `ingestFolder` function in
`services/mcp-server/src/mcp/tools.ts`:

```ts
import { walkFolder } from "@xberg-io/node-pipeline";
import { ingestFile } from "@xberg-io/node-pipeline";

export interface IngestFolderArgs {
  matter_id: string;
  path: string;
  recursive?: boolean;
}

export async function ingestFolder(ctx: AppContext, args: IngestFolderArgs): Promise<ToolResult> {
  const matter = getMatter(ctx, args.matter_id);
  authorize(ctx.tokenScopes, "ingest", matter, args.matter_id);

  const folder = ctx.store.createFolder(args.matter_id, args.path.split(/[/\\]/).pop() ?? args.path, args.path);
  ctx.store.updateFolderStatus(folder.id, "processing");

  const files = await walkFolder(args.path);
  let processed = 0;
  let skipped = 0;
  let piiFound = 0;
  const errors: { path: string; message: string }[] = [];

  for (const file of files) {
    const existing = ctx.store.findDocumentByHash(folder.id, file.contentHash);
    if (existing) {
      skipped += 1;
      continue;
    }
    const doc = await ingestFile(
      { ...ctx.pipeline, store: ctx.store, mirror: ctx.mirror },
      file,
      { folderId: folder.id, matterId: args.matter_id, ingestedVia: "mcp" },
    );
    if (doc.status === "error") {
      errors.push({ path: file.path, message: doc.error_message ?? "unknown error" });
    } else {
      processed += 1;
      piiFound += doc.pii_count;
    }
  }

  ctx.store.updateFolderStatus(folder.id, errors.length > 0 && processed === 0 ? "error" : "done");
  ctx.store.recordAudit(actorFor(ctx), "ingest", "ingest_folder", args.matter_id);

  return jsonResult({
    folder,
    documents_processed: processed,
    documents_skipped: skipped,
    pii_entities_found: piiFound,
    errors,
  });
}
```

Update the registration in `registerTools` (the handler is now async and
takes an object with `recursive` optional — `recursive` is accepted for
forward compatibility with the spec but unused here since `walkFolder` is
always recursive per the approved design):

```ts
server.tool(
  "ingest_folder",
  { matter_id: z.string(), path: z.string(), recursive: z.boolean().optional() },
  async (args) => ingestFolder(ctx, args),
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/mcp-server test tests/tools.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full mcp-server suite for regressions**

Run: `pnpm --filter @xberg-io/mcp-server test`
Expected: PASS — update any other test that constructed `AppContext` manually
(e.g. `tests/tools.test.ts`'s `makeHarness`) to include the new `pipeline`
field (inject the same `vi.fn()`-based fake deps pattern used in Task 8's
`ingest.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add services/mcp-server/src/mcp/tools.ts services/mcp-server/src/index.ts services/mcp-server/package.json services/mcp-server/tests/tools.test.ts
git commit -m "feat(mcp-server): ingest_folder now walks and fully processes a real folder"
```

---

## Group D — Auth & scope hardening

### Task 11: Per-launch REST bearer token

**Files:**

- Modify: `services/mcp-server/src/config.ts`
- Modify: `services/mcp-server/src/index.ts`
- Test: `services/mcp-server/tests/auth.test.ts`

**Interfaces:**

- Produces: `generateSessionToken(dataDir: string): string`, a `handle()` guard rejecting unauthenticated `/api/*` requests with `401`.

- [ ] **Step 1: Write the failing test**

```ts
// services/mcp-server/tests/auth.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, parseArgs } from "../src/config.js";
import { createAppContext, createHttpServer } from "../src/index.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), "xberg-auth-"));
  dirs.push(dir);
  const config = buildConfig(parseArgs(["node", "xberg-mcp", "serve", "--data-dir", dir]));
  const ctx = createAppContext(config);
  const server = createHttpServer(ctx);
  return { dir, config, server };
}

describe("REST bearer token", () => {
  it("writes a session token file on context creation", () => {
    const { dir } = makeServer();
    const token = readFileSync(join(dir, "session.token"), "utf8").trim();
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects /api/* without a matching bearer token", async () => {
    const { dir, server } = makeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no server address");
    const res = await fetch(`http://127.0.0.1:${address.port}/api/matters`);
    expect(res.status).toBe(401);
    server.close();
  });

  it("accepts /api/* with the correct bearer token", async () => {
    const { dir, server } = makeServer();
    const token = readFileSync(join(dir, "session.token"), "utf8").trim();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no server address");
    const res = await fetch(`http://127.0.0.1:${address.port}/api/matters`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    server.close();
  });

  it("still serves /wasm and / without a token", async () => {
    const { server } = makeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no server address");
    const res = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(res.status).toBe(200);
    server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/mcp-server test tests/auth.test.ts`
Expected: FAIL — no `session.token` file is written, `/api/matters` returns
`200` with no auth check.

- [ ] **Step 3: Generate the token in `config.ts`**

Add to `services/mcp-server/src/config.ts`:

```ts
import { randomBytes } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";

export function generateSessionToken(dataDir: string): string {
  const token = randomBytes(32).toString("hex");
  const tokenPath = resolve(dataDir, "session.token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // best-effort on platforms without POSIX chmod semantics
  }
  return token;
}
```

Add `sessionToken: string` to `AppConfig` and set it in `buildConfig`, after
`validateConfig(config)`:

```ts
config.sessionToken = generateSessionToken(config.dataDir);
```

(Add the field to the `AppConfig` interface and set a placeholder before
`validateConfig` runs, since `sessionToken` depends on `dataDir` already
being resolved — mirror the existing `dataDir`/`dbPath` resolution order.)

- [ ] **Step 4: Guard `/api/*` in `handle()`**

In `services/mcp-server/src/index.ts`, at the top of `handle()` (after
`pathname`/`method` are computed, before any route matches):

```ts
if (pathname.startsWith("/api/")) {
  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (provided !== ctx.config.sessionToken) {
    res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Unauthorized", code: "auth", message: "invalid or missing bearer token" }));
    return;
  }
}
```

Log the token once at startup in `main()`, alongside the existing
`console.log` lines:

```ts
console.log(`[xberg-mcp] session token: ${config.sessionToken} (also at ${config.dataDir}/session.token)`);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/mcp-server test tests/auth.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite for regressions**

Run: `pnpm --filter @xberg-io/mcp-server test`
Expected: PASS — any existing test that calls `/api/*` routes directly via
`createHttpServer` (none currently do per the files read during planning, but
confirm) must now pass the bearer token.

- [ ] **Step 7: Commit**

```bash
git add services/mcp-server/src/config.ts services/mcp-server/src/index.ts services/mcp-server/tests/auth.test.ts
git commit -m "feat(mcp-server): require a per-launch bearer token on /api/* routes"
```

---

### Task 12: Non-admin-by-default MCP scopes

**Files:**

- Modify: `services/mcp-server/src/config.ts`
- Modify: `services/mcp-server/src/index.ts`
- Test: `services/mcp-server/tests/scopes.mcp.test.ts`

**Interfaces:**

- Produces: `--elevated` CLI flag parsed into `CliArgs.elevated: boolean`, `createAppContext` deriving `tokenScopes` from it instead of a hardcoded constant.

- [ ] **Step 1: Write the failing test**

```ts
// services/mcp-server/tests/scopes.mcp.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, parseArgs } from "../src/config.js";
import { createAppContext } from "../src/index.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function ctxFor(argv: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "xberg-scopes-"));
  dirs.push(dir);
  const config = buildConfig(parseArgs(["node", "xberg-mcp", ...argv, "--data-dir", dir]));
  return createAppContext(config);
}

describe("MCP session scope", () => {
  it("defaults an mcp session to read+ingest, not redact/admin", () => {
    const ctx = ctxFor(["mcp"]);
    expect(ctx.tokenScopes).toEqual(["read", "ingest"]);
  });

  it("grants full scope with --elevated", () => {
    const ctx = ctxFor(["mcp", "--elevated"]);
    expect(ctx.tokenScopes).toEqual(["read", "ingest", "redact", "admin"]);
  });

  it("serve mode is unaffected (REST auth is the gate there, not MCP scope)", () => {
    const ctx = ctxFor(["serve"]);
    expect(ctx.tokenScopes).toEqual(["read", "ingest", "redact", "admin"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/mcp-server test tests/scopes.mcp.test.ts`
Expected: FAIL — `ctx.tokenScopes` is always
`["read","ingest","redact","admin"]` regardless of command/flag.

- [ ] **Step 3: Parse `--elevated`**

In `services/mcp-server/src/config.ts`, add `elevated: boolean` to `CliArgs`
and parse it in `parseArgs`:

```ts
let elevated = false;
// ...inside the arg-parsing loop, alongside the existing arg checks:
} else if (arg === "--elevated") {
  elevated = true;
}
// ...
return { command, host, port, dataDir, elevated };
```

- [ ] **Step 4: Derive scopes in `createAppContext`**

In `services/mcp-server/src/index.ts`, replace the hardcoded `tokenScopes`
line:

```ts
const tokenScopes: AuthScopes[] =
  config.command === "mcp" && !config.elevated
    ? ["read", "ingest"]
    : ["read", "ingest", "redact", "admin"];
```

(`command`/`elevated` need to flow from `CliArgs` into `AppConfig` —
`buildConfig` already takes `CliArgs`; add `command: args.command,
elevated: args.elevated` to the `AppConfig` object it builds, and the
corresponding fields to the `AppConfig` interface.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/mcp-server test tests/scopes.mcp.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite for regressions**

Run: `pnpm --filter @xberg-io/mcp-server test`
Expected: PASS — `tests/tools.test.ts`'s `harness()` builds `AppContext`
directly with explicit scopes, so it is unaffected; confirm no test relied on
`createAppContext`'s old always-full-scope behavior for the `mcp` command.

- [ ] **Step 7: Commit**

```bash
git add services/mcp-server/src/config.ts services/mcp-server/src/index.ts services/mcp-server/tests/scopes.mcp.test.ts
git commit -m "feat(mcp-server): default MCP sessions to read+ingest scope, require --elevated for redact/admin"
```

---

## Group E — Web UI sync

### Task 13: New REST routes (`/api/folders/:id/documents`, `/api/documents/:id/pii`)

**Files:**

- Modify: `services/mcp-server/src/index.ts`
- Modify: `apps/web/lib/api.ts`
- Test: `services/mcp-server/tests/routes.documents.test.ts`

**Interfaces:**

- Produces: `GET /api/folders/:id/documents` → `{ documents: Document[] }`; `GET /api/documents/:id/pii` → `{ pii: DocumentPiiEntity[] }`; `getFolderDocuments(token, folderId)`, `getDocumentPii(token, documentId)` in `apps/web/lib/api.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// services/mcp-server/tests/routes.documents.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, parseArgs } from "../src/config.js";
import { createAppContext, createHttpServer } from "../src/index.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function makeAuthedServer() {
  const dir = mkdtempSync(join(tmpdir(), "xberg-routes-"));
  dirs.push(dir);
  const config = buildConfig(parseArgs(["node", "xberg-mcp", "serve", "--data-dir", dir]));
  const ctx = createAppContext(config);
  const server = createHttpServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  const token = readFileSync(join(dir, "session.token"), "utf8").trim();
  const base = `http://127.0.0.1:${address.port}`;
  const authedFetch = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { ctx, server, authedFetch };
}

describe("document routes", () => {
  it("returns documents for a folder", async () => {
    const { ctx, server, authedFetch } = await makeAuthedServer();
    const matter = ctx.store.createMatter("Acme v Doe");
    const folder = ctx.store.createFolder(matter.id, "Discovery");
    const doc = ctx.store.createDocument({
      folder_id: folder.id, matter_id: matter.id, path: "/tmp/a.txt", content_hash: "h1", ingested_via: "mcp",
    });

    const res = await authedFetch(`/api/folders/${folder.id}/documents`);
    const body = (await res.json()) as { documents: { id: string }[] };
    expect(res.status).toBe(200);
    expect(body.documents.map((d) => d.id)).toEqual([doc.id]);
    server.close();
  });

  it("returns PII entities for a document", async () => {
    const { ctx, server, authedFetch } = await makeAuthedServer();
    const matter = ctx.store.createMatter("Acme v Doe");
    const folder = ctx.store.createFolder(matter.id, "Discovery");
    const doc = ctx.store.createDocument({
      folder_id: folder.id, matter_id: matter.id, path: "/tmp/a.txt", content_hash: "h1", ingested_via: "mcp",
    });
    ctx.store.insertPiiEntities(doc.id, [{ kind: "person", start: 0, end: 8, text: "Jane Doe" }]);

    const res = await authedFetch(`/api/documents/${doc.id}/pii`);
    const body = (await res.json()) as { pii: { kind: string }[] };
    expect(res.status).toBe(200);
    expect(body.pii).toEqual([expect.objectContaining({ kind: "person" })]);
    server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xberg-io/mcp-server test tests/routes.documents.test.ts`
Expected: FAIL — both routes `404`.

- [ ] **Step 3: Add the routes**

In `services/mcp-server/src/index.ts`, add near the other `/api/folders`
routes:

```ts
const folderDocuments = pathname.match(/^\/api\/folders\/([^/]+)\/documents$/);
if (folderDocuments && method === "GET") {
  const folderId = decodeURIComponent(folderDocuments[1] ?? "");
  sendJson(res, 200, { documents: ctx.store.getDocumentsByFolder(folderId) });
  return;
}

const documentPii = pathname.match(/^\/api\/documents\/([^/]+)\/pii$/);
if (documentPii && method === "GET") {
  const documentId = decodeURIComponent(documentPii[1] ?? "");
  sendJson(res, 200, { pii: ctx.store.getPiiByDocument(documentId) });
  return;
}
```

(Placed before the static-fallback GET handler, same as the existing
`/api/folders`/`/api/consent` routes.)

- [ ] **Step 4: Add client helpers**

In `apps/web/lib/api.ts`:

```ts
import type { Document, DocumentPiiEntity } from "@xberg-io/core";

export async function getFolderDocuments(token: string, folderId: string): Promise<Document[]> {
  const res = await fetch(`${BASE}/folders/${encodeURIComponent(folderId)}/documents`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await json<{ documents: Document[] }>(res);
  return data.documents;
}

export async function getDocumentPii(token: string, documentId: string): Promise<DocumentPiiEntity[]> {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(documentId)}/pii`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await json<{ pii: DocumentPiiEntity[] }>(res);
  return data.pii;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @xberg-io/mcp-server test tests/routes.documents.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add services/mcp-server/src/index.ts apps/web/lib/api.ts services/mcp-server/tests/routes.documents.test.ts
git commit -m "feat(mcp-server,web): add folder-documents and document-PII REST routes"
```

---

### Task 14: `FolderView.tsx` shows MCP-ingested documents with polling

**Files:**

- Modify: `apps/web/app/folders/[id]/FolderView.tsx`

- [ ] **Step 1: Add document-list state and a polling effect**

Add state and an effect that fetches `getFolderDocuments` on mount and polls
every 3s while any document is `"processing"`, stopping once all settle
(place near the existing `matter`/`folder` `useEffect`):

```tsx
const [documents, setDocuments] = useState<DocumentType[]>([]);

useEffect(() => {
  if (!auth || !folderId) return;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    const docs = await getFolderDocuments(auth.token, folderId);
    if (cancelled) return;
    setDocuments(docs);
    if (docs.some((d) => d.status === "processing")) {
      timer = setTimeout(poll, 3000);
    }
  };
  void poll();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}, [auth, folderId]);
```

Import `getFolderDocuments` from `@/lib/api` and `Document as DocumentType`
from `@xberg-io/core` (aliased to avoid clashing with the DOM `Document`
type already implicitly in scope).

- [ ] **Step 2: Render the MCP-ingested list when present**

Add, right after the `<FileDropzone .../>` block, a second render branch:

```tsx
{documents.length > 0 && (
  <div className="mt-6 grid gap-3">
    <h2 className="text-lg font-medium">Ingested documents</h2>
    {documents.map((d) => (
      <Card key={d.id}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{d.path.split(/[/\\]/).pop()}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {d.status === "processing" ? "Processing…" : `${d.pages} pages · ${d.pii_count} PII entities · ${d.chunk_count} chunks`}
          </p>
          {d.status === "error" && <p className="text-xs text-destructive">{d.error_message}</p>}
        </CardContent>
      </Card>
    ))}
  </div>
)}
```

- [ ] **Step 3: Manual verification**

Run: `pnpm --filter @xberg-io/web dev`, then in a separate terminal run
`ingest_folder` via a direct tool call against a folder with 2-3 small text
files (or drive it through Claude Desktop once its MCP config points at this
server). Open the corresponding Folder page in the browser and confirm the
"Ingested documents" list appears with correct per-document status, without
having dropped any files via the browser.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/folders/[id]/FolderView.tsx
git commit -m "feat(web): show MCP-ingested documents in FolderView with status polling"
```

---

### Task 15: `MatterView.tsx` folder status badges

**Files:**

- Modify: `apps/web/app/matters/[id]/MatterView.tsx`

- [ ] **Step 1: Render status/count badges per folder**

Replace the folder list item body (currently just `name` + `id`) to use the
new `Folder` fields already returned by `getFolders` since Task 1:

```tsx
<div
  key={f.id}
  className="rounded-lg border p-4 hover:bg-accent cursor-pointer"
  onClick={() => router.push(`/folders/${f.id}?matter_id=${matterId}`)}
>
  <div className="flex items-center justify-between">
    <div className="font-medium">{f.name}</div>
    <span className="text-xs rounded px-2 py-0.5 bg-muted">{f.status}</span>
  </div>
  <div className="text-sm text-muted-foreground">
    {f.document_count} document{f.document_count === 1 ? "" : "s"} · {f.pii_count} PII entities
  </div>
</div>
```

- [ ] **Step 2: Manual verification**

Run: `pnpm --filter @xberg-io/web dev`, open a Matter with at least one
MCP-ingested folder (from Task 14's manual step) and one never-ingested
folder; confirm the badges show `done`/`0 documents · 0 PII entities`
correctly for each.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/matters/[id]/MatterView.tsx
git commit -m "feat(web): show folder ingest status and counts in MatterView"
```

---

## Self-Review

**1. Spec coverage:**

- Section A (data model) → Tasks 1-3. ✓
- Section B (Node pipeline + GLiNER consolidation) → Tasks 4-8. ✓
- Section C (MCP tool surface) → Tasks 9-10. ✓
- Section D (auth/scope) → Tasks 11-12. ✓
- Section E (Web UI sync) → Tasks 13-15. ✓
- Testing/Verification section's four bullet points map to: node-pipeline unit
  tests (Tasks 4-8), `ingest_folder` integration test (Task 10), auth/scope
  tests (Tasks 11-12), manual Claude-Desktop-to-UI check (Task 14 Step 3). ✓

**2. Placeholder scan:** No `TBD`/`TODO`/"implement later" strings remain.
Task 10 Step 3 has one explicit caveat (align `e5.model`/`e5.tokenizer`
manifest names to whatever the real release manifest uses) — this is a real,
actionable instruction with a concrete verification method (`grep` the
manifest tooling), not a vague placeholder, and is called out rather than
silently assumed.

**3. Type consistency:** `Document`/`DocumentPiiEntity`/`Folder` (Tasks 1-2)
are the same shapes referenced in Task 8's `ingestFile`, Task 10's
`ingestFolder`, Task 13's routes, and Task 14/15's UI. `IngestDeps` (Task 8)
matches the `pipeline` field wired into `AppContext` in Task 10 Step 3 —
`{extract, chunk, embed, detectPii}` without `store`/`mirror` (added at the
call site). `MirrorPiiSpanInput`/`MirrorChunkInput` (Task 3) match the
objects `ingestFile` (Task 8) constructs for `appendMirror`.

**Pre-flight correction (applied before execution):** the original draft had
Task 8's `ingest.ts` importing `MetadataStore`/`MirrorStore` directly from
`@xberg-io/mcp-server`, which — combined with Task 5/10 importing the other
direction — created a circular workspace package dependency, and Task 5's
manifest-merge used a cross-package relative path that resolved to the wrong
directory and would have broken again under a `dist/` build. Fixed by giving
`node-pipeline` structural `DocumentStore`/`MirrorSink` interfaces (Task 8)
and a self-relative `loadGlinerManifestEntries()` (Task 5 Step 6) — the plan
text above already reflects the fix; this note records that it was a
pre-flight change, not part of the original design doc.
