import { test as base, expect, type Page } from "@playwright/test";

// Shared fixture for browser E2E specs. Navigates to the Vite harness page and
// waits until `window.XbergPipeline` (the full library) is attached, so specs
// can immediately call `page.evaluate(() => window.XbergPipeline.*)`.
export const test = base.extend<{ harness: Page }>({
  harness: async ({ page }, use) => {
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as { __xbergReady?: boolean }).__xbergReady === true);
    await use(page);
  },
});

export { expect };

// Type the library surface available on `window` inside `page.evaluate`.
// Kept structural (not importing the package) because evaluate runs in the browser.
declare global {
  interface Window {
    XbergPipeline: typeof import("../../src/index");
    __xbergReady: boolean;
  }
}
