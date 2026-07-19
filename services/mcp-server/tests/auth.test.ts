import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, parseArgs } from "../src/config.js";
import { createAppContext, createHttpServer } from "../src/index.js";

let dirs: string[] = [];
let servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(() => {
  for (const s of servers) {
    try { s.close(); } catch { }
  }
  servers = [];
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { }
  }
  dirs = [];
});

function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), "xberg-auth-"));
  dirs.push(dir);
  const config = buildConfig(parseArgs(["node", "xberg-mcp", "serve", "--data-dir", dir]));
  const ctx = createAppContext(config);
  const server = createHttpServer(ctx);
  servers.push(server);
  return { dir, config, server, token: config.sessionToken };
}

describe("REST bearer token", () => {
  it("writes a session token file on context creation", () => {
    const { dir } = makeServer();
    const token = readFileSync(join(dir, "session.token"), "utf8").trim();
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects /api/* without a matching bearer token", async () => {
    const { server, token } = makeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no server address");
    const res = await fetch(`http://127.0.0.1:${address.port}/api/matters`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(401);
    server.close();
  });

  it("accepts /api/* with the correct bearer token and same-origin header", async () => {
    const { server, token } = makeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no server address");
    const res = await fetch(`http://127.0.0.1:${address.port}/api/matters`, {
      headers: { authorization: `Bearer ${token}`, "sec-fetch-site": "same-origin" },
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