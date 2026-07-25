import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
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
import { PLACEHOLDER_HTML, resolveUiDir, resolveWasmPackageDir, resolveEmbedPdfiumDir, injectToken } from "./static.js";
import { runMcp } from "./mcp/mod.js";
import type { IngestDeps } from "@xberg-io/node-pipeline";
import {
  DEFAULT_GLINER_MODEL,
  GLINER2_MANIFEST_NAMES,
  RUST_ALIGNED_PII_TYPES,
  configureGliner2NativeFacade,
  detectGliner2,
  detectPii,
  embedText,
  type Gliner2ArtifactPaths,
} from "@xberg-io/node-pipeline";
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

/**
 * Verify and resolve a native GLiNER2 artifact set through the same pinned
 * ModelCache used by the legacy ONNX pipeline. The generated xberg-node
 * façade should consume the returned `modelDir`; keeping this seam explicit
 * avoids accidentally falling back to an unverified download or inventing a
 * JS implementation of Candle inference.
 */
export function ensureGliner2ModelArtifacts(
  ctx: AppContext,
  names: {
    weights: string;
    tokenizer: string;
    encoderConfig: string;
  } = GLINER2_MANIFEST_NAMES,
): Promise<Gliner2ArtifactPaths> {
  return ctx.models.ensureGliner2Artifacts(names);
}

let nativeGliner2Ready: Promise<boolean> | undefined;

type NativeGliner2Module = typeof import("@xberg-io/xberg") & {
  detectCandleEntities(
    text: string,
    modelDir: string,
    adapterDir: string | undefined,
    categories: unknown[],
    customLabels: string[],
  ): Promise<
    ReadonlyArray<{
      category: unknown;
      start: number;
      end: number;
      text: string;
    }>
  >;
};

