import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelManifest, ModelManifestEntry } from "@xberg-io/core";
import { loadGlinerManifestEntries } from "@xberg-io/node-pipeline";
import { PLACEHOLDER_SHA } from "./config.js";
import { AppError } from "./error.js";

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export class ModelCache {
  private readonly manifest: ModelManifest;
  private readonly manifestByFile: Map<string, ModelManifestEntry>;

  constructor(
    private readonly modelCacheDir: string,
    manifestPath: string,
  ) {
    let parsed: ModelManifest;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as ModelManifest;
    } catch {
      // Manifest missing/unreadable: the server must still boot and serve the UI. Models simply
      // cannot be served (ensureModel fails closed on unknown + placeholder), and the release
      // `check-pins` guard blocks publishing with an unpinned manifest.
      parsed = { models: [] };
    }
    if (!parsed || !Array.isArray(parsed.models)) {
      throw new AppError("model", "model manifest is malformed");
    }
    try {
      const glinerEntries = loadGlinerManifestEntries();
      const existingNames = new Set(parsed.models.map((m) => m.name));
      for (const entry of glinerEntries) {
        if (!existingNames.has(entry.name)) parsed.models.push(entry);
      }
    } catch {
      // GLiNER catalog unavailable (e.g. package not built yet) — base manifest still serves.
    }
    this.manifest = parsed;
    this.manifestByFile = new Map(parsed.models.map((m) => [m.file, m]));
    mkdirSync(modelCacheDir, { recursive: true });
  }

  getManifest(): ModelManifest {
    return this.manifest;
  }

  resolveByFile(file: string): ModelManifestEntry | undefined {
    return this.manifestByFile.get(file);
  }

  async ensureModel(name: string): Promise<string> {
    const entry = this.manifest.models.find((m) => m.name === name);
    if (!entry) {
      throw new AppError("model", `unknown model '${name}'`);
    }

    if (entry.sha256 === PLACEHOLDER_SHA || entry.sha256.trim() === "") {
      throw new AppError("model", `model '${name}' is not pinned (SHA256 placeholder) — refusing to serve`);
    }

    const cachePath = `${this.modelCacheDir}/${entry.file}`;
    if (existsSync(cachePath)) {
      const existing = await sha256File(cachePath);
      if (existing === entry.sha256) {
        return cachePath;
      }
      throw new AppError("model", `cached model '${name}' SHA256 mismatch — refusing to serve`);
    }

    const downloaded = await this.download(entry, cachePath);
    const actual = await sha256File(downloaded);
    if (actual !== entry.sha256) {
      throw new AppError("model", `downloaded model '${name}' SHA256 mismatch — refusing to serve`);
    }
    return downloaded;
  }

  private async download(entry: ModelManifestEntry, cachePath: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(entry.url);
    } catch {
      throw new AppError("model", `failed to download model '${entry.name}'`);
    }
    if (!res.ok || !res.body) {
      throw new AppError("model", `model '${entry.name}' download returned ${res.status}`);
    }

    mkdirSync(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.part`;
    const file = await import("node:fs/promises").then((m) => m.open(tmp, "w"));
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await file.write(Buffer.from(value));
      }
    } finally {
      await file.close();
    }
    writeFileSync(cachePath, readFileSync(tmp));
    try {
      chmodSync(cachePath, 0o600);
    } catch {
      // best-effort
    }
    return cachePath;
  }
}
