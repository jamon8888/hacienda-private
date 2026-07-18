import { describe, it, expect } from "vitest";
import * as engine from "./index";

describe("engine adapter contract", () => {
  it("exposes ingestFolder as a function", () => {
    expect(typeof engine.ingestFolder).toBe("function");
  });
  it("exposes extractDocument", () => {
    expect(typeof engine.extractDocument).toBe("function");
  });
  it("exposes queryRag", () => {
    expect(typeof engine.queryRag).toBe("function");
  });
  it("exposes redactDocument", () => {
    expect(typeof engine.redactDocument).toBe("function");
  });
});
