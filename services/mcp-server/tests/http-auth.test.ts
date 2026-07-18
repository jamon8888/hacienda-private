import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildConfig } from "../src/config.js";
import { createAppContext, createHttpServer, type AppContext } from "../src/index.js";

const TOKEN = "b".repeat(64);
let dir: string;
let ctx: AppContext;
let server: Server;
let base: string;

async function start(scopes: ("read" | "ingest" | "redact" | "admin")[]) {
  // buildConfig rejects port <= 0; this port is unused because we listen(0) below.
  ctx = createAppContext(buildConfig({ command: "serve", host: "127.0.0.1", port: 8787, dataDir: dir }));
  server = createHttpServer(ctx, { token: TOKEN, scopes });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xberg-http-"));
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  ctx.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("HTTP auth surface", () => {
  it("401 without a Bearer token", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const res = await fetch(`${base}/matters`);
    expect(res.status).toBe(401);
  });

  it("403 on a cross-site request even with a valid token", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const res = await fetch(`${base}/matters`, {
      headers: { authorization: `Bearer ${TOKEN}`, "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("200 with a valid token (non-browser client, no sec-fetch-site)", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const res = await fetch(`${base}/matters`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matters: [] });
  });

  it("POST /matters records an audit entry under 'owner'", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const res = await fetch(`${base}/matters`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Dossier A" }),
    });
    expect(res.status).toBe(201);
    const audit = ctx.store.getAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe("owner");
    expect(audit[0]!.action).toBe("create_matter");
  });

  it("403 when the launch scopes lack the required scope", async () => {
    await start(["read"]);
    const res = await fetch(`${base}/matters`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("GET / injects window.__XBERG_TOKEN__, needs no token, and is not cacheable", async () => {
    await start(["read"]);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("__XBERG_TOKEN__");
  });

  it("400 on POST /consent with an unsupported scope", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const res = await fetch(`${base}/consent`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: "owner", matter_id: "m-1", scope: "bogus" }),
    });
    expect(res.status).toBe(400);
  });
});
