---
title: "Document Intelligence App — Plan 4: services/mcp-server MCP tools (Node.js, @modelcontextprotocol/sdk)"
date: 2026-07-15
status: ready
depends_on: [2026-07-15-doc-intel-scaffold-core]
phase: 4
summary: >
  Lightweight Node.js TypeScript MCP server (`services/mcp-server`, @modelcontextprotocol/sdk)
  exposes five lawyer tools to Claude Desktop over stdio: rag_query, list_pii, rehydrate_chunk,
  ingest_folder, redact. The Node service runs NO engine — every tool delegates to the browser-
  mirrored EdgeVec index (loaded in-process, Node build) and the light metadata/consent store
  (Plan 1). Tools are gated by consent + AuthScopes (read|ingest|redact|admin) + matter scope.
---

## Plan 4 — services/mcp-server MCP tools (Node.js)

**Depends on:** Plan 1 (`services/mcp-server` store, consent store, AES-GCM key vault, EdgeVec
mirror loader, `/rag/mirror` endpoint, shared contract types). Plan 4 compiles against those
primitives and adds the MCP surface only.

**Goal:** A local MCP server, launched as `node dist/index.js mcp` over stdio (plus an optional
localhost HTTP/SSE transport for inspection), that exposes five lawyer-facing tools to Claude
Desktop. The server is a *thin* `@modelcontextprotocol/sdk` layer: it never reimplements document
extraction, OCR, NER, embeddings, or RAG — retrieval runs over the **browser-mirrored EdgeVec
index** that the Node service loaded in-process, and rehydration uses the **Node AES-GCM key vault**
that decrypts the browser's mirrored curtain vault. All gating (consent/scopes/matter-scope) is
added here.

> Core principle: **the browser runs the engine; the Node service is a thin mirror + MCP host.**
> VERIFIED surfaces used here: `@modelcontextprotocol/sdk` `Server` + `tool` registration; the
> EdgeVec Node build loaded from the `POST /rag/mirror` file (Plan 1, Task 7); `better-sqlite3`
> metadata; Node `crypto` AES-GCM vault. No xberg crate, no ORT, no rmcp, no xberg-mcp.

---

### Shared contracts (Plan 1 — imported, not redefined here)

Defined in `packages/core/src/types.ts` (Plan 1) and reused verbatim:

```ts
// AuthScopes — deny-by-default; every tool verifies the launched token carries the needed scope.
export type AuthScopes = "read" | "ingest" | "redact" | "admin";

// Matter / Folder — matter scope restricts every tool to its owning matter.
export interface Matter { id: string; name: string; created_at: string }
export interface Folder { id: string; matter_id: string; name: string; path?: string }

// PiiEntity — returned by list_pii; ciphertext present only for owner-rehydratable spans.
export interface PiiEntity { kind: string; start: number; end: number; text: string; ciphertext?: Uint8Array }

// RetrievedChunk — returned by rag_query; redacted text + citation.
export interface RetrievedChunk {
  doc_id: string; chunk_index: number; text: string;
  page?: number; bbox?: { x: number; y: number; w: number; h: number };
  score: number; citation: string;
}

// API surface the app already serves (Plan 1): http://localhost:8787
```

---

### Task 1 — `mcp` subcommand + MCP server bootstrap

- [ ] **Step 1:** `services/mcp-server/package.json` — `@modelcontextprotocol/sdk` already in Plan 1
      deps. Feature-gate the optional HTTP/SSE transport behind a flag so the default stdio build
      stays minimal.

- [ ] **Step 2:** `services/mcp-server/src/index.ts` — the `mcp` subcommand (from Plan 1) calls
      `mcp/mod.ts run()`. `mcp --http` runs the localhost HTTP/SSE transport.

```ts
// in the command dispatch in index.ts
if (cmd === "mcp") {
  const http = args.includes("--http");
  await runMcp(http);   // blocks on the transport
}
```

- [ ] **Step 3:** `services/mcp-server/src/mcp/mod.ts` — declare `run(http: boolean)` that builds the
      `AppContext` (Plan 1 store + vault + mirror loader) and starts the SDK `Server` with
      `serveStdio` or `serveHttp` (localhost `127.0.0.1:8787/mcp`).

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function run(http: boolean): Promise<void> {
  const ctx = await AppContext.fromEnv();
  const svc = await buildServer(ctx);          // SDK Server with lawyer tools
  if (http) {
    // serveHttp on 127.0.0.1:8787/mcp
  } else {
    const transport = new StdioServerTransport();
    await svc.connect(transport);
  }
}
```

- [ ] **Step 4:** Commit scaffold.

```bash
git add services/mcp-server/package.json services/mcp-server/src/index.ts services/mcp-server/src/mcp/mod.ts
git commit -m "feat(mcp): sdk server bootstrap + stdio/http transports"
```

---

### Task 2 — Scopes + consent + matter-scope gating primitives

- [ ] **Step 1:** `services/mcp-server/src/mcp/scopes.ts` — verify the launcher's token
      (`AuthScopes` from Plan 1's auth) and matter scope before each tool. Deny-by-default.

```ts
import type { AuthScopes, Matter } from "@xberg-io/core";

