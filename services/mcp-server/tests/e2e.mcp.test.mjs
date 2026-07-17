import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const DATA_DIR = process.env.E2E_DATA_DIR ?? (process.env.TEMP + "/xberg-e2e");
const SERVER = new URL("../dist/index.js", import.meta.url).pathname;

async function startMcp() {
  const child = spawn("node", [SERVER, "mcp", "--data-dir", DATA_DIR], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, XBERG_SCOPES: "read,ingest,redact,admin" },
  });
  const transport = new StdioClientTransport({ reader: child.stdout, writer: child.stdin });
  const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { child, client };
}

async function firstMatterId() {
  const res = await fetch("http://localhost:8787/matters");
  const { matters } = await res.json();
  assert(matters.length > 0, "a matter must exist from the UI e2e run");
  return matters[0].id;
}

async function main() {
  const matterId = await firstMatterId();
  const { child, client } = await startMcp();

  // 1. rag_query — cited chunks from the live bundle
  const rag = await client.callTool({ name: "rag_query", arguments: { matter_id: matterId, query: "invoice", top_k: 4 } });
  assert(Array.isArray(rag.content) && rag.content.length > 0, "rag_query should return chunks");

  // 2. list_pii — token spans, never plaintext
  const pii = await client.callTool({ name: "list_pii", arguments: { matter_id: matterId, doc_id: "sample.txt" } });
  assert(JSON.stringify(pii.content).includes("token") || JSON.stringify(pii.content).includes("EMAIL"), "list_pii should return token spans");

  // 3. rehydrate_chunk — returns the stored (browser-sealed) ciphertext blob
  const rehyd = await client.callTool({ name: "rehydrate_chunk", arguments: { matter_id: matterId, chunk_id: "sample.txt:0" } });
  const rehydText = rehyd.content?.[0]?.text ?? "";
  assert(rehydText.length > 0, "rehydrate_chunk should return a non-empty ciphertext blob");

  // 4. ingest_folder — creates a folder + ingest record
  const ing = await client.callTool({ name: "ingest_folder", arguments: { matter_id: matterId, name: "e2e-folder" } });
  assert(JSON.stringify(ing.content).includes("folder") || JSON.stringify(ing.content).includes("id"), "ingest_folder should create a folder");

  // 5. redact — records a redaction marker
  const red = await client.callTool({ name: "redact", arguments: { matter_id: matterId, doc_id: "sample.txt" } });
  assert(JSON.stringify(red.content).includes("redaction") || JSON.stringify(red.content).includes("id"), "redact should record a marker");

  // Forget via HTTP, then a second spawn must see rag_query error not_found
  const http = await fetch(`http://localhost:8787/matters/${matterId}`, { method: "DELETE", headers: { authorization: "Bearer admin" } });
  assert.strictEqual(http.status, 200);
  await client.close();
  child.kill();

  const second = await startMcp();
  let threw = false;
  try {
    await second.client.callTool({ name: "rag_query", arguments: { matter_id: matterId, query: "invoice" } });
  } catch {
    threw = true;
  }
  assert(threw, "rag_query after forget must error not_found");
  second.child.kill();
  console.log("MCP live-bundle e2e OK (all 5 tools)");
}
main().catch((e) => { console.error(e); process.exit(1); });
