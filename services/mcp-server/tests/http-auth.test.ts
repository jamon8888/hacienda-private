import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Matter } from "@xberg-io/core";
import { buildConfig } from "../src/config.js";
import { createAppContext, createHttpServer, type AppContext } from "../src/index.js";
import { SHARED_EMBEDDING_IDENTITY } from "../src/mirror.js";

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
    const res = await fetch(`${base}/api/matters`);
    expect(res.status).toBe(401);
  });

  it("403 on a cross-site request even with a valid token", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const res = await fetch(`${base}/api/matters`, {
      headers: { authorization: `Bearer ${TOKEN}`, "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("200 with a valid token (non-browser client, no sec-fetch-site)", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const res = await fetch(`${base}/api/matters`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matters: [] });
  });

  it("POST /matters records an audit entry under 'owner'", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const res = await fetch(`${base}/api/matters`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Dossier A" }),
    });
    expect(res.status).toBe(201);
    const matter = (await res.json()) as Matter;
    const audit = ctx.store.getAuditLog(matter.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe("owner");
    expect(audit[0]!.action).toBe("create_matter");
  });

  it("403 when the launch scopes lack the required scope", async () => {
    await start(["read"]);
    const res = await fetch(`${base}/api/matters`, {
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
    const res = await fetch(`${base}/api/consent`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: "owner", matter_id: "m-1", scope: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/rag/mirror records a save_mirror audit entry under 'owner'", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const matterRes = await fetch(`${base}/api/matters`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Dossier B" }),
    });
    const matter = (await matterRes.json()) as Matter;

    const res = await fetch(`${base}/api/rag/mirror?matter_id=${matter.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "mirror-bytes",
    });
    expect(res.status).toBe(201);

    const audit = ctx.store.getAuditLog(matter.id);
    const saveMirrorEntry = audit.find((a) => a.action === "save_mirror");
    expect(saveMirrorEntry).toBeDefined();
    expect(saveMirrorEntry?.actor).toBe("owner");
  });

  it("a realistic version-2 mirror pushed over HTTP can be read back via listPii/retrieve", async () => {
    await start(["read", "ingest", "redact", "admin"]);
    const matterRes = await fetch(`${base}/api/matters`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Dossier C" }),
    });
    const matter = (await matterRes.json()) as Matter;

    // Same shape the browser mirror push (apps/web/lib/engine/adapter.ts, via
    // serializeMirrorToBytes) produces — this is the regression a version-1/version-2 mismatch
    // between the browser and parseBundle() would break: saveMirror writes anything, but the
    // subsequent read would throw "unexpected bundle shape" for a mismatched version.
    const bundle = {
      version: 2,
      embedding_identity: SHARED_EMBEDDING_IDENTITY,
      index: [1, 2, 3],
      vault: [4, 5, 6],
      vaultSalt: [7, 8],
      pii: [{ doc_id: "d1", kind: "PERSON", start: 0, end: 4, token: "[P1]" }],
      chunks: [{ doc_id: "d1", chunk_index: 0, text: "hello world", score: 0.9, citation: "d1:0" }],
    };

    const res = await fetch(`${base}/api/rag/mirror?matter_id=${matter.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(bundle),
    });
    expect(res.status).toBe(201);

    await ctx.mirror.loadMirror(matter.id);
    expect(ctx.mirror.listPii(matter.id, "d1")).toEqual([{ kind: "PERSON", start: 0, end: 4, text: "[P1]" }]);
    expect(ctx.mirror.retrieve(matter.id, "unused query", 5)).toEqual([
      { doc_id: "d1", chunk_index: 0, text: "hello world", score: 0.9, citation: "d1:0" },
    ]);
  });
});
