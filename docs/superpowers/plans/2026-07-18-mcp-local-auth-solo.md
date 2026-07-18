# MCP Server — Local Single-Owner Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `services/mcp-server` a real per-request authenticated identity (`Principal`) on the HTTP and MCP-stdio surfaces, so the auth/audit controls stop being no-ops — without building a multi-tenant auth system.

**Architecture:** A per-launch opaque 256-bit capability token is persisted 0600 in the data dir and injected into the served `GET /` HTML. The HTTP surface rejects cross-site requests (`Sec-Fetch-Site` guard) and requires the token (`Bearer`), deriving a `Principal{subject:"owner", scopes}` per request; scopes are enforced by a real `authorize()` and every mutation is audited under `subject`. The MCP-stdio surface builds the same `Principal` once (process spawn is the authentication) and reserves it for the tool layer (Plan 4). No JWT, no multi-subject.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `http`, `node:crypto`, `better-sqlite3`, `@modelcontextprotocol/sdk`, `vitest`.

**Reference (do not merge):** the shapes for `authorize()`/consent/tools live on branch `plan5-security-gdpr` (PR #6, CLOSED). This plan builds fresh on `main`. Spec: `docs/superpowers/specs/2026-07-18-mcp-local-auth-solo-design.md`.

## Global Constraints

- Local-first, **single owner**: `subject` is always the literal `"owner"`. No user accounts, no passwords.
- HTTP binds `127.0.0.1` by default (existing `config.ts` — do not change).
- Credential is an **opaque random 256-bit token** (hex), **not** a JWT. Persisted at `<dataDir>/session.token`, file mode **0600**.
- Launch scopes come from config: `XBERG_SCOPES` (comma list) or default **all** = `["read","ingest","redact","admin"]`.
- **No permissive CORS** — never emit `Access-Control-Allow-Origin`. Cross-site requests are rejected, not allowed.
- MCP **stdio has no token** (spawn is the auth boundary) — this is deliberate, not a shortcut.
- Static endpoints (`GET /`, `/wasm/*`, `/models/*`) are served **without** a token; every other route requires it.
- All imports use `.js` specifiers (ESM). Tests are `vitest` under `services/mcp-server/tests/`, run with `pnpm --filter @xberg-io/mcp-server test` (or `cd services/mcp-server && npx vitest run`).
- Conventional commits; every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `services/mcp-server/src/principal.ts` | `Principal` type — per-request identity | Create |
| `services/mcp-server/src/mcp/scopes.ts` | `authorize(scopes, required)` — honest scope-only check | Create |
| `services/mcp-server/src/auth.ts` | Session token (load/create 0600), launch scopes, origin guard, Bearer auth, `ownerPrincipal` | Create |
| `services/mcp-server/src/store.ts` | `audit_log` table + `recordAudit`/`getAudit` | Modify |
| `services/mcp-server/src/static.ts` | `injectToken(html, token)` | Modify |
| `services/mcp-server/src/index.ts` | Thread `HttpAuth`, guard API routes, inject token, enforce scopes, audit mutations, wire `main()`/`runMcp` | Modify |
| `services/mcp-server/src/mcp/mod.ts` | `runMcp(ctx, principal)` — accept + log principal | Modify |
| `services/mcp-server/tests/scopes.test.ts` | `authorize()` unit tests | Create |
| `services/mcp-server/tests/auth.test.ts` | token/scopes/origin/bearer unit tests | Create |
| `services/mcp-server/tests/audit.test.ts` | `recordAudit`/`getAudit` tests | Create |
| `services/mcp-server/tests/static.test.ts` | `injectToken` tests | Create |
| `services/mcp-server/tests/http-auth.test.ts` | HTTP surface integration tests | Create |

---

## Task 1: `Principal` type + honest `authorize()`

**Files:**
- Create: `services/mcp-server/src/principal.ts`
- Create: `services/mcp-server/src/mcp/scopes.ts`
- Test: `services/mcp-server/tests/scopes.test.ts`

**Interfaces:**
- Consumes: `AuthScopes` from `@xberg-io/core` (`= "read" | "ingest" | "redact" | "admin"`), `AppError` from `../error.js`.
- Produces:
  - `interface Principal { subject: string; scopes: AuthScopes[] }` (in `principal.ts`)
  - `function authorize(scopes: AuthScopes[], required: AuthScopes): void` (in `mcp/scopes.ts`) — throws `AppError("scope", ...)` if `scopes` lacks `required` and lacks `"admin"`; returns `void` otherwise. **No matter parameter** (the old tautological check is deliberately removed).

- [ ] **Step 1: Write the failing test**

Create `services/mcp-server/tests/scopes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { authorize } from "../src/mcp/scopes.js";
import { AppError } from "../src/error.js";

describe("authorize", () => {
  it("passes when the exact scope is held", () => {
    expect(() => authorize(["read"], "read")).not.toThrow();
  });

  it("passes when admin is held, for any required scope", () => {
    expect(() => authorize(["admin"], "redact")).not.toThrow();
  });

  it("throws AppError('scope') when the required scope is missing", () => {
    try {
      authorize(["read"], "redact");
      throw new Error("expected authorize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("scope");
      expect((err as AppError).status).toBe(403);
    }
  });

  it("throws on an empty scope set", () => {
    expect(() => authorize([], "read")).toThrow(AppError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npx vitest run tests/scopes.test.ts`
Expected: FAIL — cannot resolve `../src/mcp/scopes.js` (module does not exist).

- [ ] **Step 3: Write the type and the function**

Create `services/mcp-server/src/principal.ts`:

```ts
import type { AuthScopes } from "@xberg-io/core";

/** The effective identity of a single request/connection. Single-owner model: subject is "owner". */
export interface Principal {
  subject: string;
  scopes: AuthScopes[];
}
```

Create `services/mcp-server/src/mcp/scopes.ts`:

```ts
import type { AuthScopes } from "@xberg-io/core";
import { AppError } from "../error.js";

/**
 * Deny-by-default scope check: the caller must hold `required` (or `admin`).
 * Single-owner model has no per-identity matter scoping, so there is no matter
 * argument — the old matter check was a tautology and is intentionally gone.
 */
export function authorize(scopes: AuthScopes[], required: AuthScopes): void {
  if (!scopes.includes(required) && !scopes.includes("admin")) {
    throw new AppError("scope", `missing required scope: ${required}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npx vitest run tests/scopes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/principal.ts services/mcp-server/src/mcp/scopes.ts services/mcp-server/tests/scopes.test.ts
git commit -m "feat(mcp-server): Principal type + honest scope-only authorize()"
```

---

## Task 2: `auth.ts` — session token, launch scopes, origin guard, Bearer auth

**Files:**
- Create: `services/mcp-server/src/auth.ts`
- Test: `services/mcp-server/tests/auth.test.ts`

**Interfaces:**
- Consumes: `Principal` from `./principal.js`, `AuthScopes` from `@xberg-io/core`, `AppError` from `./error.js`, `node:crypto` (`randomBytes`, `timingSafeEqual`), `node:fs`, `node:path`, `node:http` `IncomingMessage` (type only).
- Produces:
  - `function loadOrCreateSessionToken(dataDir: string): string` — returns existing token from `<dataDir>/session.token` or generates 32 random bytes (hex), writing the file 0600.
  - `function resolveLaunchScopes(env: NodeJS.ProcessEnv): AuthScopes[]` — parses `XBERG_SCOPES` or returns all four; throws `AppError("bad_request")` if the var is set but has no valid scope.
  - `function ownerPrincipal(scopes: AuthScopes[]): Principal` — `{ subject: "owner", scopes }`.
  - `function isSameOriginRequest(req: IncomingMessage): boolean` — false only when `sec-fetch-site` is present and is `cross-site` or `same-site`.
  - `function authenticateHttp(req: IncomingMessage, token: string, scopes: AuthScopes[]): Principal` — throws `AppError("scope")` on cross-origin, `AppError("auth")` on missing/invalid Bearer; else returns `ownerPrincipal(scopes)`.

- [ ] **Step 1: Write the failing test**

Create `services/mcp-server/tests/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import {
  loadOrCreateSessionToken,
  resolveLaunchScopes,
  ownerPrincipal,
  isSameOriginRequest,
  authenticateHttp,
} from "../src/auth.js";
import { AppError } from "../src/error.js";

function reqWith(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xberg-auth-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadOrCreateSessionToken", () => {
  it("creates a 64-hex-char token in a 0600 file, then is idempotent", () => {
    const t1 = loadOrCreateSessionToken(dir);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    const mode = statSync(join(dir, "session.token")).mode & 0o777;
    expect(mode).toBe(0o600);
    const t2 = loadOrCreateSessionToken(dir);
    expect(t2).toBe(t1);
    expect(readFileSync(join(dir, "session.token"), "utf8").trim()).toBe(t1);
  });
});

