import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AppContext } from "../index.js";

const NOT_IMPLEMENTED =
  "Tool bodies are implemented in Plan 4. The Node service holds light metadata + the mirrored " +
  "EdgeVec index; it runs no engine. This stub returns the contract shape only.";

const TOOLS: Tool[] = [
  {
    name: "rag_query",
    description: "Hybrid retrieval over the mirrored (matter-scoped) EdgeVec index; returns redacted chunks + citations. Gated by `read` scope + consent + matter scope.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: { type: "string" },
        query: { type: "string" },
        top_k: { type: "number" },
      },
      required: ["matter_id", "query"],
    },
  },
  {
    name: "list_pii",
    description: "PII tags (kind + token, not values) for a document from the mirror metadata. Gated by `read` scope + matter scope.",
    inputSchema: {
      type: "object",
      properties: { matter_id: { type: "string" }, doc_id: { type: "string" } },
      required: ["matter_id", "doc_id"],
    },
  },
  {
    name: "rehydrate_chunk",
    description: "Consent-gated decrypt of a chunk's ciphertext via the Node AES-GCM vault; owner-only. Gated by `redact`/`raw` consent + live approval + vault key.",
    inputSchema: {
      type: "object",
      properties: { matter_id: { type: "string" }, chunk_id: { type: "string" } },
      required: ["matter_id", "chunk_id"],
    },
  },
  {
    name: "ingest_folder",
    description: "Record folder metadata (browser already ran extract/embed/index on-device). Gated by `ingest` scope + matter scope.",
    inputSchema: {
      type: "object",
      properties: { matter_id: { type: "string" }, name: { type: "string" }, path: { type: "string" } },
      required: ["matter_id", "name"],
    },
  },
  {
    name: "redact",
    description: "Record a redaction marker (browser applied curtain tokens on-device). Gated by `redact` scope + human-in-the-loop confirmation.",
    inputSchema: {
      type: "object",
      properties: { matter_id: { type: "string" }, doc_id: { type: "string" } },
      required: ["matter_id", "doc_id"],
    },
  },
];

function stubContent(toolName: string): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text",
        text: `[${toolName}] ${NOT_IMPLEMENTED}`,
      },
    ],
  };
}

export async function runMcp(ctx: AppContext): Promise<void> {
  const server = new Server(
    { name: "@xberg-io/mcp-server", version: "1.0.0-rc.27" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const known = TOOLS.find((t) => t.name === name);
    if (!known) {
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    return stubContent(name);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[xberg-mcp] MCP server ready (stub tools; ctx data dir ${ctx.config.dataDir})`);
}
