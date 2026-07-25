import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

interface NativeVectorReport {
	id: string;
	language: string;
	vector: number[];
}

interface NativeReport {
	identity: string;
	dimension: number;
	query: { text: string; vector: number[] };
	documents: NativeVectorReport[];
}

interface BrowserResourceReport {
	name: string;
	duration: number;
	transferSize?: number;
	encodedBodySize?: number;
}

interface BrowserVectorReport {
	id: string;
	language: string;
	vector: number[];
}

interface BrowserReport {
	identity: string;
	dimension: number;
	query: { text: string; vector: number[] };
	documents: BrowserVectorReport[];
	firstLoadMs: number;
	batchEmbedMs: number;
	totalMs: number;
	heapBeforeBytes: number | null;
	heapAfterWarmupBytes: number | null;
	heapAfterBatchBytes: number | null;
	peakHeapBytes: number | null;
	resources: BrowserResourceReport[];
}

const FIRST_LOAD_BUDGET_MS = 480_000;
const BATCH_EMBED_BUDGET_MS = 20_000;
const PEAK_HEAP_BUDGET_BYTES = 1_250_000_000;
const VECTOR_DELTA_EPSILON = 1e-4;
const STATUS_TIMEOUT_MS = FIRST_LOAD_BUDGET_MS + BATCH_EMBED_BUDGET_MS + 60_000;

function maxAbsDelta(left: number[], right: number[]): number {
	let max = 0;
	for (let index = 0; index < left.length; index++) {
		const delta = Math.abs((left[index] ?? 0) - (right[index] ?? 0));
		if (delta > max) max = delta;
	}
	return max;
}

test.setTimeout(15 * 60_000);

test("Granite release harness verifies parity, performance, and local artifact delivery", async ({ page }) => {
	const nativePath = process.env["GRANITE_NATIVE_REPORT"];
	expect(nativePath, "GRANITE_NATIVE_REPORT must point at the native release JSON").toBeTruthy();
	const native = JSON.parse(readFileSync(nativePath!, "utf8")) as NativeReport;

	await page.goto("/release/granite?autorun=1");
	await expect(page.getByTestId("granite-release-status")).toHaveText("Status: done", { timeout: STATUS_TIMEOUT_MS });
	const browser = JSON.parse(await page.getByTestId("granite-release-report").innerText()) as BrowserReport;

	expect(browser.identity).toBe(native.identity);
	expect(browser.dimension).toBe(native.dimension);
	expect(browser.query.text).toBe(native.query.text);
	expect(browser.documents).toHaveLength(native.documents.length);

	const queryDelta = maxAbsDelta(browser.query.vector, native.query.vector);
	expect(queryDelta).toBeLessThanOrEqual(VECTOR_DELTA_EPSILON);

	for (const nativeDocument of native.documents) {
		const browserDocument = browser.documents.find((document) => document.id === nativeDocument.id);
		expect(browserDocument, `missing browser vector for ${nativeDocument.id}`).toBeTruthy();
		expect(browserDocument?.language).toBe(nativeDocument.language);
		const delta = maxAbsDelta(browserDocument?.vector ?? [], nativeDocument.vector);
		expect(delta, `vector mismatch for ${nativeDocument.id}`).toBeLessThanOrEqual(VECTOR_DELTA_EPSILON);
	}

	expect(browser.firstLoadMs).toBeLessThanOrEqual(FIRST_LOAD_BUDGET_MS);
	expect(browser.batchEmbedMs).toBeLessThanOrEqual(BATCH_EMBED_BUDGET_MS);
	expect(browser.resources).toHaveLength(3);
	for (const resource of browser.resources) {
		expect(resource.name).toContain("/models/granite/granite-embedding-97m-multilingual-r2/");
		expect(resource.name).toContain("127.0.0.1:8799");
		expect(resource.name).not.toContain("huggingface.co");
		expect(resource.name).not.toContain("jsdelivr");
		expect((resource.transferSize ?? 0) > 0 || (resource.encodedBodySize ?? 0) > 0).toBe(true);
	}

	expect(browser.heapAfterWarmupBytes).not.toBeNull();
	expect(browser.heapAfterBatchBytes).not.toBeNull();
	expect(browser.peakHeapBytes).not.toBeNull();
	expect(browser.peakHeapBytes ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(PEAK_HEAP_BUDGET_BYTES);

	const reportPath = process.env["GRANITE_BROWSER_REPORT"];
	if (reportPath) {
		writeFileSync(reportPath, JSON.stringify(browser, null, 2));
	}
});
