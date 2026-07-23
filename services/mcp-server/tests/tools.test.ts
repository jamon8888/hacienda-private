import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthScopes, Matter } from "@xberg-io/core";
import type { AppContext } from "../src/index.js";
import type { AppConfig } from "../src/config.js";
import { MetadataStore } from "../src/store.js";
import { MirrorStore } from "../src/mirror.js";
import { ModelCache } from "../src/models.js";
import { KeyVault } from "../src/vault.js";
import { AppError, isAppError } from "../src/error.js";
import { SHARED_EMBEDDING_IDENTITY } from "../src/mirror.js";
import {
	listPii,
	ragQuery,
	redact,
	rehydrateChunk,
	listMatters,
	createMatter,
	ingestFolder,
} from "../src/mcp/tools.js";

const VAULT_KEY = Buffer.alloc(32, 7);

interface Harness {
	dir: string;
	ctx: AppContext;
	matter: Matter;
	principal: { subject: string; scopes: AuthScopes[] };
}

function makeConfig(dir: string): AppConfig {
	return {
		host: "127.0.0.1",
		port: 8787,
		dataDir: dir,
		modelCacheDir: join(dir, "models"),
		dbPath: join(dir, "meta.sqlite"),
		vaultPath: join(dir, "vault"),
		vaultKeyPath: join(dir, "vault.key"),
		mirrorsDir: join(dir, "mirrors"),
		manifestPath: join(dir, "manifest.json"),
		jwtSecret: "test",
		sessionToken: "test-session-token",
	};
}

function seedBundle(mirror: MirrorStore, vault: KeyVault, matterId: string): void {
	const ciphertext = vault.seal(Buffer.from("Jane")).toString("base64");
	const bundle = {
		version: 2,
		embedding_identity: SHARED_EMBEDDING_IDENTITY,
		index: [1, 2, 3],
		vault: [4, 5, 6],
		vaultSalt: [7, 8],
		pii: [{ doc_id: "d1", kind: "PER", start: 0, end: 3, token: "t1", ciphertext }],
		chunks: [{ doc_id: "d1", chunk_index: 0, text: "redacted", score: 0.9, citation: "d1#0" }],
	};
	mirror.saveMirror(matterId, Buffer.from(JSON.stringify(bundle)));
}

// Lightweight test doubles for the pipeline deps — real extraction/embedding/PII detection
// require downloaded ONNX models, which unit tests must not depend on. `extract` still reads
// the real file so ingest_folder tests genuinely exercise real folder walks against real files.
function makeFakePipeline(): AppContext["pipeline"] {
	return {
		extract: vi.fn(async (path: string) => ({ content: readFileSync(path, "utf8"), pageCount: 1 })),
		chunk: vi.fn((content: string) => [content]),
		embed: vi.fn(async () => new Array(384).fill(0)),
		detectPii: vi.fn(async (text: string) =>
			text.includes("Jane Doe") ? [{ kind: "person", start: 0, end: 8, text: "Jane Doe" }] : [],
		),
	};
}

async function makeHarness(scopes: AuthScopes[], consent: boolean): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "xberg-tools-"));
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ models: [] }));
	const config = makeConfig(dir);
	const store = new MetadataStore(config.dbPath);
	const mirror = new MirrorStore(config.mirrorsDir);
	const models = new ModelCache(config.modelCacheDir, config.manifestPath);
	const vault = new KeyVault({ key: VAULT_KEY });

	// Consent kinds are stored as free-form TEXT scopes (the store compares by string); the shared
	// ConsentGrant.scope type is AuthScopes, so widen the kind at this test boundary only.
	const consentScope = (kind: string): AuthScopes => kind as AuthScopes;
	const matter = store.createMatter("Acme v Doe");
	const principal = { subject: "owner", scopes };
	if (consent) {
		store.grantConsent({ subject: principal.subject, matter_id: matter.id, scope: consentScope("pii_read") });
		store.grantConsent({
			subject: principal.subject,
			matter_id: matter.id,
			scope: consentScope("redact_rehydrate"),
		});
	}
	seedBundle(mirror, vault, matter.id);
	await mirror.loadMirror(matter.id);

	const ctx: AppContext = {
		config,
		store,
		models,
		mirror,
		vault,
		httpAuth: { token: config.sessionToken, scopes },
		pipeline: makeFakePipeline(),
	};
	return { dir, ctx, matter, principal };
}

let created: Harness[] = [];

async function harness(scopes: AuthScopes[], consent: boolean): Promise<Harness> {
	const h = await makeHarness(scopes, consent);
	created.push(h);
	return h;
}

beforeEach(() => {
	created = [];
});

afterEach(() => {
	for (const h of created) {
		h.ctx.store.close();
		rmSync(h.dir, { recursive: true, force: true });
	}
});

