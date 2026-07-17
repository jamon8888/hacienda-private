import { test, expect } from "@playwright/test";
import { expectIsolated } from "./helpers";

test("redirects / to onboarding and enters workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/onboarding$/);
  await expectIsolated(page);
  await page.getByRole("button", { name: /enter workspace/i }).click();
  await expect(page).toHaveURL(/\/matters$/);
});
