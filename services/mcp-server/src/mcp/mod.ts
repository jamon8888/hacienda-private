import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AppContext } from "../index.js";
import type { Principal } from "../principal.js";
import { registerTools } from "./tools.js";

export function createMcpServer(ctx: AppContext, principal: Principal): McpServer {
  const server = new McpServer(
    { name: "@xberg-io/mcp-server", version: "1.0.0-rc.27" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, ctx, principal);
  return server;
}

export async function runMcp(ctx: AppContext, principal: Principal): Promise<void> {
  const server = createMcpServer(ctx, principal);
  // TODO(http): the SDK exposes StreamableHTTPServerTransport for `mcp --http`, but it requires an
  // HTTP framework/session wiring beyond this plan's scope. Only stdio is implemented here.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Single-owner model: the process spawn by the owner's client is the auth boundary; every tool
  // call runs as this principal (subject="owner").
  console.error(
    `[xberg-mcp] MCP server ready as subject="${principal.subject}" ` +
      `(scopes: ${principal.scopes.join(",")}); stdio; data dir ${ctx.config.dataDir}`,
  );
}
