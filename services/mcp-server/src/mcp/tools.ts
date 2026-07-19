import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../index.js";
import { AppError } from "../error.js";
import { authorize } from "./scopes.js";
import { requireConsent } from "./consent.js";
import { ingestFile, walkFolder } from "@xberg-io/node-pipeline";
import type { Principal } from "../principal.js";

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
	path: string;
}
export interface RedactArgs {
	matter_id: string;
	doc_id: string;
	entity_ids?: string[];
}

export function ragQuery(ctx: AppContext, principal: Principal, args: RagQueryArgs): ToolResult {
	return wrap(() => {
		const matter = getMatter(ctx, args.matter_id);
		authorize(principal.scopes, "read");
		requireConsent(ctx.store, matter, "pii_read", principal.subject);
		const chunks = ctx.mirror.retrieve(args.matter_id, args.query, args.top_k ?? 8);
		ctx.store.recordAudit(principal.subject, "read", "rag_query", args.matter_id);
		return jsonResult(chunks);
	});
}

export function listPii(ctx: AppContext, principal: Principal, args: ListPiiArgs): ToolResult {
	return wrap(() => {
		const matter = getMatter(ctx, args.matter_id);
		authorize(principal.scopes, "read");
		requireConsent(ctx.store, matter, "pii_read", principal.subject);
		const result = jsonResult(ctx.mirror.listPii(args.matter_id, args.doc_id));
		ctx.store.recordAudit(principal.subject, "read", "list_pii", args.matter_id);
		return result;
	});
}

export function rehydrateChunk(ctx: AppContext, principal: Principal, args: RehydrateChunkArgs): ToolResult {
	return wrap(() => {
		const matter = getMatter(ctx, args.matter_id);
		authorize(principal.scopes, "redact");
		requireConsent(ctx.store, matter, "redact_rehydrate", principal.subject);
		const cipher = ctx.mirror.loadCipher(args.matter_id, args.chunk_id);
		const text = ctx.vault.open(cipher).toString("utf8");
		ctx.store.recordAudit(principal.subject, "redact", "rehydrate_chunk", args.matter_id);
		return textResult(text);
	});
}

export async function ingestFolder(ctx: AppContext, principal: Principal, args: IngestFolderArgs): Promise<ToolResult> {
	const matter = getMatter(ctx, args.matter_id);
	authorize(principal.scopes, "ingest");

	// Reuse the folder row for a path already ingested under this matter, rather than creating a
	// fresh one on every call: findDocumentByHash below is scoped by folder.id, so a brand-new
	// folder on each call would defeat the whole "skip unchanged files" contract this tool exists
	// to provide (there would never be a folder.id in common to look up an existing document by).
	const folder =
		ctx.store.getFolders(args.matter_id).find((f) => f.path === args.path) ??
		ctx.store.createFolder(args.matter_id, args.path.split(/[/\\]/).pop() ?? args.path, args.path);
	ctx.store.updateFolderStatus(folder.id, "processing");

	// Unlike ragQuery/listPii/etc., this tool is async and can't route through the sync-only
	// wrap() helper — it needs its own error containment so a thrown error (bad path, permission
	// denied, a store call failing mid-loop) doesn't leave the folder stuck in "processing"
	// forever from the perspective of anyone polling its status, and still normalizes to AppError
	// like every other tool.
	try {
		const files = await walkFolder(args.path);
		let processed = 0;
		let skipped = 0;
		let piiFound = 0;
		const errors: { path: string; message: string }[] = [];

		for (const file of files) {
			const existing = ctx.store.findDocumentByHash(folder.id, file.contentHash);
			// A previously-errored document must be retried, not counted as already-skipped —
			// ingestFile applies the same rule internally when it re-processes it below.
			if (existing && existing.status !== "error") {
				skipped += 1;
				continue;
			}
			const doc = await ingestFile({ ...ctx.pipeline, store: ctx.store, mirror: ctx.mirror }, file, {
				folderId: folder.id,
				matterId: args.matter_id,
				ingestedVia: "mcp",
			});
			if (doc.status === "error") {
				errors.push({ path: file.path, message: doc.error_message ?? "unknown error" });
			} else {
				processed += 1;
				piiFound += doc.pii_count;
			}
		}

		ctx.store.updateFolderStatus(folder.id, errors.length > 0 && processed === 0 ? "error" : "done");
		ctx.store.recordAudit(principal.subject, "ingest", "ingest_folder", args.matter_id);

		return jsonResult({
			folder,
			documents_processed: processed,
			documents_skipped: skipped,
			pii_entities_found: piiFound,
			errors,
		});
	} catch (err) {
		ctx.store.updateFolderStatus(folder.id, "error");
		if (err instanceof AppError) throw err;
		throw new AppError("store", err instanceof Error ? err.message : "ingest_folder failed");
	}
}

export function redact(ctx: AppContext, principal: Principal, args: RedactArgs): ToolResult {
	return wrap(() => {
		const matter = getMatter(ctx, args.matter_id);
		authorize(principal.scopes, "redact");
		requireConsent(ctx.store, matter, "redact_rehydrate", principal.subject);
		const record = ctx.store.recordRedaction(args.doc_id, args.matter_id, args.entity_ids ?? []);
		ctx.store.recordAudit(principal.subject, "redact", "redact", args.matter_id);
		return jsonResult(record);
	});
}

export function listMatters(ctx: AppContext, principal: Principal): ToolResult {
	return wrap(() => {
		authorize(principal.scopes, "read");
		return jsonResult({ matters: ctx.store.getMatters() });
	});
}

export interface CreateMatterArgs {
	name: string;
}

export function createMatter(ctx: AppContext, principal: Principal, args: CreateMatterArgs): ToolResult {
	return wrap(() => {
		authorize(principal.scopes, "ingest");
		const matter = ctx.store.createMatter(args.name);
		ctx.store.recordAudit(principal.subject, "ingest", "create_matter", matter.id);
		return jsonResult(matter);
	});
}

export function registerTools(server: McpServer, ctx: AppContext, principal: Principal): void {
	server.tool(
		"rag_query",
		{ matter_id: z.string(), query: z.string(), top_k: z.number().int().min(1).optional() },
		async (args) => ragQuery(ctx, principal, args),
	);

	server.tool("list_pii", { matter_id: z.string(), doc_id: z.string() }, async (args) =>
		listPii(ctx, principal, args),
	);

	server.tool("rehydrate_chunk", { matter_id: z.string(), chunk_id: z.string() }, async (args) =>
		rehydrateChunk(ctx, principal, args),
	);

	server.tool("ingest_folder", { matter_id: z.string(), path: z.string() }, async (args) =>
		ingestFolder(ctx, principal, args),
	);

	server.tool(
		"redact",
		{ matter_id: z.string(), doc_id: z.string(), entity_ids: z.array(z.string()).optional() },
		async (args) => redact(ctx, principal, args),
	);

	server.tool("list_matters", {}, async () => listMatters(ctx, principal));

	server.tool("create_matter", { name: z.string() }, async (args) => createMatter(ctx, principal, args));
}
