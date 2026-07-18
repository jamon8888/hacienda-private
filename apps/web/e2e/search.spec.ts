import { test, expect } from "@playwright/test";

test("RAG search returns cited chunks", async ({ page }) => {
  await page.goto("/search?matter_id=matter-latest");
  await page.getByPlaceholder(/ask a question/i).fill("What is the invoice number?");
  await page.getByRole("button", { name: /search/i }).click();
  await expect(page.getByTestId("retrieved-chunk").first()).toBeVisible({ timeout: 180_000 });
});
