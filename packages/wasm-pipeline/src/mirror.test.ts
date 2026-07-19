import { describe, it, expect, vi } from "vitest";
import { serializeMirror, serializeMirrorToBytes, pushMirror } from "./mirror";
import { API_BASE } from "./constants";

describe("serializeMirror", () => {
	it("bundles index and vault into a versioned structure", () => {
		const index = new Uint8Array([1, 2, 3, 4]);
		const vault = new Uint8Array([9, 8, 7]);
		const bundle = serializeMirror(index, vault);
		expect(bundle.version).toBe(1);
		expect(bundle.index).toEqual([1, 2, 3, 4]);
		expect(bundle.vault).toEqual([9, 8, 7]);
	});

	it("serializes to JSON bytes carrying both index and vault", () => {
		const bytes = serializeMirrorToBytes(new Uint8Array([1, 2]), new Uint8Array([7]));
		const parsed = JSON.parse(new TextDecoder().decode(bytes));
		expect(parsed).toEqual({ version: 1, index: [1, 2], vault: [7], pii: [], chunks: [] });
	});
});

describe("pushMirror", () => {
	it("posts raw bundled body to /rag/mirror?matter_id=<id>", async () => {
		const index = new Uint8Array([1, 2, 3]);
		const vault = new Uint8Array([9]);
		const payload = serializeMirrorToBytes(index, vault);
		const matter = { id: "matter-42" } as never;
		let capturedUrl = "";
		let capturedBody: Uint8Array = new Uint8Array(0);
		let capturedContentType = "";
		let capturedAuth = "";

		vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedBody = (init?.body as unknown as Uint8Array) ?? new Uint8Array(0);
			const headers = init?.headers as Record<string, string | undefined>;
			capturedContentType = headers["content-type"] ?? "";
			capturedAuth = headers["authorization"] ?? "";
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch);

		await pushMirror(matter, payload, "tok");

		expect(capturedUrl).toBe(`${API_BASE}/rag/mirror?matter_id=matter-42`);
		expect(capturedContentType).toBe("application/octet-stream");
		expect(capturedAuth).toBe("Bearer tok");
		const parsed = JSON.parse(new TextDecoder().decode(capturedBody));
		expect(parsed).toEqual({ version: 1, index: [1, 2, 3], vault: [9], pii: [], chunks: [] });

		vi.unstubAllGlobals();
	});

	it("throws on non-ok response", async () => {
		const matter = { id: "m-1" } as never;
		const payload = serializeMirrorToBytes(new Uint8Array([1]), new Uint8Array([2]));
		vi.stubGlobal("fetch", (async () => new Response(null, { status: 500 })) as unknown as typeof fetch);
		await expect(pushMirror(matter, payload, "tok")).rejects.toThrow("mirror failed: 500");
		vi.unstubAllGlobals();
	});
});