export function authorize(tokenScopes: AuthScopes[], required: AuthScopes,
                          matter: Matter, requestedMatterId: string): void {
  if (!tokenScopes.includes(required) && !tokenScopes.includes("admin"))
    throw new Error(`missing scope '${required}' for tool`);
  if (matter.id !== requestedMatterId)
    throw new Error(`matter ${requestedMatterId} out of token scope`);
}
```

- [ ] **Step 2:** `services/mcp-server/src/mcp/consent.ts` — before any tool returns PII or
      redacted-origin content, check the Plan 1 consent store for an active grant scoped to the
      matter + tool kind. Refuse with a clear, non-leaking message otherwise.

```ts
import type { Matter } from "@xberg-io/core";

export type ConsentKind = "pii_read" | "redact_rehydrate";

export function requireConsent(store: MetadataStore, matter: Matter, kind: ConsentKind): void {
  if (!store.isConsentActive("*", matter.id, kind))
    throw new Error(`action requires explicit consent for matter ${matter.id}`);
}
```

- [ ] **Step 3:** `services/mcp-server/src/mcp/vault.ts` — owner-only AES-GCM key vault wrapper used
      by `rehydrate_chunk`. The vault handle is supplied by Plan 1's `AppContext`; this module only
      decrypts the browser-mirrored curtain vault. Never logs plaintext.

- [ ] **Step 4:** Commit.

```bash
git add services/mcp-server/src/mcp/scopes.ts services/mcp-server/src/mcp/consent.ts services/mcp-server/src/mcp/vault.ts
git commit -m "feat(mcp): scopes + consent + matter-scope gating + key vault decrypt"
```

---

### Task 3 — Lawyer tools (delegate to mirror + metadata, never reimplement)

- [ ] **Step 1:** `services/mcp-server/src/mcp/tools.ts` — register the five tools via the SDK
      `tool` registration. Each tool's body: authorize → (consent if applicable) → read the loaded
      EdgeVec mirror index (Plan 1, Task 7) or metadata store → return contract-shaped JSON. No
      extraction/OCR/NER/embedding/RAG logic lives here.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorize } from "./scopes.js";
import { requireConsent, ConsentKind } from "./consent.js";

export function registerTools(server: McpServer, ctx: AppContext): void {
  // rag_query: hybrid retrieval over the browser-mirrored EdgeVec index (e5 vectors).
  server.tool("rag_query",
    { matter_id: z.string(), query: z.string(), top_k: z.number().optional() },
    async ({ matter_id, query, top_k }) => {
      const matter = ctx.store.getMatter(matter_id);
      authorize(ctx.tokenScopes, "read", matter, matter_id);
      requireConsent(ctx.store, matter, "pii_read");
      const chunks = await ctx.mirror.retrieve(matter_id, query, top_k ?? 8);
      return { content: [{ type: "json", json: chunks }] };
    });

  // list_pii: PII spans from the mirror metadata (tokens, not values unless rehydrated).
  server.tool("list_pii",
    { doc_id: z.string(), matter_id: z.string() },
    async ({ doc_id, matter_id }) => {
      const matter = ctx.store.getMatter(matter_id);
      authorize(ctx.tokenScopes, "read", matter, matter_id);
      requireConsent(ctx.store, matter, "pii_read");
      const ents = await ctx.mirror.listPii(matter_id, doc_id);
      return { content: [{ type: "json", json: ents }] };
    });

  // rehydrate_chunk: owner-only decrypt from the mirrored curtain vault → original redacted text.
  server.tool("rehydrate_chunk",
    { chunk_ref: z.string(), matter_id: z.string() },
    async ({ chunk_ref, matter_id }) => {
      const matter = ctx.store.getMatter(matter_id);
      authorize(ctx.tokenScopes, "redact", matter, matter_id);
      requireConsent(ctx.store, matter, "redact_rehydrate");
      const cipher = await ctx.mirror.loadCipher(matter_id, chunk_ref);
      return { content: [{ type: "text", text: ctx.vault.open(cipher) }] };
    });

  // ingest_folder: record folder metadata (browser already did extract/embed/index on-device).
  server.tool("ingest_folder",
    { folder_id: z.string(), matter_id: z.string },
    async ({ folder_id, matter_id }) => {
      const matter = ctx.store.getMatter(matter_id);
      authorize(ctx.tokenScopes, "ingest", matter, matter_id);
      const report = await ctx.store.recordIngest(folder_id, matter_id);
      return { content: [{ type: "json", json: report }] };
    });

  // redact: record a redaction marker in metadata (browser applied curtain tokens on-device).
  server.tool("redact",
    { doc_id: z.string(), matter_id: z.string, entity_ids: z.array(z.string()).optional() },
    async ({ doc_id, matter_id, entity_ids }) => {
      const matter = ctx.store.getMatter(matter_id);
      authorize(ctx.tokenScopes, "redact", matter, matter_id);
      requireConsent(ctx.store, matter, "redact_rehydrate");
      const report = await ctx.store.recordRedaction(doc_id, matter_id, entity_ids);
      return { content: [{ type: "json", json: report }] };
    });
}
```

