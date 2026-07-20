import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// First run needs the real E5 embedding + GLiNER PII ONNX models downloaded and initialized in
// the browser (packages/wasm-pipeline runs the full extract/chunk/embed/PII/redact pipeline for
// real — nothing here is mocked), which can take several minutes depending on network speed.
test.setTimeout(10 * 60_000);

const FIXTURE = path.join(__dirname, "fixtures", "contract-note.txt");
const PII_NAME = "John Smith";
const PII_EMAIL = "john.smith@example.com";
const PASSPHRASE = "correct horse battery staple";

test("upload -> PII masked -> passphrase reveal -> forget", async ({ page }) => {
	await page.goto("/");
	await page.waitForURL("**/onboarding");
	await page.getByRole("button", { name: "Enter workspace" }).click();
	await page.waitForURL("**/matters");

	// Create a matter
	const matterName = `E2E Matter ${Date.now()}`;
	await page.getByPlaceholder("New matter name").fill(matterName);
	await page.getByRole("button", { name: "Create" }).click();
	await page.getByText(matterName).click();
	await page.waitForURL("**/matters/*");

	// Create a folder (native prompt())
	page.once("dialog", (dialog) => dialog.accept("Discovery"));
	await page.getByRole("button", { name: "Create Folder" }).click();
	await page.getByText("Discovery").click();
	await page.waitForURL("**/folders/*");

	// Unlock the vault before uploading
	await page.getByPlaceholder(/passphrase/i).fill(PASSPHRASE);
	await page.getByRole("button", { name: "Unlock vault" }).click();

	// Upload the fixture and wait for ingestion to finish (real pipeline: extract, chunk, embed,
	// detect PII, redact, index, mirror — no mocking).
	await page.locator('input[type="file"]').setInputFiles(FIXTURE);
	await expect(page.getByText(/PII entities/)).toBeVisible({ timeout: 5 * 60_000 });
	await expect(page.getByText("Processing…")).not.toBeVisible();

	// The redacted text (visible in the dual-pane view once we open the document) must never
	// contain the raw PII — this is the core privacy guarantee the whole plan is built around.
	await page.getByText("contract-note.txt").click();
	await page.waitForURL("**/documents/*");

	const pageText = await page.locator("body").innerText();
	expect(pageText).not.toContain(PII_NAME);
	expect(pageText).not.toContain(PII_EMAIL);
	expect(pageText).toMatch(/\{\{[A-Z0-9_]+\}\}/); // a redaction token is present somewhere

	// Reveal one masked PII span with the correct passphrase
	await page.getByRole("tab", { name: "PII" }).click();
	await page.locator("span.font-mono", { hasText: /^\{\{/ }).first().click();
	await page.getByRole("button", { name: "Reveal" }).click();
	await page.getByPlaceholder("Passphrase").fill(PASSPHRASE);
	await page.getByRole("button", { name: "Reveal", exact: true }).last().click();
	await expect(page.getByText(new RegExp(`${PII_NAME}|${PII_EMAIL.replace(".", "\\.")}`))).toBeVisible({
		timeout: 10_000,
	});

	// Forget the matter and confirm it — and its documents — are gone
	await page.goBack();
	await page.goBack();
	await page.waitForURL("**/matters/*");
	await page.getByRole("button", { name: "Forget matter" }).click();
	await page.getByRole("button", { name: "Forget permanently" }).click();
	await page.waitForURL("**/matters");
	await expect(page.getByText(matterName)).not.toBeVisible();
});
