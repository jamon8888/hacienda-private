import { describe, it, expect } from "vitest";
import { routeIdFromLocation } from "./route-id";

describe("routeIdFromLocation", () => {
  it("extracts the real id from the current browser URL, not a stale fallback", () => {
    window.history.pushState({}, "", "/matters/8d8e5c10-a4e6-4b48-becd-ef0b8285ea9a");
    expect(routeIdFromLocation("matters", "_")).toBe("8d8e5c10-a4e6-4b48-becd-ef0b8285ea9a");
  });

  it("decodes URL-encoded segments", () => {
    window.history.pushState({}, "", "/documents/some%20id%20with%20spaces");
    expect(routeIdFromLocation("documents", "_")).toBe("some id with spaces");
  });

  it("falls back when the segment isn't present in the path", () => {
    window.history.pushState({}, "", "/onboarding");
    expect(routeIdFromLocation("matters", "_")).toBe("_");
  });

  it("falls back when the segment is the last path component (no id after it)", () => {
    window.history.pushState({}, "", "/matters");
    expect(routeIdFromLocation("matters", "_")).toBe("_");
  });
});
