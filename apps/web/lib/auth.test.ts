import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { useAuth } from "./auth";

describe("local auth", () => {
  beforeEach(() => {
    sessionStorage.clear();
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
