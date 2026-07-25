import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, parseArgs } from "../src/config.js";
import { createAppContext, createHttpServer } from "../src/index.js";

let dirs: string[] = [];
let servers: ReturnType<typeof createHttpServer>[] = [];
const originalUiDirEnv = process.env.XBERG_WEB_APP_DIR;

afterEach(() => {
  for (const s of servers) {
    try {
      s.close();
    } catch {}
  }
  servers = [];
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  dirs = [];
  if (originalUiDirEnv === undefined) delete process.env.XBERG_WEB_APP_DIR;
  else process.env.XBERG_WEB_APP_DIR = originalUiDirEnv;
});

function makeFakeUiDir(): string {
  const uiDir = mkdtempSync(join(tmpdir(), "xberg-ui-"));
  dirs.push(uiDir);
  writeFileSync(join(uiDir, "browse.html"), "<html><body>browse</body></html>");
  writeFileSync(join(uiDir, "404.html"), "<html><body>not found</body></html>");
  mkdirSync(join(uiDir, "documents"));
  writeFileSync(join(uiDir, "documents", "_.html"), "<html><body>document shell</body></html>");
  return uiDir;
}

async function makeServer(): Promise<{ base: string; token: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "xberg-spa-"));
  dirs.push(dataDir);
  const config = buildConfig(parseArgs(["node", "xberg-mcp", "serve", "--data-dir", dataDir]));
  const ctx = createAppContext(config);
  const server = createHttpServer(ctx);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  const token = readFileSync(join(dataDir, "session.token"), "utf8").trim();
  return { base: `http://127.0.0.1:${address.port}`, token };
}

describe("SPA static fallback", () => {
  it("serves the dynamic-route shell for a two-segment path like /documents/:id with no token required", async () => {
    process.env.XBERG_WEB_APP_DIR = makeFakeUiDir();
    const { base, token } = await makeServer();

    // Deliberately no Authorization header: a fresh tab hitting a deep link has no token
    // yet either — the shell itself must be public, same as "/".
    const res = await fetch(`${base}/documents/some-real-id`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("document shell");
    // The client (lib/auth.ts) reads window.__XBERG_TOKEN__ instead of self-generating a
    // token that could never match the server's — a deep link is exactly the case where the
    // client has no other way to learn it yet.
    expect(body).toContain(`window.__XBERG_TOKEN__=${JSON.stringify(token)}`);
  });

  it("serves the single-segment page html for a route like /browse", async () => {
    process.env.XBERG_WEB_APP_DIR = makeFakeUiDir();
    const { base } = await makeServer();

    const res = await fetch(`${base}/browse`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("browse");
  });

  it("falls back to 404.html for an unknown route when a UI dir is configured", async () => {
    process.env.XBERG_WEB_APP_DIR = makeFakeUiDir();
    const { base } = await makeServer();

    const res = await fetch(`${base}/nope/at/all`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not found");
  });

  it("never intercepts /api/* paths (still 404s as plain text, not the HTML shell)", async () => {
    process.env.XBERG_WEB_APP_DIR = makeFakeUiDir();
    const { base, token } = await makeServer();

    const res = await fetch(`${base}/api/does-not-exist`, {
      headers: { authorization: `Bearer ${token}`, "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
