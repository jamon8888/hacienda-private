import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// First run needs the real E5 embedding + GLiNER PII ONNX models downloaded and initialized in
// the browser (packages/wasm-pipeline runs the full extract/chunk/embed/PII/redact pipeline for
// real — nothing here is mocked), which can take several minutes depending on network speed.
test.setTimeout(10 * 60_000);

const FIXTURE = path.join(__dirname, "fixtures", "contract-note.csv");
const FIXTURE_2 = path.join(__dirname, "fixtures", "contract-note-2.csv");
const PII_NAME = "John Smith";
const PII_EMAIL = "john.smith@example.com";
const PII_NAME_2 = "Mary Jones";
const PASSPHRASE = "correct horse battery staple";

test("upload -> PII masked -> passphrase reveal -> forget", async ({ page }) => {
	page.on("console", (msg) => {
		if (msg.text().startsWith("DEBUG2")) console.log(msg.text());
	});
	await page.goto("/");
	await page.waitForURL("**/onboarding");
	await page.getByRole("button", { name: "Enter workspace" }).click();
	await page.waitForURL("**/matters");

	// Scope content locators to the routed page's own <main> — the sidebar (matter-nav) renders
	// the same matter/folder names and races the content area's fetch, so bare getByText() is
	// ambiguous as soon as the sidebar catches up.
	const content = page.locator("main.mx-auto");

	// Create a matter
	const matterName = `E2E Matter ${Date.now()}`;
	await page.getByPlaceholder("New matter name").fill(matterName);
	await page.getByRole("button", { name: "Create" }).click();
	await content.getByText(matterName).click();
	await page.waitForURL("**/matters/*");

	// Create a folder (native prompt())
	page.once("dialog", (dialog) => dialog.accept("Discovery"));
	await page.getByRole("button", { name: "Create Folder" }).click();
	await content.getByText("Discovery").click();
	await page.waitForURL("**/folders/*");

	// Unlock the vault before uploading
	await page.getByPlaceholder(/passphrase/i).fill(PASSPHRASE);
	await page.getByRole("button", { name: "Unlock vault" }).click();

	// Upload the fixture and wait for ingestion to finish (real pipeline: extract, chunk, embed,
	// detect PII, redact, index, mirror — no mocking).
	await page.locator('input[type="file"]').setInputFiles(FIXTURE);
	await expect(page.getByText(/PII entities/)).toBeVisible({ timeout: 5 * 60_000 });
	await expect(page.getByText("Processing…")).not.toBeVisible();

	// Upload a second file into the SAME folder — the mirror must merge into the matter's
	// cumulative state, not overwrite it (regression coverage for the multi-file upload bug).
	// Scoped to the "Ingested documents" list specifically — the filename also renders in the
	// FileDropzone's own upload preview and the transient upload-progress row, all within the same
	// <main>, so an unscoped getByText() is ambiguous (Playwright strict-mode violation) as soon
	// as the doc reaches this final list.
	const ingestedDocs = content.locator("div.mt-6.grid.gap-3");
	await page.locator('input[type="file"]').setInputFiles(FIXTURE_2);
	await expect(ingestedDocs.getByText(/contract-note-2\.csv/)).toBeVisible({ timeout: 5 * 60_000 });
	await expect(page.getByText("Processing…")).not.toBeVisible();

	// The redacted text (visible in the dual-pane view once we open the document) must never
	// contain the raw PII — this is the core privacy guarantee the whole plan is built around.
	// Documents are only reachable via the sidebar (matter-nav) — FolderView's own document
	// cards aren't links.
	const nav = page.getByRole("navigation", { name: "Workspace navigation" });
	await nav.getByRole("button", { name: "Discovery" }).click();

	// Both documents remain reachable after the second upload committed — proves the first
	// upload's chunks/PII survived the second ingest's mirror push.
	await expect(nav.getByRole("button", { name: /contract-note\.csv/ })).toBeVisible();
	await expect(nav.getByRole("button", { name: /contract-note-2\.csv/ })).toBeVisible();

	await nav.getByRole("button", { name: /contract-note\.csv/ }).click();
	await page.waitForURL("**/documents/*");
	// waitForURL only confirms navigation — DocumentView still has to await getDocument() +
	// getOriginalFile() and render the dual-pane view before the redacted text is on the page.
	await expect(page.getByRole("tab", { name: "PII" })).toBeVisible();

	const pageText = await page.locator("body").innerText();
	expect(pageText).not.toContain(PII_NAME);
	expect(pageText).not.toContain(PII_EMAIL);
	expect(pageText).toMatch(/\{\{[A-Z0-9_]+\}\}/); // a redaction token is present somewhere

	// Open the second document and confirm its own PII was independently redacted too — proves the
	// matter's cumulative mirror carries both documents' PII, not just whichever was uploaded last.
	await page.goBack();
	await page.waitForURL("**/folders/*");
	await nav.getByRole("button", { name: /contract-note-2\.csv/ }).click();
	await page.waitForURL("**/documents/*");
	await expect(page.getByRole("tab", { name: "PII" })).toBeVisible();
	const pageText2 = await page.locator("body").innerText();
	expect(pageText2).not.toContain(PII_NAME_2);
	expect(pageText2).toMatch(/\{\{[A-Z0-9_]+\}\}/);

	// Back to the first document to continue the reveal/forget flow below.
	await page.goBack();
	await page.waitForURL("**/folders/*");
	await nav.getByRole("button", { name: /contract-note\.csv/ }).click();
	await page.waitForURL("**/documents/*");
	await expect(page.getByRole("tab", { name: "PII" })).toBeVisible();

	// Reveal one masked PII span with the correct passphrase
	await page.getByRole("tab", { name: "PII" }).click();
	await page.locator("span.font-mono", { hasText: /^\{\{/ }).first().click();
	await page.getByRole("button", { name: "Reveal" }).click();
	await page.getByPlaceholder("Passphrase").fill(PASSPHRASE);
	await page.getByRole("button", { name: "Reveal", exact: true }).last().click();
	// Scoped to the reveal dialog — the same revealed value also renders in the grid cell
	// preview and the popover trigger span, which would make an unscoped locator ambiguous.
	await expect(
		page.getByRole("dialog").getByText(new RegExp(`${PII_NAME}|${PII_EMAIL.replace(".", "\\.")}`)),
	).toBeVisible({
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
