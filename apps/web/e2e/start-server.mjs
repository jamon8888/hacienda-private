// Starts the real mcp-server (the same code the shipped CLI runs) pointed at this app's built
// static export, on a fixed port Playwright's webServer config polls. A fresh temp data dir keeps
// each e2e run's matters/documents/models isolated from any real user data and from other runs.
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.XBERG_WEB_APP_DIR = resolve(__dirname, "../out");

const { buildConfig, parseArgs } = await import("../../../services/mcp-server/src/config.ts");
const { createAppContext, createHttpServer } = await import("../../../services/mcp-server/src/index.ts");

const PORT = 8799;
const dataDir = mkdtempSync(join(tmpdir(), "xberg-e2e-"));

// modelCacheDir is always dataDir/models (config.ts), but dataDir is fresh per run — without this,
// every run re-downloads the ~900MB e5 + GLiNER models from the network, which alone can blow past
// the test's timeout. Symlink to a fixed, run-independent cache dir so models download once.
const modelCache = join(tmpdir(), "xberg-e2e-model-cache");
mkdirSync(modelCache, { recursive: true });
symlinkSync(modelCache, join(dataDir, "models"));
const config = buildConfig(parseArgs(["node", "xberg-mcp", "serve", "--port", String(PORT), "--data-dir", dataDir]));
const ctx = createAppContext(config);
const server = createHttpServer(ctx);

server.listen(PORT, "127.0.0.1", () => {
	// eslint-disable-next-line no-console
	console.log(`e2e mcp-server listening on http://127.0.0.1:${PORT} (data dir: ${dataDir})`);
});
