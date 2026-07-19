import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AppConfig, buildConfig, parseArgs } from "./config.js";
import { AppError, isAppError } from "./error.js";
import type { AuthScopes } from "@xberg-io/core";
import { MetadataStore, openStore } from "./store.js";
import { ModelCache } from "./models.js";
import { MirrorStore } from "./mirror.js";
import { KeyVault } from "./vault.js";
import { PLACEHOLDER_HTML, resolveUiDir, resolveWasmPackageDir, injectToken } from "./static.js";
import { runMcp } from "./mcp/mod.js";
import type { IngestDeps } from "@xberg-io/node-pipeline";
import { DEFAULT_GLINER_MODEL, RUST_ALIGNED_PII_TYPES, detectPii, embedText } from "@xberg-io/node-pipeline";
import { loadOrCreateSessionToken, resolveLaunchScopes, authenticateHttp, ownerPrincipal } from "./auth.js";
import type { Principal } from "./principal.js";
import { authorize } from "./mcp/scopes.js";
import { requireConsent } from "./mcp/consent.js";

export interface HttpAuth {
	token: string;
	scopes: AuthScopes[];
}

export interface AppContext {
	config: AppConfig;
	store: MetadataStore;
	models: ModelCache;
	mirror: MirrorStore;
	vault: KeyVault;
	httpAuth: HttpAuth;
	pipeline: Omit<IngestDeps, "store" | "mirror">;
}

// Extensions walkFolder() will hand us — kept in sync with node-pipeline's own
// SUPPORTED_EXTENSIONS set (packages/node-pipeline/src/walk.ts). xberg-wasm's `extract` rejects
// empty/unknown MIME types, so every supported extension needs an explicit entry here.
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
	".pdf": "application/pdf",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".doc": "application/msword",
	".txt": "text/plain",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".csv": "text/csv",
	".html": "text/html",
	".htm": "text/html",
	".json": "application/json",
	".rtf": "application/rtf",
};

// Lazily initializes the xberg-wasm module and caches it for the process lifetime.
//
// NOTE: `@xberg-io/xberg-wasm`'s published package is a wasm-pack `--target web` build. Its
// default init function (`export { __wbg_init as default }`) resolves the .wasm binary via
// `new URL("xberg_wasm_bg.wasm", import.meta.url)` and then `fetch()`s it when called with no
// arguments — but Node's built-in `fetch` (undici) does not support `file://` URLs, so that
// default path throws under this Node service. We instead read the binary from disk ourselves
// (resolved via Node's own module resolution against the installed package, not a hardcoded
// node_modules layout) and hand the bytes directly to the init function, which accepts a
// `BufferSource` and skips the fetch path entirely.
let xbergWasmReady: Promise<typeof import("@xberg-io/xberg-wasm")> | null = null;
async function getXbergWasm(): Promise<typeof import("@xberg-io/xberg-wasm")> {
	if (!xbergWasmReady) {
		xbergWasmReady = (async () => {
			const wasm = await import("@xberg-io/xberg-wasm");
			const wasmRequire = createRequire(import.meta.url);
			const entryPath = wasmRequire.resolve("@xberg-io/xberg-wasm");
			const wasmBinaryPath = join(dirname(entryPath), "xberg_wasm_bg.wasm");
			const wasmBytes = await readFile(wasmBinaryPath);
			await wasm.default(wasmBytes);
			return wasm;
		})();
	}
	return xbergWasmReady;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(Buffer.from(c)));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function readJson<T>(req: IncomingMessage): Promise<T> {
	return readBody(req).then((b) => JSON.parse(b.toString("utf8")) as T);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = Buffer.from(JSON.stringify(body), "utf8");
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(data);
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".onnx": "application/octet-stream",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".bin": "application/octet-stream",
	".map": "application/json; charset=utf-8",
};

// Consent grants are keyed by ConsentKind (see mcp/consent.ts), not AuthScopes — the shared
// ConsentGrant.scope field is loosely typed as AuthScopes, but the values that actually mean
// anything to requireConsent() are these two.
const VALID_CONSENT_SCOPES = ["pii_read", "redact_rehydrate"] as const;

