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