- [ ] **Step 2:** `services/mcp-server/src/mcp/mod.ts` — assemble the SDK `Server`/`McpServer`,
      inject `AppContext` (Plan 1), and attach `registerTools`. Transport selection happens in `run`.

- [ ] **Step 3:** Unit tests in `services/mcp-server/src/mcp/tools.test.ts`:
      assert scope denial without `read`; assert `rehydrate_chunk` refuses without consent;
      assert `rag_query` over a seeded mirror index returns cited `RetrievedChunk[]`. Tests drive
      the handlers directly (no MCP wire needed).

- [ ] **Step 4:** Commit.

```bash
git add services/mcp-server/src/mcp/tools.ts services/mcp-server/src/mcp/mod.ts
git commit -m "feat(mcp): rag_query/list_pii/rehydrate_chunk/ingest_folder/redact lawyer tools"
```

---

### Task 4 — Claude Desktop config + verification harness

- [ ] **Step 1:** Document the Claude Desktop `claude_desktop_config.json` snippet (README / docs):

```json
{
  "mcpServers": {
    "xberg-lawyer": {
      "command": "node",
      "args": ["/path/to/services/mcp-server/dist/index.js", "mcp"]
    }
  }
}
```

- [ ] **Step 2:** Optional `mcp --http` note for the MCP Inspector (localhost only):
      `npx @modelcontextprotocol/inspector http://127.0.0.1:8787/mcp`.

- [ ] **Step 3:** Commit docs.

```bash
git add docs/ ; git commit -m "docs(mcp): Claude Desktop config + inspector notes"
```

---

### Exit criteria

- `node dist/index.js mcp` launches over stdio; `node dist/index.js mcp --http` serves localhost HTTP/SSE.
- Five tools registered: `rag_query`, `list_pii`, `rehydrate_chunk`, `ingest_folder`, `redact`.
- Every tool delegates to the browser-mirrored EdgeVec index + light metadata/consent store; no
  extraction/OCR/NER/embedding/RAG logic reimplemented in Node.
- Scope (`read|ingest|redact|admin`) + matter-scope + consent gates enforced; denial is clear and
  non-leaking; `rehydrate_chunk` requires `redact` scope + explicit consent + owner key.
- `rag_query` against a seeded mirror returns cited `RetrievedChunk[]`; `list_pii` returns
  `PiiEntity[]`; `rehydrate_chunk` is blocked without consent in tests.

### Depends on

Plan 1 (`services/mcp-server` store, consent store, AES-GCM key vault, EdgeVec mirror loader,
`/rag/mirror` endpoint, shared contract types) and the `@modelcontextprotocol/sdk` npm package.

### Risks / Non-goals

- **Do NOT reimplement** extract, OCR, NER, embeddings, or RAG in Node. Those run in the browser;
  the Node MCP layer only orchestrates over the mirrored EdgeVec index and gates access.
- **Non-goal: remote MCP.** Only local stdio + localhost HTTP/SSE for the inspector. No public
  network exposure, no multi-tenant auth at the MCP layer (auth/scopes/consent come from the local
  launcher token + Plan 1 consent store).
- Key-vault key material is owner-only (Plan 1); the MCP layer never handles raw key bytes and
  never logs plaintext.
- The Node service depends on the browser having pushed a fresh `/rag/mirror` for `rag_query` to
  return current results when the browser is closed; with the browser open, the browser serves its
  own live index and rehydration directly.