// Cross-origin isolation headers required by the browser engine (ORT-Web WASM threads /
// SharedArrayBuffer, WebGPU/WebGL, WASM-SIMD). Next.js `output: "export"` cannot emit custom
// headers, so the Node service sets them on every UI/wasm response instead.
const ISOLATION_HEADERS = {
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-embedder-policy": "require-corp",
} as const;

function serveFile(res: ServerResponse, filePath: string): void {
	if (!existsSync(filePath)) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
		return;
	}
	const ct = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
	res.writeHead(200, { "content-type": ct, ...ISOLATION_HEADERS });
	res.end(readFileSync(filePath));
}

function serveStaticDir(res: ServerResponse, rootDir: string, relPath: string): void {
	const safe = normalize(relPath).replace(/^(\.\.[/\\])+/, "");
	const filePath = join(rootDir, safe);
	if (!filePath.startsWith(rootDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
		return;
	}
	serveFile(res, filePath);
}

async function handleModels(ctx: AppContext, res: ServerResponse, file: string): Promise<void> {
	const entry = ctx.models.resolveByFile(file);
	if (!entry) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
		return;
	}
	try {
		const path = await ctx.models.ensureModel(entry.name);
		serveFile(res, path);
	} catch (err) {
		if (isAppError(err) && err.code === "model") {
			sendJson(res, err.status, err.toJSON());
			return;
		}
		throw err;
	}
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: AppContext, auth: HttpAuth): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const pathname = url.pathname;
	const method = req.method ?? "GET";

	// Public routes: no auth required — in particular, GET / must stay reachable with no token so
	// it can inject the session token the browser needs for every subsequent request. Authentication
	// happens further down, scoped to the routes that actually need it.
	if (pathname === "/" && method === "GET") {
		const uiDir = resolveUiDir();
		let html: string;
		if (uiDir) {
			html = readFileSync(join(uiDir, "index.html"), "utf8");
		} else {
			html = PLACEHOLDER_HTML;
		}
		// Inject session token so same-origin UI can read it
		html = injectToken(html, auth.token);
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			...ISOLATION_HEADERS,
		});
		res.end(html);
		return;
	}

	if (pathname.startsWith("/wasm/") && method === "GET") {
		const wasmDir = resolveWasmPackageDir();
		if (!wasmDir) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("xberg wasm package not installed");
			return;
		}
		serveStaticDir(res, wasmDir, pathname.slice("/wasm/".length));
		return;
	}

	if (pathname.startsWith("/models/") && method === "GET") {
		await handleModels(ctx, res, pathname.slice("/models/".length));
		return;
	}

	// Every remaining route is protected: derive the per-request Principal now (throws
	// AppError "auth" on a missing/invalid Bearer token, or "scope" on a cross-origin request).
	const principal = authenticateHttp(req, auth.token, auth.scopes);

	if (pathname === "/api/matters" && method === "GET") {
		authorize(principal.scopes, "read");
		sendJson(res, 200, { matters: ctx.store.getMatters() });
		return;
	}
	if (pathname === "/api/matters" && method === "POST") {
		authorize(principal.scopes, "ingest");
		const body = await readJson<{ name: string }>(req);
		if (!body.name) throw new AppError("bad_request", "name is required");
		const matter = ctx.store.createMatter(body.name);
		ctx.store.recordAudit(principal.subject, "ingest", "create_matter", matter.id);
		sendJson(res, 201, matter);
		return;
	}

	const forgetMatch = pathname.match(/^\/api\/matters\/([^/]+)$/);
	if (forgetMatch && method === "DELETE") {
		authorize(principal.scopes, "admin");
		const matterId = decodeURIComponent(forgetMatch[1] ?? "");
		const forgotten = ctx.store.forgetMatter(matterId);
		ctx.mirror.forget(matterId);
		ctx.store.recordAudit(principal.subject, "admin", "forget", matterId);
		sendJson(res, 200, { forgotten });
		return;
	}

	if (pathname === "/api/folders" && method === "GET") {
		authorize(principal.scopes, "read");
		const matterId = url.searchParams.get("matter_id");
		if (!matterId) throw new AppError("bad_request", "matter_id is required");
		sendJson(res, 200, { folders: ctx.store.getFolders(matterId) });
		return;
	}
	if (pathname === "/api/folders" && method === "POST") {
		authorize(principal.scopes, "ingest");
		const body = await readJson<{ matter_id: string; name: string; path?: string }>(req);
		if (!body.matter_id || !body.name) throw new AppError("bad_request", "matter_id and name are required");
		const folder = ctx.store.createFolder(body.matter_id, body.name, body.path);
		sendJson(res, 201, folder);
		return;
	}

	if (pathname === "/api/consent" && method === "GET") {
		authorize(principal.scopes, "admin");
		const matterId = url.searchParams.get("matter_id");
		if (!matterId) throw new AppError("bad_request", "matter_id is required");
		sendJson(res, 200, { consent: ctx.store.getConsent(matterId) });
		return;
	}
	if (pathname === "/api/consent" && method === "POST") {
		authorize(principal.scopes, "admin");
		const body = await readJson<{ subject: string; matter_id: string; scope: string; expires_at?: string }>(req);
		if (!body.subject || !body.matter_id || !body.scope) {
			throw new AppError("bad_request", "subject, matter_id and scope are required");
		}
		if (!VALID_CONSENT_SCOPES.includes(body.scope as (typeof VALID_CONSENT_SCOPES)[number])) {
			throw new AppError("bad_request", `unsupported consent scope: ${body.scope}`);
		}
		sendJson(
			res,
			201,
			ctx.store.grantConsent({
				subject: body.subject,
				matter_id: body.matter_id,
				scope: body.scope as AuthScopes,
				expires_at: body.expires_at,
			}),
		);
		return;
	}

	if (pathname === "/api/rag/mirror" && method === "POST") {
		authorize(principal.scopes, "ingest");
		const matterId = url.searchParams.get("matter_id");
		if (!matterId) throw new AppError("bad_request", "matter_id is required");
		const body = await readBody(req);
		const status = ctx.mirror.saveMirror(matterId, body);
		sendJson(res, 201, status);
		return;
	}

	const mirrorStatus = pathname.match(/^\/api\/rag\/mirror\/([^/]+)\/status$/);
	if (mirrorStatus && method === "GET") {
		authorize(principal.scopes, "read");
		const matterId = decodeURIComponent(mirrorStatus[1] ?? "");
		const status = ctx.mirror.status(matterId);
		if (!status) throw new AppError("not_found", `no mirror for matter ${matterId}`);
		sendJson(res, 200, status);
		return;
	}

	// Folder documents + PII routes (for Web UI polling)
	const folderDocsMatch = pathname.match(/^\/api\/folders\/([^/]+)\/documents$/);
	if (folderDocsMatch && method === "GET") {
		authorize(principal.scopes, "read");
		const folderId = decodeURIComponent(folderDocsMatch[1] ?? "");
		sendJson(res, 200, { documents: ctx.store.getDocumentsByFolder(folderId) });
		return;
	}

	const docPiiMatch = pathname.match(/^\/api\/documents\/([^/]+)\/pii$/);
	if (docPiiMatch && method === "GET") {
		authorize(principal.scopes, "read");
		const documentId = decodeURIComponent(docPiiMatch[1] ?? "");
		const doc = ctx.store.getDocument(documentId);
		if (!doc) throw new AppError("not_found", `document ${documentId} not found`);
		const matter = ctx.store.getMatter(doc.matter_id);
		if (!matter) throw new AppError("not_found", `matter ${doc.matter_id} not found`);
		// Mirrors the MCP list_pii tool's gating — this route returns the same raw PII text, so it
		// must not skip the consent check just because it's reached over HTTP instead of MCP.
		requireConsent(ctx.store, matter, "pii_read", principal.subject);
		sendJson(res, 200, { pii: ctx.store.getPiiByDocument(documentId) });
		return;
	}

	res.writeHead(404, { "content-type": "text/plain" });
	res.end("not found");
}

