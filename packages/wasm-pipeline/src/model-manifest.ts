import {
  API_BASE,
  GRANITE_EMBEDDING_FALLBACK_FILES,
  GRANITE_EMBEDDING_FALLBACK_SHA256,
  GRANITE_EMBEDDING_MANIFEST_NAMES,
  MODEL_MANIFEST_URL,
} from "./constants";
import { cachedFetchJson } from "./model-cache";

interface ModelManifestEntry {
  name: string;
  file: string;
  sha256: string;
}

interface ModelManifest {
  models: ModelManifestEntry[];
}

export interface GraniteArtifactDescriptor {
  url: string;
  sha256: string;
}

export interface GraniteArtifactSet {
  model: GraniteArtifactDescriptor;
  tokenizer: GraniteArtifactDescriptor;
  config: GraniteArtifactDescriptor;
}

let manifestPromise: Promise<ModelManifest | null> | null = null;

function isModelManifestEntry(value: unknown): value is ModelManifestEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["name"] === "string" &&
    typeof entry["file"] === "string" &&
    typeof entry["sha256"] === "string"
  );
}

async function loadModelManifest(): Promise<ModelManifest | null> {
  if (!manifestPromise) {
    manifestPromise = cachedFetchJson(MODEL_MANIFEST_URL)
      .then((value) => {
        if (!value || typeof value !== "object") return null;
        const models = (value as { models?: unknown }).models;
        if (
          !Array.isArray(models) ||
          models.some((entry) => !isModelManifestEntry(entry))
        )
          return null;
        return { models };
      })
      .catch(() => null);
  }
  return manifestPromise;
}

function manifestFileUrl(file: string): string {
  return `${API_BASE}/models/${file}`;
}

function fallbackGraniteArtifacts(): GraniteArtifactSet {
  return {
    model: {
      url: manifestFileUrl(GRANITE_EMBEDDING_FALLBACK_FILES.model),
      sha256: GRANITE_EMBEDDING_FALLBACK_SHA256.model,
    },
    tokenizer: {
      url: manifestFileUrl(GRANITE_EMBEDDING_FALLBACK_FILES.tokenizer),
      sha256: GRANITE_EMBEDDING_FALLBACK_SHA256.tokenizer,
    },
    config: {
      url: manifestFileUrl(GRANITE_EMBEDDING_FALLBACK_FILES.config),
      sha256: GRANITE_EMBEDDING_FALLBACK_SHA256.config,
    },
  };
}

function resolveEntry(
  manifest: ModelManifest,
  name: string,
): ModelManifestEntry | undefined {
  return manifest.models.find((entry) => entry.name === name);
}

export async function resolveGraniteArtifacts(): Promise<GraniteArtifactSet> {
  const manifest = await loadModelManifest();
  if (!manifest) return fallbackGraniteArtifacts();
  const model = resolveEntry(manifest, GRANITE_EMBEDDING_MANIFEST_NAMES.model);
  const tokenizer = resolveEntry(
    manifest,
    GRANITE_EMBEDDING_MANIFEST_NAMES.tokenizer,
  );
  const config = resolveEntry(
    manifest,
    GRANITE_EMBEDDING_MANIFEST_NAMES.config,
  );
  if (!model || !tokenizer || !config) return fallbackGraniteArtifacts();
  return {
    model: { url: manifestFileUrl(model.file), sha256: model.sha256 },
    tokenizer: {
      url: manifestFileUrl(tokenizer.file),
      sha256: tokenizer.sha256,
    },
    config: { url: manifestFileUrl(config.file), sha256: config.sha256 },
  };
}

export function resetModelManifestCache(): void {
  manifestPromise = null;
}
