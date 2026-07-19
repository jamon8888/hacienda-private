import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Principal, AuthScopes } from "./principal.js";

const SESSION_TOKEN_FILE = "session.token";
const TOKEN_BYTES = 32;

export interface HttpAuth {
  token: string;
  scopes: AuthScopes[];
}

export function loadOrCreateSessionToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const tokenPath = resolve(dataDir, SESSION_TOKEN_FILE);

  // Atomic exclusive create: if another process created it, read that one
  try {
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch {
    // File exists — read the existing token
    return readFileSync(tokenPath, "utf8").trim();
  }
}

export function resolveLaunchScopes(env: NodeJS.ProcessEnv = process.env): AuthScopes[] {
  const raw = env.XBERG_SCOPES?.trim();
  if (!raw) return ["read", "ingest", "redact", "admin"];
  const scopes = raw.split(",").map((s) => s.trim()).filter(Boolean) as AuthScopes[];
  const valid: AuthScopes[] = ["read", "ingest", "redact", "admin"];
  for (const s of scopes) {
    if (!valid.includes(s)) {
      throw new Error(`XBERG_SCOPES contains invalid scope: ${s}`);
    }
  }
  return scopes.length > 0 ? scopes : ["read", "ingest", "redact", "admin"];
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (!value) return "";
  return Array.isArray(value) ? value[0] ?? "" : value;
}

export function isSameOriginRequest(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const secFetchSite = normalizeHeaderValue(req.headers["sec-fetch-site"]);
  return secFetchSite === "same-origin" || secFetchSite === "same-site";
}

export function authenticateHttp(
  req: { headers: Record<string, string | string[] | undefined> },
  expectedToken: string,
  launchScopes: AuthScopes[],
): Principal {
  const authHeader = normalizeHeaderValue(req.headers.authorization);
  const provided = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";

  // Constant-time comparison
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  const tokenOk = expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);

  const originOk = isSameOriginRequest(req);

  if (!tokenOk || !originOk) {
    return { subject: "anonymous", scopes: [] };
  }
  return { subject: "owner", scopes: launchScopes };
}