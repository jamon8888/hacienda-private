import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("C:\\Users\\NMarchitecte\\AppData\\Roaming\\npm\\node_modules\\playwright");

const __dirname = dirname(fileURLToPath(import.meta.url));

const LIBSQL_WEB =
  "https://cdn.jsdelivr.net/npm/@libsql/client@0.17.4/web/+esm";

const PORT = 8799;
const HOST = "127.0.0.1";

function startServer() {
  const http = require("node:http");
  const spikeTs = readFileSync(join(__dirname, "spike.test.ts"), "utf8");
  const transformed = spikeTs.replaceAll('"@libsql/client"', JSON.stringify(LIBSQL_WEB));

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(readFileSync(join(__dirname, "spike.html"), "utf8"));
      return;
    }
    if (url === "/spike.test.ts") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(transformed);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => server.listen(PORT, HOST, () => resolve(server)));
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      "C:\\Users\\NMarchitecte\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  const consoleLogs = [];
  page.on("console", (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLogs.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => consoleLogs.push(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) consoleLogs.push(`[http ${r.status()}] ${r.url()}`); });

  await page.goto(`http://${HOST}:${PORT}/`, { waitUntil: "load" });

  let result = null;
  try {
    await page.waitForFunction(() => window.__SPIKE_RESULT__ !== undefined, undefined, { timeout: 60000 });
    result = await page.evaluate(() => window.__SPIKE_RESULT__);
  } catch (e) {
    result = { fatal: `timeout/wait failed: ${e.message}`, console: consoleLogs };
  }

  await browser.close();
  server.close();

  const pass = result && result.vector === true && result.fts === true;
  console.log("=".repeat(60));
  console.log("B-GATE: " + (pass ? "PASS" : "FAIL"));
  console.log("=".repeat(60));
  console.log(JSON.stringify(result, null, 2));
  if (consoleLogs.length) {
    console.log("--- browser console ---");
    consoleLogs.forEach((l) => console.log(l));
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("runner error:", e);
  process.exit(2);
});
