import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { useAuth } from "./auth";

describe("local auth", () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete (window as unknown as { __XBERG_TOKEN__?: string }).__XBERG_TOKEN__;
  });

  it("ensureAuth prefers the server-injected token over generating one", () => {
    // The server authorizes exactly one Bearer token per process and injects it as
    // window.__XBERG_TOKEN__ (see services/mcp-server/src/static.ts injectToken) — a
    // self-generated random token could never match it, so every authenticated API call would
    // 401 for a client that ignores this.
    (window as unknown as { __XBERG_TOKEN__?: string }).__XBERG_TOKEN__ = "server-issued-token";
    const { result } = renderHook(() => useAuth());
    const a = result.current.ensureAuth();
    expect(a.token).toBe("server-issued-token");
  });

  it("ensureAuth creates and persists a token", () => {
    const { result } = renderHook(() => useAuth());
    const a = result.current.ensureAuth();
    expect(a.token).toMatch(/^[0-9a-f]{48}$/);
    expect(a.scopes).toContain("ingest");
    const raw = sessionStorage.getItem("xberg.localAuth");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).token).toBe(a.token);
  });

  it("ensureAuth returns existing token on repeat", () => {
    const { result } = renderHook(() => useAuth());
    const first = result.current.ensureAuth();
    const second = result.current.ensureAuth();
    expect(second.token).toBe(first.token);
  });

  it("login overrides with provided scopes", () => {
    const { result } = renderHook(() => useAuth());
    const a = result.current.login(["read"]);
    expect(a.scopes).toEqual(["read"]);
  });

  it("logout clears the session", () => {
    const { result } = renderHook(() => useAuth());
    act(() => {
      result.current.login();
      result.current.logout();
    });
    expect(sessionStorage.getItem("xberg.localAuth")).toBeNull();
  });
});