describe("resolveLaunchScopes", () => {
  it("defaults to all four scopes", () => {
    expect(resolveLaunchScopes({})).toEqual(["read", "ingest", "redact", "admin"]);
  });
  it("parses XBERG_SCOPES", () => {
    expect(resolveLaunchScopes({ XBERG_SCOPES: "read, redact" })).toEqual(["read", "redact"]);
  });
  it("throws when XBERG_SCOPES has no valid scope", () => {
    expect(() => resolveLaunchScopes({ XBERG_SCOPES: "bogus" })).toThrow(AppError);
  });
});

describe("isSameOriginRequest", () => {
  it("allows missing header (non-browser client)", () => {
    expect(isSameOriginRequest(reqWith({}))).toBe(true);
  });
  it("allows same-origin and none", () => {
    expect(isSameOriginRequest(reqWith({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(reqWith({ "sec-fetch-site": "none" }))).toBe(true);
  });
  it("rejects cross-site and same-site", () => {
    expect(isSameOriginRequest(reqWith({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(reqWith({ "sec-fetch-site": "same-site" }))).toBe(false);
  });
});

describe("authenticateHttp", () => {
  const token = "a".repeat(64);
  it("returns the owner principal on valid Bearer + same origin", () => {
    const p = authenticateHttp(reqWith({ authorization: `Bearer ${token}` }), token, ["read"]);
    expect(p).toEqual({ subject: "owner", scopes: ["read"] });
  });
  it("throws auth (401) on missing token", () => {
    try {
      authenticateHttp(reqWith({}), token, ["read"]);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as AppError).code).toBe("auth");
    }
  });
  it("throws auth (401) on wrong token", () => {
    expect(() => authenticateHttp(reqWith({ authorization: "Bearer wrong" }), token, ["read"])).toThrow(AppError);
  });
  it("throws scope (403) on cross-site even with a valid token", () => {
    try {
      authenticateHttp(reqWith({ authorization: `Bearer ${token}`, "sec-fetch-site": "cross-site" }), token, ["read"]);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as AppError).code).toBe("scope");
    }
  });

  it("ownerPrincipal wraps scopes", () => {
    expect(ownerPrincipal(["admin"])).toEqual({ subject: "owner", scopes: ["admin"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npx vitest run tests/auth.test.ts`
Expected: FAIL — cannot resolve `../src/auth.js`.

- [ ] **Step 3: Write `auth.ts`**

Create `services/mcp-server/src/auth.ts`:

```ts
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import type { AuthScopes } from "@xberg-io/core";
import { AppError } from "./error.js";
import type { Principal } from "./principal.js";

const ALL_SCOPES: AuthScopes[] = ["read", "ingest", "redact", "admin"];

/** Load the persisted session token, or generate + persist a new 256-bit one (file mode 0600). */
export function loadOrCreateSessionToken(dataDir: string): string {
  const path = resolve(dataDir, "session.token");
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  // Some platforms ignore the write-time mode; enforce it explicitly (mirrors vault.ts).
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  return token;
}

/** Scopes granted to this launch: XBERG_SCOPES (comma list) or all four by default. */
export function resolveLaunchScopes(env: NodeJS.ProcessEnv): AuthScopes[] {
  const raw = env.XBERG_SCOPES;
  if (!raw) return [...ALL_SCOPES];
  const valid = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is AuthScopes => (ALL_SCOPES as string[]).includes(s));
  if (valid.length === 0) {
    throw new AppError("bad_request", "XBERG_SCOPES set but contains no valid scope");
  }
  return valid;
}

export function ownerPrincipal(scopes: AuthScopes[]): Principal {
  return { subject: "owner", scopes };
}

/**
 * Same-origin guard. Reject only when the browser explicitly reports a cross-site
 * or same-site fetch. A missing header (non-browser client, e.g. curl) passes here
 * and is gated by the Bearer token instead.
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site === undefined) return true;
  return site === "same-origin" || site === "none";
}

function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

/** Constant-time string compare via fixed-length SHA-256 digests (avoids length leak). */
function tokenMatches(candidate: string, token: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** Origin guard + Bearer verification. Returns the owner principal or throws AppError. */
export function authenticateHttp(req: IncomingMessage, token: string, scopes: AuthScopes[]): Principal {
  if (!isSameOriginRequest(req)) {
    throw new AppError("scope", "cross-origin request rejected");
  }
  const bearer = extractBearer(req);
  if (!bearer || !tokenMatches(bearer, token)) {
    throw new AppError("auth", "invalid or missing session token");
  }
  return ownerPrincipal(scopes);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npx vitest run tests/auth.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/auth.ts services/mcp-server/tests/auth.test.ts
git commit -m "feat(mcp-server): session token, launch scopes, origin+Bearer HTTP auth"
```

---

## Task 3: `audit_log` table + `recordAudit`/`getAudit`

**Files:**
- Modify: `services/mcp-server/src/store.ts` (add table to `SCHEMA`, add two methods)
- Test: `services/mcp-server/tests/audit.test.ts`

**Interfaces:**
- Consumes: existing `MetadataStore` / `openStore` / `randomUUID`.
- Produces:
  - `interface AuditEntry { id: string; actor: string; scope: string; action: string; matter_id: string | null; created_at: string }`
  - `MetadataStore.recordAudit(actor: string, scope: string, action: string, matterId?: string): AuditEntry`
  - `MetadataStore.getAudit(matterId?: string): AuditEntry[]` — newest first.

- [ ] **Step 1: Write the failing test**

Create `services/mcp-server/tests/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type MetadataStore } from "../src/store.js";

let dir: string;
let store: MetadataStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xberg-audit-"));
  store = openStore(join(dir, "meta.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("audit log", () => {
  it("records and reads back an entry with the real actor", () => {
    const entry = store.recordAudit("owner", "ingest", "create_matter", "m-1");
    expect(entry.actor).toBe("owner");
    expect(entry.action).toBe("create_matter");
    expect(entry.matter_id).toBe("m-1");
    const rows = store.getAudit("m-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("owner");
  });

  it("records an entry with no matter", () => {
    const entry = store.recordAudit("owner", "read", "list_matters");
    expect(entry.matter_id).toBeNull();
    expect(store.getAudit()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npx vitest run tests/audit.test.ts`
Expected: FAIL — `store.recordAudit is not a function`.

- [ ] **Step 3: Add the table and methods**

In `services/mcp-server/src/store.ts`, extend the `SCHEMA` template literal by appending this table (after the `consent` table, before the closing backtick):

```ts
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  matter_id TEXT NULL,
  created_at TEXT NOT NULL
);
```

Add the exported type near the top of `store.ts` (after the imports):

```ts
export interface AuditEntry {
  id: string;
  actor: string;
  scope: string;
  action: string;
  matter_id: string | null;
  created_at: string;
}
```

Add these two methods inside the `MetadataStore` class (e.g. after `isConsentActive`):

```ts
  recordAudit(actor: string, scope: string, action: string, matterId?: string): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      actor,
      scope,
      action,
      matter_id: matterId ?? null,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO audit_log (id, actor, scope, action, matter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.id, entry.actor, entry.scope, entry.action, entry.matter_id, entry.created_at);
    return entry;
  }

  getAudit(matterId?: string): AuditEntry[] {
    if (matterId) {
      return this.db
        .prepare("SELECT id, actor, scope, action, matter_id, created_at FROM audit_log WHERE matter_id = ? ORDER BY created_at DESC")
        .all(matterId) as AuditEntry[];
    }
    return this.db
      .prepare("SELECT id, actor, scope, action, matter_id, created_at FROM audit_log ORDER BY created_at DESC")
      .all() as AuditEntry[];
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npx vitest run tests/audit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/store.ts services/mcp-server/tests/audit.test.ts
git commit -m "feat(mcp-server): audit_log table + recordAudit/getAudit"
```

---

## Task 4: `injectToken(html, token)` for the served UI

**Files:**
- Modify: `services/mcp-server/src/static.ts` (add `injectToken`)
- Test: `services/mcp-server/tests/static.test.ts`

**Interfaces:**
- Produces: `function injectToken(html: string, token: string): string` — inserts `<script>window.__XBERG_TOKEN__=<json>;</script>` immediately after the first `<head>` if present, else prepends it.

- [ ] **Step 1: Write the failing test**

Create `services/mcp-server/tests/static.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { injectToken, PLACEHOLDER_HTML } from "../src/static.js";

describe("injectToken", () => {
  it("inserts the token script right after <head>", () => {
    const out = injectToken("<html><head><title>x</title></head><body></body></html>", "abc123");
    expect(out).toContain('<head><script>window.__XBERG_TOKEN__="abc123";</script>');
    expect(out.indexOf("__XBERG_TOKEN__")).toBeLessThan(out.indexOf("<title>"));
  });

  it("JSON-escapes the token value", () => {
    const out = injectToken("<head></head>", 'a"b');
    expect(out).toContain('window.__XBERG_TOKEN__="a\\"b";');
  });

  it("prepends when there is no <head>", () => {
    const out = injectToken("<div>no head</div>", "tok");
    expect(out.startsWith('<script>window.__XBERG_TOKEN__="tok";</script>')).toBe(true);
  });

  it("works on the placeholder HTML (has a <head>)", () => {
    const out = injectToken(PLACEHOLDER_HTML, "tok");
    expect(out).toContain("__XBERG_TOKEN__");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npx vitest run tests/static.test.ts`
Expected: FAIL — `injectToken` is not exported.

- [ ] **Step 3: Add `injectToken`**

Append to `services/mcp-server/src/static.ts`:

```ts
/** Insert `window.__XBERG_TOKEN__` so the same-origin UI can read the session token. */
export function injectToken(html: string, token: string): string {
  const tag = `<script>window.__XBERG_TOKEN__=${JSON.stringify(token)};</script>`;
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${tag}`);
  }
  return tag + html;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npx vitest run tests/static.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/static.ts services/mcp-server/tests/static.test.ts
git commit -m "feat(mcp-server): injectToken helper for served UI"
```

---

## Task 5: Wire the HTTP surface — guard, scopes, token injection, audit

**Files:**
- Modify: `services/mcp-server/src/index.ts`
- Test: `services/mcp-server/tests/http-auth.test.ts`

**Interfaces:**
- Consumes: `authenticateHttp`, `injectToken`, `authorize`, `AppError`, `createAppContext`, `buildConfig`.
- Produces:
  - `interface HttpAuth { token: string; scopes: AuthScopes[] }`
  - `createHttpServer(ctx: AppContext, auth: HttpAuth)` (signature gains `auth`)
  - `handle(req, res, ctx, auth)` (signature gains `auth`): static routes unauthenticated; `GET /` injects the token; every other route runs `authenticateHttp` → `authorize(principal.scopes, <required>)`; mutations call `ctx.store.recordAudit(principal.subject, <scope>, <action>, matterId?)`.

**Route policy (required scope + audited action):**

| Route | Required scope | Audited action (on success) |
|-------|----------------|-----------------------------|
| `GET /matters`, `/folders`, `/consent`, mirror `.../status` | `read` | — (reads not audited) |
| `POST /matters` | `ingest` | `create_matter` |
| `POST /folders` | `ingest` | `create_folder` |
| `POST /rag/mirror` | `ingest` | `save_mirror` |
| `POST /consent` | `admin` | `grant_consent` |

- [ ] **Step 1: Make `index.ts` import-safe (entrypoint guard)**

`index.ts` ends with a top-level `main().catch(...)`. The integration test imports `../src/index.js`, which would execute `main()` on import — touching the real `~/.xberg`, binding a port, and possibly calling `process.exit(1)` (killing vitest). Guard it so `main()` runs only when the file is the process entrypoint.

Add the import at the top of `services/mcp-server/src/index.ts`:

```ts
import { pathToFileURL } from "node:url";
```

Replace the trailing call:

```ts
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

with:

```ts
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
```

Verify nothing else runs on import: `cd services/mcp-server && npx vitest run tests/store.test.ts` still PASSes (sanity — unaffected file).

- [ ] **Step 2: Write the failing integration test**

Create `services/mcp-server/tests/http-auth.test.ts`:

```ts
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

  it("GET / injects window.__XBERG_TOKEN__ and needs no token", async () => {
    await start(["read"]);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("__XBERG_TOKEN__");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services/mcp-server && npx vitest run tests/http-auth.test.ts`
Expected: FAIL — `createHttpServer` still has arity 1 / no auth enforced (401/403 assertions fail, or a type error on the `auth` argument).

- [ ] **Step 4: Update `index.ts`**

Add imports at the top of `services/mcp-server/src/index.ts` (alongside the existing ones). Note `injectToken` comes from `./static.js`, and `authenticateHttp` from `./auth.js`:

```ts
import { authenticateHttp } from "./auth.js";
import { injectToken } from "./static.js";
import { authorize } from "./mcp/scopes.js";
import type { Principal } from "./principal.js";
```

The existing `import { PLACEHOLDER_HTML, resolveUiDir, resolveWasmPackageDir } from "./static.js";` line already imports from `./static.js` — you may either extend it with `injectToken` or add the separate line above; both compile.

Add the `HttpAuth` interface next to `AppContext` (`AuthScopes` is already imported at the top of `index.ts`):

```ts
export interface HttpAuth {
  token: string;
  scopes: AuthScopes[];
}
```

Change `handle`'s signature and add the guard. Replace the `handle` function header and its static-route block so it reads:

```ts
async function handle(req: IncomingMessage, res: ServerResponse, ctx: AppContext, auth: HttpAuth): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  // --- Static, unauthenticated surface -------------------------------------
  if (pathname === "/" && method === "GET") {
    const uiDir = resolveUiDir();
    const html = uiDir ? readFileSync(join(uiDir, "index.html"), "utf8") : PLACEHOLDER_HTML;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(injectToken(html, auth.token));
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

  // --- Authenticated surface: everything below requires a valid principal ---
  const principal: Principal = authenticateHttp(req, auth.token, auth.scopes);

  if (pathname === "/matters" && method === "GET") {
    authorize(principal.scopes, "read");
    sendJson(res, 200, { matters: ctx.store.getMatters() });
    return;
  }
  if (pathname === "/matters" && method === "POST") {
    authorize(principal.scopes, "ingest");
    const body = await readJson<{ name: string }>(req);
    if (!body.name) throw new AppError("bad_request", "name is required");
    const matter = ctx.store.createMatter(body.name);
    ctx.store.recordAudit(principal.subject, "ingest", "create_matter", matter.id);
    sendJson(res, 201, matter);
    return;
  }

  if (pathname === "/folders" && method === "GET") {
    authorize(principal.scopes, "read");
    const matterId = url.searchParams.get("matter_id");
    if (!matterId) throw new AppError("bad_request", "matter_id is required");
    sendJson(res, 200, { folders: ctx.store.getFolders(matterId) });
    return;
  }
  if (pathname === "/folders" && method === "POST") {
    authorize(principal.scopes, "ingest");
    const body = await readJson<{ matter_id: string; name: string; path?: string }>(req);
    if (!body.matter_id || !body.name) throw new AppError("bad_request", "matter_id and name are required");
    const folder = ctx.store.createFolder(body.matter_id, body.name, body.path);
    ctx.store.recordAudit(principal.subject, "ingest", "create_folder", body.matter_id);
    sendJson(res, 201, folder);
    return;
  }

  if (pathname === "/consent" && method === "GET") {
    authorize(principal.scopes, "read");
    const matterId = url.searchParams.get("matter_id");
    if (!matterId) throw new AppError("bad_request", "matter_id is required");
    sendJson(res, 200, { consent: ctx.store.getConsent(matterId) });
    return;
  }
  if (pathname === "/consent" && method === "POST") {
    authorize(principal.scopes, "admin");
    const body = await readJson<{ subject: string; matter_id: string; scope: string; expires_at?: string }>(req);
    if (!body.subject || !body.matter_id || !body.scope) {
      throw new AppError("bad_request", "subject, matter_id and scope are required");
    }
    const record = ctx.store.grantConsent({
      subject: body.subject,
      matter_id: body.matter_id,
      scope: body.scope as AuthScopes,
      expires_at: body.expires_at,
    });
    ctx.store.recordAudit(principal.subject, "admin", "grant_consent", body.matter_id);
    sendJson(res, 201, record);
    return;
  }

  if (pathname === "/rag/mirror" && method === "POST") {
    authorize(principal.scopes, "ingest");
    const matterId = url.searchParams.get("matter_id");
    if (!matterId) throw new AppError("bad_request", "matter_id is required");
    const body = await readBody(req);
    const status = ctx.mirror.saveMirror(matterId, body);
    ctx.store.recordAudit(principal.subject, "ingest", "save_mirror", matterId);
    sendJson(res, 201, status);
    return;
  }

  const mirrorStatus = pathname.match(/^\/rag\/mirror\/([^/]+)\/status$/);
  if (mirrorStatus && method === "GET") {
    authorize(principal.scopes, "read");
    const matterId = decodeURIComponent(mirrorStatus[1] ?? "");
    const status = ctx.mirror.status(matterId);
    if (!status) throw new AppError("not_found", `no mirror for matter ${matterId}`);
    sendJson(res, 200, status);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}
```

Update `createHttpServer` to accept and forward `auth`:

```ts
export function createHttpServer(ctx: AppContext, auth: HttpAuth) {
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
```

> Remove the now-unused `serveFile` import usage for `/` only if the linter flags it — `serveFile` is still used by `handleModels`/`serveStaticDir`, so keep the import.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/mcp-server && npx vitest run tests/http-auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full suite + typecheck**

Run: `cd services/mcp-server && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add services/mcp-server/src/index.ts services/mcp-server/tests/http-auth.test.ts
git commit -m "feat(mcp-server): enforce origin guard, session token, scopes, and audit on HTTP"
```

---

## Task 6: Wire `main()` and the MCP-stdio principal

**Files:**
- Modify: `services/mcp-server/src/index.ts` (`main()`)
- Modify: `services/mcp-server/src/mcp/mod.ts` (`runMcp` signature + log)

**Interfaces:**
- Consumes: `loadOrCreateSessionToken`, `resolveLaunchScopes`, `ownerPrincipal` from `./auth.js`; `Principal` from `../principal.js`.
- Produces: `runMcp(ctx: AppContext, principal: Principal): Promise<void>` (gains `principal`). `main()` loads the token + scopes, passes `HttpAuth` to `createHttpServer`, and passes `ownerPrincipal(scopes)` to `runMcp`.

- [ ] **Step 1: Update `runMcp` to accept the principal**

In `services/mcp-server/src/mcp/mod.ts`, add the import and change the signature + ready log:

```ts
import type { Principal } from "../principal.js";
```

```ts
export async function runMcp(ctx: AppContext, principal: Principal): Promise<void> {
  const server = new Server(
    { name: "@xberg-io/mcp-server", version: "1.0.0-rc.27" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const known = TOOLS.find((t) => t.name === name);
    if (!known) {
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    return stubContent(name);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Single-owner model: the process spawn is the auth boundary. `principal` is the
  // identity the tool layer (Plan 4) will enforce scopes/consent/audit against.
  console.error(
    `[xberg-mcp] MCP server ready as subject="${principal.subject}" ` +
      `(scopes: ${principal.scopes.join(",")}); data dir ${ctx.config.dataDir}`,
  );
}
```

- [ ] **Step 2: Update `main()`**

In `services/mcp-server/src/index.ts`, add imports:

```ts
import { loadOrCreateSessionToken, resolveLaunchScopes, ownerPrincipal } from "./auth.js";
```

Replace the body of `main()`:

```ts
async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = buildConfig(args);
  const ctx = createAppContext(config);
  const scopes = resolveLaunchScopes(process.env);

  if (args.command === "mcp") {
    await runMcp(ctx, ownerPrincipal(scopes));
    return;
  }

  const token = loadOrCreateSessionToken(config.dataDir);
  const server = createHttpServer(ctx, { token, scopes });
  server.listen(config.port, config.host, () => {
    console.log(`[xberg-mcp] serving http://${config.host}:${config.port}`);
    console.log(`[xberg-mcp] data dir: ${config.dataDir}`);
    console.log(`[xberg-mcp] session token: ${config.dataDir}/session.token (mode 0600)`);
  });
}
```

- [ ] **Step 3: Typecheck + full suite**

Run: `cd services/mcp-server && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests PASS.

- [ ] **Step 4: Manual smoke test (entrypoint glue)**

```bash
cd services/mcp-server
npx tsc
XBERG_DATA_DIR="$(mktemp -d)" node dist/index.js serve --port 8799 &
SRV=$!
sleep 1
TOKEN=$(cat "$XBERG_DATA_DIR/session.token" 2>/dev/null || cat "$(ls -d /tmp/tmp.* | tail -1)/session.token")
# Expect 401 (no token):
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8799/matters
# Expect 200 (with token):
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8799/matters
# Expect the injected token in the page:
curl -s http://127.0.0.1:8799/ | grep -o "__XBERG_TOKEN__"
kill $SRV
```
Expected: `401`, then `200`, then `__XBERG_TOKEN__`.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/index.ts services/mcp-server/src/mcp/mod.ts
git commit -m "feat(mcp-server): wire session token + owner principal into main() and stdio"
```

---

## Task 7: Close out — README note + issue reference

**Files:**
- Modify: `services/mcp-server/README.md` (if present; else create a short one)

**Interfaces:** none.

- [ ] **Step 1: Document the auth model**

Add a section to `services/mcp-server/README.md` (create the file with just this section if it does not exist):

```markdown
## Local auth (single-owner)

This service is local-first and single-owner. `subject` is always `"owner"`.

- **HTTP** (`serve`): a per-launch 256-bit token is written to `<dataDir>/session.token`
  (mode 0600) and injected into `GET /` as `window.__XBERG_TOKEN__`. All non-static
  routes require `Authorization: Bearer <token>` and reject cross-site requests
  (`Sec-Fetch-Site`). Scopes default to all four; restrict a launch with
  `XBERG_SCOPES=read` (comma list). Mutations are recorded in `audit_log`.
- **MCP stdio** (`mcp`): no token — the process spawn by the owner's client is the
  auth boundary. The owner principal is reserved for the tool layer (Plan 4).

Not built here (deliberately): JWT, multi-subject/multi-tenant, per-identity matter
scoping, per-tool consent enforcement (needs the un-stubbed tool layer — Plan 4).
```

- [ ] **Step 2: Commit**

```bash
git add services/mcp-server/README.md
git commit -m "docs(mcp-server): document local single-owner auth model (closes #8)"
```

- [ ] **Step 3: (Optional) push + PR**

Only if the user asks. The PR body should reference issue #8 and note that egress+vault already landed on `main` via `0a368aa822`, and that per-tool consent/actor enforcement is deferred to the tool-layer plan (Plan 4).

---

## Verification (whole plan)

- [ ] `cd services/mcp-server && npx tsc --noEmit` — no type errors.
- [ ] `cd services/mcp-server && npx vitest run` — all suites pass (`scopes`, `auth`, `audit`, `static`, `http-auth`, plus existing `store`/`mirror`/`vault`).
- [ ] Manual smoke (Task 6, Step 4): 401 → 200 → token injected.
- [ ] Grep check: `grep -rn "tokenScopes" services/mcp-server/src` returns nothing (the old static field never re-enters `main`).
