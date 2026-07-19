// packages/node-pipeline/src/gliner-catalog.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelManifestEntry } from "@xberg-io/core";

export const GLINER_MODELS_REPO = "xberg-io/gliner-models";

export interface GlinerModelDefinition {
  id: string;
  aliases: string[];
  modelFile: string;
  tokenizerFile: string;
}

// Mirrors crates/xberg/src/text/ner/gline.rs::GLINER_MODELS exactly.
export const GLINER_MODEL_DEFINITIONS: GlinerModelDefinition[] = [
  {
    id: "gliner_small-v2.5",
    aliases: ["fast"],
    modelFile: "models/gliner_small-v2.5/span/fp32/model.onnx",
    tokenizerFile: "models/gliner_small-v2.5/span/fp32/tokenizer.json",
  },
  {
    id: "gliner_medium-v2.5",
    aliases: ["balanced", "multilingual"],
    modelFile: "models/gliner_medium-v2.5/span/fp32/model.onnx",
    tokenizerFile: "models/gliner_medium-v2.5/span/fp32/tokenizer.json",
  },
  {
    id: "gliner_large-v2.5",
    aliases: ["quality"],
    modelFile: "models/gliner_large-v2.5/span/fp32/model.onnx",
    tokenizerFile: "models/gliner_large-v2.5/span/fp32/tokenizer.json",
  },
];

export const DEFAULT_GLINER_MODEL = "gliner_medium-v2.5";

export function parseGlinerChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\.?\/?(.+)$/i);
    if (!match) continue;
    const [, sha, path] = match;
    if (sha && path) out[path] = sha.toLowerCase();
  }
  return out;
}

function localFileFor(modelId: string, kind: "model.onnx" | "tokenizer.json"): string {
  return `gliner/${modelId}/${kind}`;
}

export function buildGlinerManifestEntries(checksums: Record<string, string>): ModelManifestEntry[] {
  const entries: ModelManifestEntry[] = [];
  for (const def of GLINER_MODEL_DEFINITIONS) {
    for (const [remoteFile, localKind, suffix] of [
      [def.modelFile, "model.onnx", "model"],
      [def.tokenizerFile, "tokenizer.json", "tokenizer"],
    ] as const) {
      const sha256 = checksums[remoteFile];
      if (!sha256) {
        throw new Error(`missing checksum for ${remoteFile} (model ${def.id})`);
      }
      entries.push({
        name: `${def.id}.${suffix}`,
        url: `https://huggingface.co/${GLINER_MODELS_REPO}/resolve/main/${remoteFile}`,
        file: localFileFor(def.id, localKind),
        sha256,
      });
    }
  }
  return entries;
}

const CHECKSUM_FILE_PATH = fileURLToPath(new URL("./gliner-models.sha256", import.meta.url));

export function loadGlinerManifestEntries(): ModelManifestEntry[] {
  const text = readFileSync(CHECKSUM_FILE_PATH, "utf8");
  return buildGlinerManifestEntries(parseGlinerChecksums(text));
}
