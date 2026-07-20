import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const PKG = resolve(process.cwd(), "node_modules/@tursodatabase/database-wasm");
const BUNDLE = join(PKG, "bundle", "main.es.js");
const HTML = resolve(process.cwd(), "src/search/spike.html");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
};

const server = createServer((req, res) => {
  // COOP/COEP required for SharedArrayBuffer used by the wasm worker.
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  let urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/vendor/database-wasm-bundle.js") {
    if (!existsSync(BUNDLE)) {
      res.statusCode = 500;
      res.end("bundle missing: " + BUNDLE);
      return;
    }
    res.setHeader("Content-Type", MIME[".js"]);
    res.end(readFileSync(BUNDLE));
    return;
  }
  if (urlPath === "/" || urlPath === "/spike.html") {
    res.setHeader("Content-Type", MIME[".html"]);
    res.end(readFileSync(HTML));
    return;
  }
  res.statusCode = 404;
  res.end("not found: " + urlPath);
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/spike.html`;

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

let outcome = "UNKNOWN";
try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__RESULT__ !== undefined, {
    timeout: 90000,
  });
  const result = await page.evaluate(() => window.__RESULT__);
  const pass = result.vector && result.fts;
  outcome = pass ? "PASS" : "FAIL";
  console.log(`B-GATE: ${outcome}`);
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.thrown) {
    console.log("--- page console (last 20) ---");
    console.log(logs.slice(-20).join("\n"));
  }
} catch (e) {
  outcome = "FAIL";
  console.log("B-GATE: FAIL (harness error)");
  console.log(String(e));
  console.log("--- page console ---");
  console.log(logs.join("\n"));
} finally {
  await browser.close();
  server.close();
}

process.exit(outcome === "PASS" ? 0 : 1);
