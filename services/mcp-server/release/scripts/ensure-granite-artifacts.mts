import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildConfig, parseArgs } from "../../src/config.ts";
import { ModelCache } from "../../src/models.ts";

async function main() {
  const outDir = process.argv[2] ? resolve(process.argv[2]) : null;
  const config = buildConfig(parseArgs(["node", "ensure-granite-artifacts", "serve"]));
  const models = new ModelCache(config.modelCacheDir, config.manifestPath);
  const artifacts = await models.ensureGraniteEmbeddingArtifacts();

  if (!outDir) {
    process.stdout.write(`${artifacts.modelDir}\n`);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const files = [
    { source: artifacts.weightsPath, target: join(outDir, "model.safetensors") },
    { source: artifacts.tokenizerPath, target: join(outDir, "tokenizer.json") },
    { source: artifacts.configPath, target: join(outDir, "config.json") },
  ];
  for (const file of files) {
    mkdirSync(dirname(file.target), { recursive: true });
    copyFileSync(file.source, file.target);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
