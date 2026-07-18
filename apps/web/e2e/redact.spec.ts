import { test, expect } from "@playwright/test";

test("seal vault and redact a chunk", async ({ page }) => {
  await page.goto("/documents/sample.txt?matter_id=matter-latest");
  await page
    .getByRole("button", { name: /redact/i })
    .first()
    .click();
  await expect(page.getByText(/redacted/i)).toBeVisible();
});
