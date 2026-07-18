import { test, expect } from "@playwright/test";
import { expectIsolated } from "./helpers";
import path from "node:path";

test("drop files, run pipeline, view extracted document", async ({ page }) => {
  await page.goto("/matters");
  const name = `matter-${Date.now()}`;
  await page.getByRole("button", { name: /new matter/i }).click();
  await page.getByPlaceholder(/matter name/i).fill(name);
  await page.getByRole("button", { name: /create/i }).click();
  await page.getByText(name).click();

  await expectIsolated(page);
  await page.setInputFiles('input[type="file"]', [path.join(__dirname, "fixtures/sample.txt")]);
  await page.getByRole("button", { name: /run pipeline/i }).click();
  await expect(page.getByText(/pages/i)).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: /view document/i }).first().click();
  await expect(page.getByText(/Extracted Text/)).toBeVisible();
});
