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
});

async function makeAuthedServer() {
  const dir = mkdtempSync(join(tmpdir(), "xberg-routes-"));
  dirs.push(dir);
  const config = buildConfig(parseArgs(["node", "xberg-mcp", "serve", "--data-dir", dir]));
  const ctx = createAppContext(config);
  const server = createHttpServer(ctx);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  const token = readFileSync(join(dir, "session.token"), "utf8").trim();
  const base = `http://127.0.0.1:${address.port}`;
  const authedFetch = (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, "sec-fetch-site": "same-origin" } });
  return { ctx, server, authedFetch };
}

describe("document routes", () => {
  it("returns documents for a folder", async () => {
    const { ctx, server, authedFetch } = await makeAuthedServer();
    const matter = ctx.store.createMatter("Acme v Doe");
    const folder = ctx.store.createFolder(matter.id, "Discovery");
    const doc = ctx.store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/a.txt",
      content_hash: "h1",
      ingested_via: "mcp",
    });

    const res = await authedFetch(`/api/folders/${folder.id}/documents`);
    const body = (await res.json()) as { documents: { id: string }[] };
    expect(res.status).toBe(200);
    expect(body.documents.map((d) => d.id)).toEqual([doc.id]);
    server.close();
  });

  it("rejects PII entities for a document without pii_read consent", async () => {
    const { ctx, server, authedFetch } = await makeAuthedServer();
    const matter = ctx.store.createMatter("Acme v Doe");
    const folder = ctx.store.createFolder(matter.id, "Discovery");
    const doc = ctx.store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/a.txt",
      content_hash: "h1",
      ingested_via: "mcp",
    });
    ctx.store.insertPiiEntities(doc.id, [{ kind: "person", start: 0, end: 8, text: "Jane Doe" }]);

    const res = await authedFetch(`/api/documents/${doc.id}/pii`);
    expect(res.status).toBe(403);
    server.close();
  });

  it("returns PII entities for a document once pii_read consent is granted", async () => {
    const { ctx, server, authedFetch } = await makeAuthedServer();
    const matter = ctx.store.createMatter("Acme v Doe");
    const folder = ctx.store.createFolder(matter.id, "Discovery");
    const doc = ctx.store.createDocument({
      folder_id: folder.id,
      matter_id: matter.id,
      path: "/tmp/a.txt",
      content_hash: "h1",
      ingested_via: "mcp",
    });
    ctx.store.insertPiiEntities(doc.id, [{ kind: "person", start: 0, end: 8, text: "Jane Doe" }]);
    ctx.store.grantConsent({ subject: "owner", matter_id: matter.id, scope: "pii_read" as never });

    const res = await authedFetch(`/api/documents/${doc.id}/pii`);
    const body = (await res.json()) as { pii: { kind: string }[] };
    expect(res.status).toBe(200);
    expect(body.pii).toEqual([expect.objectContaining({ kind: "person" })]);
    server.close();
  });
});
