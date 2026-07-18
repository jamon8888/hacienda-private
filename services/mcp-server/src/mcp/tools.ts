import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../index.js";
import { AppError } from "../error.js";
import { authorize } from "./scopes.js";
import { requireConsent } from "./consent.js";

// NOTE: the current @modelcontextprotocol/sdk ContentBlock union has no `type: "json"` variant, so
// JSON payloads are returned as a `type: "text"` block carrying `JSON.stringify(...)`. The intent
// (structured JSON per the plan) is preserved; the wire shape is the SDK-valid one.
type ToolResult = { content: { type: "text"; text: string }[] };

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function getMatter(ctx: AppContext, matterId: string) {
  const matter = ctx.store.getMatter(matterId);
  if (!matter) {
    throw new AppError("not_found", `matter ${matterId} not found`);
  }
  return matter;
}

function wrap(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : "tool failed";
    throw new AppError("store", msg);
  }
}

export interface RagQueryArgs {
  matter_id: string;
  query: string;
  top_k?: number;
}
export interface ListPiiArgs {
  matter_id: string;
  doc_id: string;
}
export interface RehydrateChunkArgs {
  matter_id: string;
  chunk_id: string;
}
export interface IngestFolderArgs {
  matter_id: string;
  name: string;
  path?: string;
}
export interface RedactArgs {
  matter_id: string;
  doc_id: string;
  entity_ids?: string[];
}

export function ragQuery(ctx: AppContext, args: RagQueryArgs): ToolResult {
  return wrap(() => {
    const matter = getMatter(ctx, args.matter_id);
    authorize(ctx.tokenScopes, "read", matter, args.matter_id);
    requireConsent(ctx.store, matter, "pii_read");
    const chunks = ctx.mirror.retrieve(args.matter_id, args.query, args.top_k ?? 8);
    ctx.store.recordAudit(actorFor(ctx), "read", "rag_query", args.matter_id);
    return jsonResult(chunks);
  });
}

export function listPii(ctx: AppContext, args: ListPiiArgs): ToolResult {
  return wrap(() => {
    const matter = getMatter(ctx, args.matter_id);
    authorize(ctx.tokenScopes, "read", matter, args.matter_id);
    requireConsent(ctx.store, matter, "pii_read");
    const result = jsonResult(ctx.mirror.listPii(args.matter_id, args.doc_id));
    ctx.store.recordAudit(actorFor(ctx), "read", "list_pii", args.matter_id);
    return result;
  });
}

export function rehydrateChunk(ctx: AppContext, args: RehydrateChunkArgs): ToolResult {
  return wrap(() => {
    const matter = getMatter(ctx, args.matter_id);
    authorize(ctx.tokenScopes, "redact", matter, args.matter_id);
    requireConsent(ctx.store, matter, "redact_rehydrate");
    const cipher = ctx.mirror.loadCipher(args.matter_id, args.chunk_id);
    const text = ctx.vault.open(cipher).toString("utf8");
    ctx.store.recordAudit(actorFor(ctx), "redact", "rehydrate_chunk", args.matter_id);
    return textResult(text);
  });
}

export function ingestFolder(ctx: AppContext, args: IngestFolderArgs): ToolResult {
  return wrap(() => {
    const matter = getMatter(ctx, args.matter_id);
    authorize(ctx.tokenScopes, "ingest", matter, args.matter_id);
    const folder = ctx.store.createFolder(args.matter_id, args.name, args.path);
    const record = ctx.store.recordIngest(folder.id, args.matter_id);
    ctx.store.recordAudit(actorFor(ctx), "ingest", "ingest_folder", args.matter_id);
    return jsonResult({ folder, ingest: record });
  });
}

export function redact(ctx: AppContext, args: RedactArgs): ToolResult {
  return wrap(() => {
    const matter = getMatter(ctx, args.matter_id);
    authorize(ctx.tokenScopes, "redact", matter, args.matter_id);
    requireConsent(ctx.store, matter, "redact_rehydrate");
    const record = ctx.store.recordRedaction(args.doc_id, args.matter_id, args.entity_ids ?? []);
    ctx.store.recordAudit(actorFor(ctx), "redact", "redact", args.matter_id);
    return jsonResult(record);
  });
}

function actorFor(ctx: AppContext): string {
  return `mcp:${ctx.tokenScopes.join(",")}`;
}

export function registerTools(server: McpServer, ctx: AppContext): void {
  server.tool(
    "rag_query",
    { matter_id: z.string(), query: z.string(), top_k: z.number().int().min(1).optional() },
    async (args) => ragQuery(ctx, args),
  );

  server.tool("list_pii", { matter_id: z.string(), doc_id: z.string() }, async (args) => listPii(ctx, args));

  server.tool("rehydrate_chunk", { matter_id: z.string(), chunk_id: z.string() }, async (args) =>
    rehydrateChunk(ctx, args),
  );

  server.tool("ingest_folder", { matter_id: z.string(), name: z.string(), path: z.string().optional() }, async (args) =>
    ingestFolder(ctx, args),
  );

  server.tool(
    "redact",
    { matter_id: z.string(), doc_id: z.string(), entity_ids: z.array(z.string()).optional() },
    async (args) => redact(ctx, args),
  );
}
