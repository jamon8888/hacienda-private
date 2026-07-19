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
    // Windows/NTFS has no POSIX permission bits — chmodSync is a best-effort no-op there
    // (see the matching comment in src/auth.ts), so the exact mode is only meaningful on
    // platforms that actually enforce it.
    if (process.platform !== "win32") {
      const mode = statSync(join(dir, "session.token")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
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
  it("keeps only the valid scopes from a mixed list", () => {
    expect(resolveLaunchScopes({ XBERG_SCOPES: "read,bogus,redact" })).toEqual(["read", "redact"]);
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
