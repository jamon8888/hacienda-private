import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(__dirname, "..", "..", "models", "manifest.json");

const PLACEHOLDER = "TODO_PIN_SHA256";

function sha256OfFile(path) {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

async function main() {
  if (!existsSync(manifestPath)) {
    throw new Error("Model manifest not found at ../models/manifest.json");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.models)) {
    throw new Error("Manifest is missing a 'models' array");
  }

  const alreadyPinned = manifest.models.filter((m) => m.sha256 && m.sha256 !== PLACEHOLDER);
  const needsPin = manifest.models.filter((m) => !m.sha256 || m.sha256 === PLACEHOLDER);

  if (needsPin.length === 0) {
    console.log("All models already pinned. Nothing to do.\n");
    printTable(manifest.models);
    return;
  }

  if (alreadyPinned.length > 0) {
    console.log(`Skipping ${alreadyPinned.length} already-pinned model(s).`);
  }

  const workDir = join(tmpdir(), "xberg-pin-" + Date.now());
  mkdirSync(workDir, { recursive: true });

  for (const model of needsPin) {
    if (!model.url) {
      throw new Error(`Model '${model.name}' has no download url`);
    }
    const dest = join(workDir, model.file || model.name);
    console.error(`Downloading ${model.name} ...`);
    await downloadTo(model.url, dest);
    model.sha256 = sha256OfFile(dest);
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log("\nPinned models:\n");
  printTable(manifest.models);
}

function printTable(models) {
  console.log("  name            sha256");
  console.log("  --------------- ----------------------------------------");
  for (const m of models) {
    console.log(`  ${m.name.padEnd(15)} ${m.sha256}`);
  }
}

main().catch((err) => {
  console.error(`pin-models failed: ${err.message}`);
  process.exit(1);
});
