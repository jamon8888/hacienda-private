import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(__dirname, "..", "..", "models", "manifest.json");
const PLACEHOLDER = "TODO_PIN_SHA256";

async function fetchBuffer(url) {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
	}
	return Buffer.from(await res.arrayBuffer());
}

async function zipWithZipCLI(srcDir, outZip) {
	const zip = spawnSync("zip", ["-r", "-q", outZip, "."], { cwd: srcDir });
	if (zip.error) {
		throw new Error(
			"Native 'zip' binary not found. Install zip (apt-get install zip / brew install zip) to build the offline bundle.",
		);
	}
	if (zip.status !== 0) {
		throw new Error(`zip failed: ${zip.stderr?.toString() || "unknown error"}`);
	}
}

async function main() {
	if (!existsSync(manifestPath)) {
		throw new Error("Model manifest not found at ../models/manifest.json");
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const models = manifest.models || [];

	const unpinned = models.filter((m) => !m.sha256 || m.sha256 === PLACEHOLDER);
	if (unpinned.length > 0) {
		throw new Error(
			`Cannot build offline bundle: ${unpinned.length} model(s) still have ${PLACEHOLDER}. ` +
				`Run 'node scripts/pin-models.mjs' with network access first.`,
		);
	}

	const outDir = join(__dirname, "..", "offline");
	const modelDir = join(outDir, "models");
	rmSync(modelDir, { recursive: true, force: true });
	mkdirSync(modelDir, { recursive: true });

	for (const model of models) {
		if (!model.url || !model.file) {
			throw new Error(`Model '${model.name}' is missing url or file`);
		}
		console.error(`Fetching ${model.name} -> ${model.file}`);
		const buf = await fetchBuffer(model.url);
		writeFileSync(join(modelDir, model.file), buf);
		writeFileSync(join(modelDir, model.file + ".sha256"), model.sha256 + "\n");
	}

	const manifestCopy = join(modelDir, "manifest.json");
	writeFileSync(manifestCopy, JSON.stringify(manifest, null, 2) + "\n");

	const outZip = join(outDir, "xberg-mcp-offline.zip");
	console.error(`Zipping offline bundle -> ${outZip}`);
	zipWithZipCLI(modelDir, outZip);

	console.log(`Offline bundle written: ${outZip}`);
	console.log("Extract into ~/.xberg/models/ (or the equivalent data dir) on an air-gapped machine.");
}

main().catch((err) => {
	console.error(`make-offline-bundle failed: ${err.message}`);
	process.exit(1);
});