export function createAppContext(config: AppConfig): AppContext {
	const store = openStore(config.dbPath);
	const models = new ModelCache(config.modelCacheDir, config.manifestPath);
	const mirror = new MirrorStore(config.mirrorsDir);
	const vault = new KeyVault({ vaultKeyPath: config.vaultKeyPath });

	// Launch-time scopes from XBERG_SCOPES env (default: all). HTTP auth derives per-request Principal.
	const launchScopes = resolveLaunchScopes(process.env);
	const httpAuth: HttpAuth = { token: config.sessionToken, scopes: launchScopes };

	// ModelCache.ensureModel() re-hashes the full cached model file on every call, even on a cache
	// hit — embed()/detectPii() are called once per chunk/document, so resolving these paths fresh
	// each time would make repeated hashing dominate ingestion cost far more than actual inference.
	// Memoized once per AppContext (mirrors the getXbergWasm lazy-promise pattern above), not
	// module-level, so a fresh createAppContext (e.g. in tests) doesn't reuse another context's cache.
	let e5PathsPromise: Promise<{ modelPath: string; tokenizerPath: string }> | null = null;
	const e5Paths = () => {
		e5PathsPromise ??= (async () => ({
			modelPath: await models.ensureModel("e5-fp32"),
			tokenizerPath: await models.ensureModel("e5-tokenizer"),
		}))();
		return e5PathsPromise;
	};
	let glinerPathsPromise: Promise<{ modelPath: string; tokenizerPath: string }> | null = null;
	const glinerPaths = () => {
		glinerPathsPromise ??= (async () => ({
			modelPath: await models.ensureModel(`${DEFAULT_GLINER_MODEL}.model`),
			tokenizerPath: await models.ensureModel(`${DEFAULT_GLINER_MODEL}.tokenizer`),
		}))();
		return glinerPathsPromise;
	};

	const pipeline: AppContext["pipeline"] = {
		extract: async (path: string) => {
			const wasm = await getXbergWasm();
			const bytes = await readFile(path);
			const mimeType = MIME_TYPES_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
			const input = wasm.WasmExtractInput.fromBytes(new Uint8Array(bytes), mimeType, basename(path));
			const output = await wasm.extract(input, undefined);
			const first = output.results[0];
			if (!first) throw new Error(`extraction produced no result for ${path}`);
			return { content: first.content ?? "", pageCount: first.metadata?.pages?.totalCount ?? 1 };
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
			const { modelPath, tokenizerPath } = await e5Paths();
			return embedText(text, modelPath, tokenizerPath);
		},
		detectPii: async (text: string) => {
			const { modelPath, tokenizerPath } = await glinerPaths();
			return detectPii(text, modelPath, tokenizerPath, RUST_ALIGNED_PII_TYPES);
		},
	};

	return { config, store, models, mirror, vault, httpAuth, pipeline };
}

