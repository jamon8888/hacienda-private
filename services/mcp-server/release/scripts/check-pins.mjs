import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(__dirname, "..", "..", "models", "manifest.json");
const PLACEHOLDER = "TODO_PIN_SHA256";

function main() {
  if (!existsSync(manifestPath)) {
    console.error("ERROR: model manifest not found at ../models/manifest.json");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const models = manifest.models || [];
  const unpinned = models.filter((m) => !m.sha256 || m.sha256 === PLACEHOLDER);

  if (unpinned.length > 0) {
    console.error(
      `FAIL: ${unpinned.length} model(s) still have the ${PLACEHOLDER} placeholder and must be pinned before release:`,
    );
    for (const m of unpinned) {
      console.error(`  - ${m.name} (${m.url})`);
    }
    console.error("Run: node scripts/pin-models.mjs");
    process.exit(1);
  }
  console.log("OK: all model SHA256 pins present.");
}

main();
