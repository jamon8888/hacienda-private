import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import type { AuthScopes } from "@xberg-io/core";
import { AppError } from "./error.js";
import type { Principal } from "./principal.js";

const ALL_SCOPES: AuthScopes[] = ["read", "ingest", "redact", "admin"];

/** Load the persisted session token, or generate + persist a new 256-bit one (file mode 0600). */
export function loadOrCreateSessionToken(dataDir: string): string {
  const path = resolve(dataDir, "session.token");
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString("hex");
  try {
    // Exclusive create ("wx") — atomic against a concurrent launch racing to create
    // the same file. If another process won, read and reuse its token instead.
    writeFileSync(path, token, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return readFileSync(path, "utf8").trim();
    }
    throw err;
  }
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
