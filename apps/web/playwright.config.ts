import { defineConfig } from "@playwright/test";

const PORT = 8799;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: "./e2e",
	// This volume is exFAT — macOS scatters AppleDouble resource-fork files (`._*`) everywhere,
	// including `._critical-path.spec.ts` next to real test files; without this they get matched
	// as test files themselves and fail to parse.
	testIgnore: ["**/._*"],
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: "list",
	timeout: 120_000,
	use: {
		baseURL,
		trace: "retain-on-failure",
	},
	webServer: {
		// tsx runs start-server.mjs's TS imports (services/mcp-server/src/*.ts) directly, the same
		// way the mcp-server's own "start" script does — no separate build step needed.
		command: "../../node_modules/.bin/tsx e2e/start-server.mjs",
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
		stdout: "pipe",
		stderr: "pipe",
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
