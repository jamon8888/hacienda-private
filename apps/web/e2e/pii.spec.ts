import { test, expect } from "@playwright/test";

test("PII panel shows token spans, not plaintext", async ({ page }) => {
  await page.goto("/documents/sample.txt?matter_id=matter-latest");
  const pii = page.getByTestId("pii-panel");
  await expect(pii).toBeVisible();
  await expect(pii.getByText(/EMAIL|PHONE|PERSON/i)).toBeVisible();
});