export function createHttpServer(ctx: AppContext, authOverride?: HttpAuth) {
	const auth = authOverride ?? ctx.httpAuth;
	return createServer((req, res) => {
		handle(req, res, ctx, auth).catch((err) => {
			if (isAppError(err)) {
				sendJson(res, err.status, err.toJSON());
			} else {
				const msg = err instanceof Error ? err.message : "internal error";
				sendJson(res, 500, { error: "InternalError", code: "store", message: msg });
			}
		});
	});
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	if (args.version) {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		console.log(`xberg-mcp ${pkg.version}`);
		return;
	}

	const config = buildConfig(args);
	const ctx = createAppContext(config);

	if (args.command === "mcp") {
		// MCP stdio: the process spawn is the auth boundary; owner holds launch scopes
		const principal = ownerPrincipal(ctx.httpAuth.scopes);
		await runMcp(ctx, principal);
		return;
	}

	const server = createHttpServer(ctx);
	server.listen(config.port, config.host, () => {
		console.log(`[xberg-mcp] serving http://${config.host}:${config.port}`);
		console.log(`[xberg-mcp] data dir: ${config.dataDir}`);
		console.log(`[xberg-mcp] session token: ${config.sessionToken} (also at ${config.dataDir}/session.token)`);
	});
}

// Only run when executed directly (`node dist/index.js ...`), not when imported — this module is
// also imported by tests to reuse createAppContext/createHttpServer without launching a real
// server. Without this guard, merely importing the module (as every mcp-server test does) would
// parse the importing process's own argv, build a real config, and bind a real port as a side
// effect of the import.
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMainModule) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