async function configureNativeGliner2(): Promise<boolean> {
  nativeGliner2Ready ??= (async () => {
    try {
      const native = (await import("@xberg-io/xberg")) as unknown as NativeGliner2Module;
      configureGliner2NativeFacade({
        detectGliner2: async (text, modelDir, labels) => {
          const entities = await native.detectCandleEntities(text, modelDir, undefined, [], [...labels]);
          return entities.map((entity) => ({
            kind: String(entity.category),
            start: entity.start,
            end: entity.end,
            text: entity.text,
          }));
        },
      });
      return true;
    } catch {
      return false;
    }
  })();
  return nativeGliner2Ready;
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
const VALID_DOCUMENT_STATUSES = ["processing", "done", "error"] as const;

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
  // Stream rather than readFileSync: model files are 200–800 MB, and reading one fully into a
  // Buffer synchronously blocked the single Node event loop for the whole read (plus held the
  // entire model in memory), serializing every other request behind it — enough back-to-back
  // giant-model serves to look like a multi-minute stall. createReadStream().pipe() yields between
  // chunks and streams straight to the socket.
  const size = statSync(filePath).size;
  res.writeHead(200, {
    "content-type": ct,
    "content-length": String(size),
    ...ISOLATION_HEADERS,
  });
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    // Headers are already sent, so we can't switch to a 5xx — just tear the connection down so
    // the client sees a truncated/failed transfer rather than hanging forever.
    res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function serveHtmlWithToken(res: ServerResponse, filePath: string, token: string, status = 200): void {
  const html = injectToken(readFileSync(filePath, "utf8"), token);
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...ISOLATION_HEADERS,
  });
  res.end(html);
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
    const indexPath = uiDir ? join(uiDir, "index.html") : null;
    if (indexPath && existsSync(indexPath)) {
      serveHtmlWithToken(res, indexPath, auth.token);
    } else {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...ISOLATION_HEADERS,
      });
      res.end(injectToken(PLACEHOLDER_HTML, auth.token));
    }
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

  if (pathname.startsWith("/vendor/embedpdf/") && method === "GET") {
    const pdfiumDir = resolveEmbedPdfiumDir();
    if (!pdfiumDir) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("@embedpdf/pdfium package not installed");
      return;
    }
    serveStaticDir(res, pdfiumDir, pathname.slice("/vendor/embedpdf/".length));
    return;
  }

  if (pathname === "/models/manifest.json" && method === "GET") {
    sendJson(res, 200, ctx.models.getManifest());
    return;
  }

  if (pathname.startsWith("/models/") && method === "GET") {
    await handleModels(ctx, res, pathname.slice("/models/".length));
    return;
  }

  // Static assets from the export: also public — Next.js's own built JS/CSS chunks
  // (/_next/static/*) plus anything else next export drops next to the pages (favicon, etc.).
  // There was previously NO route for these at all: every page's HTML loaded fine (200), but
  // every script/stylesheet it referenced 404'd, so nothing ever hydrated — the app has never
  // actually been able to run against this server, only against `next dev`'s own server on a
  // separate port.
  if (method === "GET" && !pathname.startsWith("/api/") && pathname !== "/") {
    const uiDir = resolveUiDir();
    if (uiDir) {
      const assetPath = join(uiDir, decodeURIComponent(pathname));
      if (assetPath.startsWith(uiDir) && existsSync(assetPath) && !statSync(assetPath).isDirectory()) {
        serveFile(res, assetPath);
        return;
      }
    }
  }

  // SPA fallback: also public, same reasoning as "/" above — the static export only ever
  // produces a page per *route*, not per dynamic id (`app/documents/[id]/page.tsx`'s
  // generateStaticParams emits a single `documents/_.html` shell that reads the real id
  // client-side). Without this, a direct navigation or a full-page reload of /documents/:id,
  // /folders/:id, /matters/:id, /browse, /search, or /onboarding 404'd — even though those
  // pages work fine as client-side (Link/router.push) transitions from within an
  // already-loaded page. Gating the shell itself behind auth would defeat the fix: a fresh
  // tab hitting a deep link has no token yet either (data still comes from the authenticated
  // /api/* calls the shell's client JS makes once it loads).
  if (method === "GET" && !pathname.startsWith("/api/")) {
    const uiDir = resolveUiDir();
    if (uiDir) {
      const segments = pathname.split("/").filter(Boolean);
      const candidates =
        segments.length === 2
          ? [join(uiDir, ...segments) + ".html", join(uiDir, segments[0]!, "_.html")]
          : segments.length === 1
            ? [join(uiDir, `${segments[0]}.html`)]
            : [];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          serveHtmlWithToken(res, candidate, auth.token);
          return;
        }
      }
      const notFoundPage = join(uiDir, "404.html");
      if (existsSync(notFoundPage)) {
        serveHtmlWithToken(res, notFoundPage, auth.token, 404);
        return;
      }
    }
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
    const body = await readJson<{
      matter_id: string;
      name: string;
      path?: string;
    }>(req);
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
    const body = await readJson<{
      subject: string;
      matter_id: string;
      scope: string;
      expires_at?: string;
    }>(req);
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
    // saveMirror is atomic (all-or-nothing on disk), so only a successful write reaches this
    // audit call — a failed write throws above and is never audited.
    const status = ctx.mirror.saveMirror(matterId, body);
    ctx.store.recordAudit(principal.subject, "ingest", "save_mirror", matterId);
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
  // Registers a document ingested entirely client-side (browser WASM pipeline): the browser
  // never uploads the raw file here, only the metadata needed for matter-nav/folder-view to
  // show it — extraction, OCR, PII detection, and redaction all already happened locally.
  if (folderDocsMatch && method === "POST") {
    authorize(principal.scopes, "ingest");
    const folderId = decodeURIComponent(folderDocsMatch[1] ?? "");
    const folder = ctx.store.getFolder(folderId);
    if (!folder) throw new AppError("not_found", `folder ${folderId} not found`);
    const body = await readJson<{ path: string; content_hash: string }>(req);
    if (!body.path || !body.content_hash) {
      throw new AppError("bad_request", "path and content_hash are required");
    }
    const doc = ctx.store.createDocument({
      folder_id: folderId,
      matter_id: folder.matter_id,
      path: body.path,
      content_hash: body.content_hash,
      ingested_via: "browser",
    });
    ctx.store.recordAudit(principal.subject, "ingest", "create_document", folder.matter_id);
    sendJson(res, 201, doc);
    return;
  }

  const docStatusMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (docStatusMatch && method === "GET") {
    authorize(principal.scopes, "read");
    const documentId = decodeURIComponent(docStatusMatch[1] ?? "");
    const doc = ctx.store.getDocument(documentId);
    if (!doc) throw new AppError("not_found", `document ${documentId} not found`);
    sendJson(res, 200, doc);
    return;
  }

  // Client-side ingestion is synchronous from the browser's perspective, but the folder-view
  // poll loop needs a status transition to reflect completion (or failure) without a reload.
  if (docStatusMatch && method === "PATCH") {
    authorize(principal.scopes, "ingest");
    const documentId = decodeURIComponent(docStatusMatch[1] ?? "");
    const existing = ctx.store.getDocument(documentId);
    if (!existing) throw new AppError("not_found", `document ${documentId} not found`);
    const body = await readJson<{
      status: "processing" | "done" | "error";
      pages?: number;
      chunk_count?: number;
      pii_count?: number;
      error_message?: string;
    }>(req);
    if (!body.status) throw new AppError("bad_request", "status is required");
    if (!VALID_DOCUMENT_STATUSES.includes(body.status)) {
      throw new AppError("bad_request", `unsupported status: ${body.status}`);
    }
    ctx.store.updateDocumentStatus(documentId, body.status, {
      pages: body.pages,
      chunk_count: body.chunk_count,
      pii_count: body.pii_count,
      error_message: body.error_message,
    });
    ctx.store.recordAudit(principal.subject, "ingest", "update_document_status", existing.matter_id);
    sendJson(res, 200, ctx.store.getDocument(documentId));
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
  const httpAuth: HttpAuth = {
    token: config.sessionToken,
    scopes: launchScopes,
  };

  // ModelCache.ensureModel() re-hashes the full cached model file on every call, even on a cache
  // hit — embed()/detectPii() are called once per chunk/document, so resolving these paths fresh
  // each time would make repeated hashing dominate ingestion cost far more than actual inference.
  // Memoized once per AppContext (mirrors the getXbergWasm lazy-promise pattern above), not
  // module-level, so a fresh createAppContext (e.g. in tests) doesn't reuse another context's cache.
  let e5PathsPromise: Promise<{
    modelPath: string;
    tokenizerPath: string;
  }> | null = null;
  const e5Paths = () => {
    e5PathsPromise ??= (async () => ({
      modelPath: await models.ensureModel("e5-fp32"),
      tokenizerPath: await models.ensureModel("e5-tokenizer"),
    }))();
    return e5PathsPromise;
  };
  let glinerPathsPromise: Promise<{
    modelPath: string;
    tokenizerPath: string;
  }> | null = null;
  const glinerPaths = () => {
    glinerPathsPromise ??= (async () => ({
      modelPath: await models.ensureModel(`${DEFAULT_GLINER_MODEL}.model`),
      tokenizerPath: await models.ensureModel(`${DEFAULT_GLINER_MODEL}.tokenizer`),
    }))();
    return glinerPathsPromise;
  };
  let gliner2PathsPromise: Promise<Gliner2ArtifactPaths> | null = null;
  const gliner2Paths = () => {
    gliner2PathsPromise ??= models.ensureGliner2Artifacts({
      weights: GLINER2_MANIFEST_NAMES.weights,
      tokenizer: GLINER2_MANIFEST_NAMES.tokenizer,
      encoderConfig: GLINER2_MANIFEST_NAMES.encoderConfig,
    });
    return gliner2PathsPromise;
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
      return {
        content: first.content ?? "",
        pageCount: first.metadata?.pages?.totalCount ?? 1,
      };
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
      const backend = process.env.HACIENDA_NER_BACKEND ?? "auto";
      if (backend !== "legacy" && (await configureNativeGliner2())) {
        try {
          const { modelDir } = await gliner2Paths();
          return detectGliner2(text, modelDir, RUST_ALIGNED_PII_TYPES);
        } catch (error) {
          if (backend === "candle") throw error;
        }
      }
      if (backend === "candle") {
        throw new AppError("model", "native GLiNER2 backend is unavailable or its artifacts are not pinned");
      }
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
        sendJson(res, 500, {
          error: "InternalError",
          code: "store",
          message: msg,
        });
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