describe("mcp tools", () => {
	it("rag_query fails closed on the Node mirror host", async () => {
		const { ctx, matter, principal } = await harness(["read", "ingest", "redact", "admin"], true);
		expect(() => ragQuery(ctx, principal, { matter_id: matter.id, query: "who" })).toThrowError(
			expect.objectContaining({
				code: "model",
				message:
					"live rag_query is only supported by the native Rust MCP host; the Node mirror only stores metadata bundles",
			}),
		);
		expect(ctx.store.getAuditLog(matter.id).some((a) => a.action === "rag_query")).toBe(false);
	});

	it("list_pii returns the span token, never plaintext", async () => {
		const { ctx, matter, principal } = await harness(["read", "admin"], true);
		const res = listPii(ctx, principal, { matter_id: matter.id, doc_id: "d1" });
		const spans = JSON.parse(res.content[0]?.text ?? "[]") as { kind: string; text: string }[];
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("PER");
		expect(spans[0]?.text).toBe("t1");
		expect(res.content[0]?.text).not.toContain("Jane");
	});

	it("rehydrate_chunk decrypts to plaintext WITH consent", async () => {
		const { ctx, matter, principal } = await harness(["read", "redact", "admin"], true);
		const res = rehydrateChunk(ctx, principal, { matter_id: matter.id, chunk_id: "d1:t1" });
		expect(res.content[0]?.text).toBe("Jane");
	});

	it("rehydrate_chunk is rejected WITHOUT consent", async () => {
		const { ctx, matter, principal } = await harness(["read", "redact", "admin"], false);
		try {
			rehydrateChunk(ctx, principal, { matter_id: matter.id, chunk_id: "d1:t1" });
			throw new Error("expected consent error");
		} catch (err) {
			expect(isAppError(err)).toBe(true);
			expect((err as AppError).code).toBe("consent");
		}
	});

	it("rehydrate_chunk is rejected without redact scope", async () => {
		const { ctx, matter, principal } = await harness(["read"], true);
		try {
			rehydrateChunk(ctx, principal, { matter_id: matter.id, chunk_id: "d1:t1" });
			throw new Error("expected scope error");
		} catch (err) {
			expect(isAppError(err)).toBe(true);
			expect((err as AppError).code).toBe("scope");
		}
	});

	it("redact records a marker with consent + scope", async () => {
		const { ctx, matter, principal } = await harness(["read", "redact", "admin"], true);
		const res = redact(ctx, principal, { matter_id: matter.id, doc_id: "d1", entity_ids: ["e1"] });
		const rec = JSON.parse(res.content[0]?.text ?? "{}") as { doc_id: string; entity_ids: string[] };
		expect(rec.doc_id).toBe("d1");
		expect(rec.entity_ids).toEqual(["e1"]);
	});
});

describe("list_matters / create_matter", () => {
	it("lists existing matters", async () => {
		const { ctx, matter, principal } = await harness(["read"], false);
		const result = listMatters(ctx, principal);
		const parsed = JSON.parse(result.content[0]!.text) as { matters: { id: string }[] };
		expect(parsed.matters.some((m) => m.id === matter.id)).toBe(true);
	});

	it("rejects list_matters without read scope", async () => {
		const { ctx, principal } = await harness([], false);
		expect(() => listMatters(ctx, principal)).toThrow(/missing required scope/);
	});

	it("creates a new matter", async () => {
		const { ctx, principal } = await harness(["ingest"], false);
		const result = createMatter(ctx, principal, { name: "Roe v Wade" });
		const parsed = JSON.parse(result.content[0]!.text) as { name: string };
		expect(parsed.name).toBe("Roe v Wade");
	});

	it("rejects create_matter without ingest scope", async () => {
		const { ctx, principal } = await harness(["read"], false);
		expect(() => createMatter(ctx, principal, { name: "x" })).toThrow(/missing required scope/);
	});
});

describe("ingest_folder", () => {
	let folderDirs: string[] = [];

	afterEach(() => {
		for (const d of folderDirs) {
			rmSync(d, { recursive: true, force: true });
		}
		folderDirs = [];
	});

	function makeFolderDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		folderDirs.push(dir);
		return dir;
	}

	it("walks a real folder and produces documents + mirror data", async () => {
		const { ctx, matter, principal } = await harness(["ingest"], false);
		const folderDir = makeFolderDir("xberg-ingest-folder-");
		writeFileSync(join(folderDir, "one.txt"), "Jane Doe met Acme Corp.");
		writeFileSync(join(folderDir, "two.txt"), "Second document, no PII here.");

		const result = await ingestFolder(ctx, principal, { matter_id: matter.id, path: folderDir });
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
		const { ctx, matter, principal } = await harness(["ingest"], false);
		const folderDir = makeFolderDir("xberg-ingest-folder-2-");
		writeFileSync(join(folderDir, "one.txt"), "stable content");

		await ingestFolder(ctx, principal, { matter_id: matter.id, path: folderDir });
		const second = await ingestFolder(ctx, principal, { matter_id: matter.id, path: folderDir });
		const parsed = JSON.parse(second.content[0]!.text) as { documents_skipped: number };

		expect(parsed.documents_skipped).toBe(1);
	});

	it("rejects ingest_folder without ingest scope", async () => {
		const { ctx, matter, principal } = await harness(["read"], false);
		await expect(ingestFolder(ctx, principal, { matter_id: matter.id, path: "." })).rejects.toThrow(
			/missing required scope/,
		);
	});

	it("marks the folder as errored instead of leaving it stuck in 'processing' when the path doesn't exist", async () => {
		const { ctx, matter, principal } = await harness(["ingest"], false);
		const missingDir = join(tmpdir(), "xberg-ingest-folder-does-not-exist");

		await expect(ingestFolder(ctx, principal, { matter_id: matter.id, path: missingDir })).rejects.toThrow(AppError);

		const folder = ctx.store.getFolders(matter.id).find((f) => f.path === missingDir);
		expect(folder?.status).toBe("error");
	});
});
