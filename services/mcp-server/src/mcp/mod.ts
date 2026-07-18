import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AppContext } from "../index.js";
import { registerTools } from "./tools.js";

export function createMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: "@xberg-io/mcp-server", version: "1.0.0-rc.27" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, ctx);
  return server;
}

export async function runMcp(ctx: AppContext): Promise<void> {
  const server = createMcpServer(ctx);
  // TODO(http): the SDK exposes StreamableHTTPServerTransport for `mcp --http`, but it requires an
  // HTTP framework/session wiring beyond this plan's scope. Only stdio is implemented here.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[xberg-mcp] MCP server ready (stdio; data dir ${ctx.config.dataDir})`);
}
