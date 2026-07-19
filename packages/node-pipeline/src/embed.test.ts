// packages/node-pipeline/src/embed.test.ts
import { describe, expect, it } from "vitest";
import { embedText } from "./embed.js";

describe.skip("embedText (real model — run manually, needs network)", () => {
	it("returns a 768-dim vector", async () => {
		const vec = await embedText(
			"hello world",
			process.env.E5_MODEL_PATH ?? "",
			process.env.E5_TOKENIZER_PATH ?? "",
		);
		expect(vec).toHaveLength(768);
	});
});

describe("embedText input validation", () => {
	it("rejects empty text without loading a model", async () => {
		await expect(embedText("", "unused", "unused")).rejects.toThrow(/empty/i);
	});
});
