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
  it("exposes warmupModels", () => {
    expect(typeof engine.warmupModels).toBe("function");
  });
  it("exposes reviewAndRepush", () => {
    expect(typeof engine.reviewAndRepush).toBe("function");
  });
  it("exposes chunkIndexFromToken", () => {
    expect(typeof engine.chunkIndexFromToken).toBe("function");
  });
  it("exposes openVault", () => {
    expect(typeof engine.openVault).toBe("function");
  });
  it("exposes rehydrate", () => {
    expect(typeof engine.rehydrate).toBe("function");
  });
  it("exposes listPiiTypes", () => {
    expect(typeof engine.listPiiTypes).toBe("function");
  });
});
