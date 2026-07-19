import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPii, resolveLocalOnnxWasmPaths, RUST_ALIGNED_PII_TYPES } from "./ner.js";

/**
 * Walks up from a starting directory to the nearest ancestor directory
 * whose package.json declares the given package name — i.e. that package's
 * own installed root. Used to read gliner's (and onnxruntime-web's) *own*
 * installed package.json, not whatever `require.resolve("gliner/package.json")`
 * would give (that subpath isn't in gliner's exports map, so it isn't
 * resolvable directly).
 */
function findOwnPackageJson(startDir: string, packageName: string): Record<string, unknown> {
	let dir = startDir;
	for (;;) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) {
			const pkg = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
			if (pkg.name === packageName) return pkg;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`Could not find installed package.json for "${packageName}" above ${startDir}`);
		}
		dir = parent;
	}
}

describe("RUST_ALIGNED_PII_TYPES", () => {
	it("matches the Rust EntityCategory taxonomy plus the two custom labels", () => {
		expect(RUST_ALIGNED_PII_TYPES).toEqual([
			"person",
			"organization",
			"location",
			"date",
			"time",
			"money",
			"percent",
			"email",
			"phone",
			"url",
			"ssn",
			"financial",
		]);
	});
});

describe("resolveLocalOnnxWasmPaths", () => {
	it("resolves to a real local directory, never the onnxruntime-web CDN default", () => {
		const wasmPaths = resolveLocalOnnxWasmPaths();

		expect(wasmPaths).not.toMatch(/^https?:/);
		expect(wasmPaths).not.toContain("cdn.jsdelivr.net");
		expect(wasmPaths.endsWith("/")).toBe(true);

		// Strip the trailing slash convention (wasmPaths is concatenated with a
		// filename by gliner's ONNXWebWrapper) to check the directory on disk.
		const dir = wasmPaths.slice(0, -1);
		expect(existsSync(dir)).toBe(true);
	});

	it("resolves onnxruntime-web's WASM directory from gliner's OWN installed copy, not node-pipeline's direct dependency", () => {
		// node-pipeline declares its own direct onnxruntime-web dependency, but
		// gliner pins and imports a separate, private copy of onnxruntime-web
		// under pnpm's isolated node_modules. ONNXWebWrapper (inside gliner)
		// assigns wasmPaths onto *gliner's own* ort.env.wasm, so handing it
		// wasm binaries from a different onnxruntime-web version than the one
		// gliner's JS runtime actually imports is a real version mismatch. This
		// test reads gliner's pinned version straight from its own installed
		// package.json (never a hardcoded version string, so pin drift can't
		// silently make this test meaningless) and asserts the resolved WASM
		// directory actually belongs to that exact installed copy.
		const require = createRequire(import.meta.url);
		const glinerEntryPath = require.resolve("gliner");
		const glinerPkg = findOwnPackageJson(dirname(glinerEntryPath), "gliner");
		const glinerDeps = glinerPkg.dependencies as Record<string, string>;
		const glinerPinnedOnnxVersion = glinerDeps["onnxruntime-web"];
		expect(glinerPinnedOnnxVersion).toBeTruthy();

		const wasmPaths = resolveLocalOnnxWasmPaths();
		const wasmDir = wasmPaths.slice(0, -1);

		// The resolved WASM directory sits at .../onnxruntime-web/dist under
		// the installed onnxruntime-web package root; read that package's own
		// package.json to get the actual version physically on disk there.
		const onnxPkg = findOwnPackageJson(wasmDir, "onnxruntime-web");
		const resolvedOnnxVersion = onnxPkg.version as string;

		expect(resolvedOnnxVersion).toBe(glinerPinnedOnnxVersion);

		// Guard against a regression back to node-pipeline's own direct
		// dependency: if that version genuinely differs from gliner's pinned
		// version (the exact bug this test targets), the resolved path must
		// NOT be node-pipeline's own onnxruntime-web copy.
		const nodePipelineOnnxEntry = require.resolve("onnxruntime-web");
		const nodePipelineOnnxPkg = findOwnPackageJson(dirname(nodePipelineOnnxEntry), "onnxruntime-web");
		const nodePipelineOnnxVersion = nodePipelineOnnxPkg.version as string;
		if (nodePipelineOnnxVersion !== glinerPinnedOnnxVersion) {
			expect(resolvedOnnxVersion).not.toBe(nodePipelineOnnxVersion);
		}
	});
});

describe.skip("detectPii (real model — run manually, needs network)", () => {
	it("detects a person and organization", async () => {
		const entities = await detectPii(
			"Elon Musk founded SpaceX in Hawthorne, California.",
			process.env.GLINER_MODEL_PATH ?? "",
			process.env.GLINER_TOKENIZER_PATH ?? "",
		);
		const texts = entities.map((e) => e.text);
		expect(texts).toEqual(expect.arrayContaining([expect.stringContaining("Musk")]));
	});
});
