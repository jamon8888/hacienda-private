import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { AppConfig, buildConfig, parseArgs } from "./config.js";
import { AppError, isAppError } from "./error.js";
import type { AuthScopes } from "@xberg-io/core";
import { MetadataStore, openStore } from "./store.js";
import { ModelCache } from "./models.js";
import { MirrorStore } from "./mirror.js";
import { KeyVault } from "./vault.js";
import { PLACEHOLDER_HTML, resolveUiDir, resolveWasmPackageDir } from "./static.js";
import { runMcp } from "./mcp/mod.js";

export interface AppContext {
  config: AppConfig;
  store: MetadataStore;
  models: ModelCache;
  mirror: MirrorStore;
  vault: KeyVault;
  tokenScopes: AuthScopes[];
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

async function handle(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  if (pathname === "/" && method === "GET") {
    const uiDir = resolveUiDir();
    if (uiDir) {
      serveFile(res, join(uiDir, "index.html"));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PLACEHOLDER_HTML);
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

  if (pathname.startsWith("/models/") && method === "GET") {
    await handleModels(ctx, res, pathname.slice("/models/".length));
    return;
  }

  if (pathname === "/matters" && method === "GET") {
    sendJson(res, 200, { matters: ctx.store.getMatters() });
    return;
  }
  if (pathname === "/matters" && method === "POST") {
    const body = await readJson<{ name: string }>(req);
    if (!body.name) throw new AppError("bad_request", "name is required");
    sendJson(res, 201, ctx.store.createMatter(body.name));
    return;
  }

  const forgetMatch = pathname.match(/^\/matters\/([^/]+)$/);
  if (forgetMatch && method === "DELETE") {
    if (!ctx.tokenScopes.includes("admin")) {
      throw new AppError("scope", "admin scope required to forget a matter");
    }
    const matterId = decodeURIComponent(forgetMatch[1] ?? "");
    const forgotten = ctx.store.forgetMatter(matterId);
    ctx.mirror.forget(matterId);
    ctx.store.recordAudit("http", "admin", "forget", matterId);
    sendJson(res, 200, { forgotten });
    return;
  }

  if (pathname === "/folders" && method === "GET") {
    const matterId = url.searchParams.get("matter_id");
    if (!matterId) throw new AppError("bad_request", "matter_id is required");
    sendJson(res, 200, { folders: ctx.store.getFolders(matterId) });
    return;
  }
  if (pathname === "/folders" && method === "POST") {
    const body = await readJson<{ matter_id: string; name: string; path?: string }>(req);
    if (!body.matter_id || !body.name) throw new AppError("bad_request", "matter_id and name are required");
    sendJson(res, 201, ctx.store.createFolder(body.matter_id, body.name, body.path));
    return;
  }

  if (pathname === "/consent" && method === "GET") {
    const matterId = url.searchParams.get("matter_id");
    if (!matterId) throw new AppError("bad_request", "matter_id is required");
    sendJson(res, 200, { consent: ctx.store.getConsent(matterId) });
    return;
  }
  if (pathname === "/consent" && method === "POST") {
    const body = await readJson<{ subject: string; matter_id: string; scope: string; expires_at?: string }>(req);
    if (!body.subject || !body.matter_id || !body.scope) {
      throw new AppError("bad_request", "subject, matter_id and scope are required");
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

  if (pathname === "/rag/mirror" && method === "POST") {
    const matterId = url.searchParams.get("matter_id");
    if (!matterId) throw new AppError("bad_request", "matter_id is required");
    const body = await readBody(req);
    const status = ctx.mirror.saveMirror(matterId, body);
    sendJson(res, 201, status);
    return;
  }

  const mirrorStatus = pathname.match(/^\/rag\/mirror\/([^/]+)\/status$/);
  if (mirrorStatus && method === "GET") {
    const matterId = decodeURIComponent(mirrorStatus[1] ?? "");
    const status = ctx.mirror.status(matterId);
    if (!status) throw new AppError("not_found", `no mirror for matter ${matterId}`);
    sendJson(res, 200, status);
    return;
  }

  // Serve the built web UI (SPA): existing files directly, client routes fall
  // back to index.html so dynamic segments (/matters/<id>, /documents/<name>)
  // resolve in the browser router.
  if (method === "GET") {
    const uiDir = resolveUiDir();
    if (uiDir) {
      const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
      const candidate = join(uiDir, safe);
      if (candidate.startsWith(uiDir) && existsSync(candidate) && statSync(candidate).isFile()) {
        serveFile(res, candidate);
        return;
      }
      const htmlCandidate = join(uiDir, `${safe.replace(/\/$/, "")}.html`);
      if (htmlCandidate.startsWith(uiDir) && existsSync(htmlCandidate) && statSync(htmlCandidate).isFile()) {
        serveFile(res, htmlCandidate);
        return;
      }
      const indexPath = join(uiDir, "index.html");
      if (existsSync(indexPath)) {
        serveFile(res, indexPath);
        return;
      }
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

export function createAppContext(config: AppConfig): AppContext {
  const store = openStore(config.dbPath);
  const models = new ModelCache(config.modelCacheDir, config.manifestPath);
  const mirror = new MirrorStore(config.mirrorsDir);
  const vault = new KeyVault({ vaultKeyPath: config.vaultKeyPath });
  // Local owner-launched MCP: the owner holds every scope. In production this would be derived
  // from the launcher/JWT token rather than defaulted here.
  const tokenScopes: AuthScopes[] = ["read", "ingest", "redact", "admin"];
  return { config, store, models, mirror, vault, tokenScopes };
}

export function createHttpServer(ctx: AppContext) {
  return createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
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
  const config = buildConfig(args);
  const ctx = createAppContext(config);

  if (args.command === "mcp") {
    await runMcp(ctx);
    return;
  }

  const server = createHttpServer(ctx);
  server.listen(config.port, config.host, () => {
    console.log(`[xberg-mcp] serving http://${config.host}:${config.port}`);
    console.log(`[xberg-mcp] data dir: ${config.dataDir}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
