import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { listPii, ragQuery, redact, rehydrateChunk } from "../src/mcp/tools.js";

const VAULT_KEY = Buffer.alloc(32, 7);

interface Harness {
  dir: string;
  ctx: AppContext;
  matter: Matter;
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
  };
}

function seedBundle(mirror: MirrorStore, vault: KeyVault, matterId: string): void {
  const ciphertext = vault.seal(Buffer.from("Jane")).toString("base64");
  const bundle = {
    version: 1,
    index: [1, 2, 3],
    vault: [4, 5, 6],
    pii: [
      { doc_id: "d1", kind: "PER", start: 0, end: 3, token: "t1", ciphertext },
    ],
    chunks: [
      { doc_id: "d1", chunk_index: 0, text: "redacted", score: 0.9, citation: "d1#0" },
    ],
  };
  mirror.saveMirror(matterId, Buffer.from(JSON.stringify(bundle)));
}

async function makeHarness(scopes: AppContext["tokenScopes"], consent: boolean): Promise<Harness> {
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
  if (consent) {
    store.grantConsent({ subject: "*", matter_id: matter.id, scope: consentScope("pii_read") });
    store.grantConsent({ subject: "*", matter_id: matter.id, scope: consentScope("redact_rehydrate") });
  }
  seedBundle(mirror, vault, matter.id);
  await mirror.loadMirror(matter.id);

  const ctx: AppContext = { config, store, models, mirror, vault, tokenScopes: scopes };
  return { dir, ctx, matter };
}

let created: Harness[] = [];

async function harness(scopes: AppContext["tokenScopes"], consent: boolean): Promise<Harness> {
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
  it("rag_query returns the cited chunk", async () => {
    const { ctx, matter } = await harness(["read", "ingest", "redact", "admin"], true);
    const res = ragQuery(ctx, { matter_id: matter.id, query: "who" });
    const chunks = JSON.parse(res.content[0]?.text ?? "[]") as { citation: string; text: string }[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.citation).toBe("d1#0");
    expect(chunks[0]?.text).toBe("redacted");
    const audit = ctx.store.getAuditLog(matter.id);
    expect(audit.some((a) => a.action === "rag_query")).toBe(true);
    expect(audit[0]?.actor).toBe("mcp:read,ingest,redact,admin");
  });

  it("list_pii returns the span token, never plaintext", async () => {
    const { ctx, matter } = await harness(["read", "admin"], true);
    const res = listPii(ctx, { matter_id: matter.id, doc_id: "d1" });
    const spans = JSON.parse(res.content[0]?.text ?? "[]") as { kind: string; text: string }[];
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe("PER");
    expect(spans[0]?.text).toBe("t1");
    expect(res.content[0]?.text).not.toContain("Jane");
  });

  it("rehydrate_chunk returns the stored ciphertext blob WITH consent", async () => {
    const { ctx, matter } = await harness(["read", "redact", "admin"], true);
    const res = rehydrateChunk(ctx, { matter_id: matter.id, chunk_id: "d1:t1" });
    const text = res.content[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(() => Buffer.from(text, "base64")).not.toThrow();
  });

  it("rehydrate_chunk is rejected WITHOUT consent", async () => {
    const { ctx, matter } = await harness(["read", "redact", "admin"], false);
    try {
      rehydrateChunk(ctx, { matter_id: matter.id, chunk_id: "d1:t1" });
      throw new Error("expected consent error");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      expect((err as AppError).code).toBe("consent");
    }
  });

  it("rehydrate_chunk is rejected without redact scope", async () => {
    const { ctx, matter } = await harness(["read"], true);
    try {
      rehydrateChunk(ctx, { matter_id: matter.id, chunk_id: "d1:t1" });
      throw new Error("expected scope error");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      expect((err as AppError).code).toBe("scope");
    }
  });

  it("redact records a marker with consent + scope", async () => {
    const { ctx, matter } = await harness(["read", "redact", "admin"], true);
    const res = redact(ctx, { matter_id: matter.id, doc_id: "d1", entity_ids: ["e1"] });
    const rec = JSON.parse(res.content[0]?.text ?? "{}") as { doc_id: string; entity_ids: string[] };
    expect(rec.doc_id).toBe("d1");
    expect(rec.entity_ids).toEqual(["e1"]);
  });
});
