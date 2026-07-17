import { test, expect } from "@playwright/test";

test("create a matter and see it persist", async ({ page }) => {
  await page.goto("/matters");
  const name = `matter-${Date.now()}`;
  await page.getByRole("button", { name: /new matter/i }).click();
  await page.getByPlaceholder(/matter name/i).fill(name);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page.getByText(name)).toBeVisible();
});
