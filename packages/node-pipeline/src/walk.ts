import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const SUPPORTED_EXTENSIONS = new Set([
	".pdf",
	".docx",
	".doc",
	".txt",
	".md",
	".markdown",
	".csv",
	".html",
	".htm",
	".json",
	".rtf",
]);

export interface WalkedFile {
	path: string;
	contentHash: string;
}

export function hashBytes(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function walkFolder(rootDir: string): Promise<WalkedFile[]> {
	const results: WalkedFile[] = [];
	await walkDir(rootDir, results);
	return results;
}

async function walkDir(dir: string, results: WalkedFile[]): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkDir(fullPath, results);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
		const bytes = await readFile(fullPath);
		results.push({ path: fullPath, contentHash: hashBytes(bytes) });
	}
}
