import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAppContext, createHttpServer } from "../src/index.js";
import type { AppConfig } from "../src/config.js";

function makeConfig(dir: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    modelCacheDir: join(dir, "models"),
    dbPath: join(dir, "meta.sqlite"),
    vaultPath: join(dir, "vault"),
    vaultKeyPath: join(dir, "vault.key"),
    mirrorsDir: join(dir, "mirrors"),
    manifestPath: join(dir, "manifest.json"),
    jwtSecret: "test",
  };
}

describe("static UI serving", () => {
  let dataDir: string;
  let uiDir: string;
  let server: ReturnType<typeof createHttpServer>;
  let ctx: ReturnType<typeof createAppContext>;
  let baseUrl: string;
  let restoreEnv: string | undefined;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "xberg-static-data-"));
    uiDir = mkdtempSync(join(tmpdir(), "xberg-static-ui-"));
    mkdirSync(join(uiDir, "_next", "static", "chunks"), { recursive: true });
    mkdirSync(join(uiDir, "folders"), { recursive: true });
    writeFileSync(join(dataDir, "manifest.json"), JSON.stringify({ models: [] }));
    writeFileSync(join(uiDir, "index.html"), "<html>index</html>");
    // "onboarding" (not "matters"/"folders"/etc.) deliberately avoids colliding with an existing
    // JSON API route below, so this actually exercises static-file serving, not the API handler.
    writeFileSync(join(uiDir, "onboarding.html"), "<html>onboarding page</html>");
    writeFileSync(join(uiDir, "folders", "_.html"), "<html>folder shell</html>");
    writeFileSync(join(uiDir, "_next", "static", "chunks", "app.js"), "console.log('app')");
    mkdirSync(join(uiDir, "_next", "static", "chunks", "app", "matters", "[id]"), { recursive: true });
    writeFileSync(
      join(uiDir, "_next", "static", "chunks", "app", "matters", "[id]", "page-abc123.js"),
      "console.log('matter page chunk')",
    );

    restoreEnv = process.env.XBERG_WEB_APP_DIR;
    process.env.XBERG_WEB_APP_DIR = uiDir;

    ctx = createAppContext(makeConfig(dataDir));
    server = createHttpServer(ctx);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ctx.store.close();
    if (restoreEnv === undefined) delete process.env.XBERG_WEB_APP_DIR;
    else process.env.XBERG_WEB_APP_DIR = restoreEnv;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(uiDir, { recursive: true, force: true });
  });

  it("serves a Next.js static-export asset by its exact path", async () => {
    const res = await fetch(`${baseUrl}/_next/static/chunks/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("console.log");
  });

  it("serves a top-level route by resolving its .html file", async () => {
    const res = await fetch(`${baseUrl}/onboarding`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("onboarding page");
  });

  it("serves the dynamic-route shell for any id under a [id] route", async () => {
    const res = await fetch(`${baseUrl}/folders/some-real-matter-id`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("folder shell");
  });

  it("decodes percent-encoded brackets in [id]-route chunk paths", async () => {
    // Browsers request "[id]" chunk directories as "%5Bid%5D" — URL.pathname does not decode
    // this, so the file lookup must, or every [id]-route's own JS chunk 404s (ChunkLoadError).
    const res = await fetch(`${baseUrl}/_next/static/chunks/app/matters/%5Bid%5D/page-abc123.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("matter page chunk");
  });

  it("still 404s for a path with no matching static file", async () => {
    const res = await fetch(`${baseUrl}/does/not/exist`);
    expect(res.status).toBe(404);
  });

  it("does not allow path traversal outside the ui dir", async () => {
    const res = await fetch(`${baseUrl}/../../../../etc/passwd`);
    expect(res.status).not.toBe(200);
  });
});
