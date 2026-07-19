import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { buildConfig } from "../src/config.js";

describe("buildConfig manifestPath", () => {
  it("resolves to an existing manifest under mcp-server/models", () => {
    const cfg = buildConfig({ command: "serve", host: "127.0.0.1", port: 8787, dataDir: "/tmp/xberg-cfg-test" });
    expect(cfg.manifestPath.replace(/\\/g, "/")).toMatch(/services\/mcp-server\/models\/manifest\.json$/);
    expect(existsSync(cfg.manifestPath)).toBe(true);
  });
});
