import { get, set, del } from "idb-keyval";

// Per-matter extraction template: which PII kinds this matter's reviewers care about. Client-only
// (mirrors the file-store.ts pattern) — v1 only filters/highlights the PII and review panels, it
// does not alter the extraction engine itself.
function keyFor(matterId: string): string {
	return `xberg:matter-template:${matterId}`;
}

export async function saveMatterTemplate(matterId: string, selectedKinds: string[]): Promise<void> {
	await set(keyFor(matterId), selectedKinds);
}

export async function getMatterTemplate(matterId: string): Promise<string[] | undefined> {
	return get(keyFor(matterId));
}

export async function deleteMatterTemplate(matterId: string): Promise<void> {
	await del(keyFor(matterId));
}
