import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { JupiterPerpsCopilotTools } from "./tools/index.js";
import { createHttpServer } from "./http-server.js";
import { JUPITER_PERPS_PLUGIN_CONTRACT } from "./plugin/manifest.js";
import dotenv from "dotenv";

dotenv.config();

/**
 * Registers all Jupiter Perps Copilot tools with an MCP Server instance
 */
export function registerMcpHandlers(server: Server, copilot: JupiterPerpsCopilotTools) {
  // Register tools list from the official plugin contract
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: JUPITER_PERPS_PLUGIN_CONTRACT.tools.map((t) => ({
        name: t.id,
        description: t.description,
        inputSchema: t.input_schema,
      })),
    };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: any;
      switch (name) {
        case "jup_perps_get_markets":
          result = await copilot.getMarkets();
          break;
        case "jup_perps_get_quote":
          result = await copilot.getQuote(args as any);
          break;
        case "jup_perps_get_positions":
          result = await copilot.getPositions((args as any) || {});
          break;
        case "jup_perps_open_position":
          result = await copilot.openPosition(args as any);
          break;
        case "jup_perps_close_position":
          result = await copilot.closePosition(args as any);
          break;
        case "jup_perps_simulate_onchain_tx":
          result = await copilot.simulateOnChainTx(args as any);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: result,
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error executing ${name}: ${error.message || String(error)}`,
          },
        ],
      };
    }
  });
}

/**
 * Creates and initializes an MCP Server instance
 */
export function createMcpServer(copilot: JupiterPerpsCopilotTools): Server {
  const server = new Server(
    {
      name: "paybox-jupiter-perps",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerMcpHandlers(server, copilot);
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const copilot = new JupiterPerpsCopilotTools();

  // If --stdio flag is passed, run in Stdio transport mode (e.g. for Claude Desktop)
  if (args.includes("--stdio")) {
    const server = createMcpServer(copilot);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 PayBox Jupiter Perps Copilot MCP Server running on stdio");
    return;
  }

  // Default: Start multi-agent HTTP Server (ChatGPT Actions, MCP SSE, x402, PayBox marketplace)
  const port = parseInt(process.env.PORT || "3000", 10);
  const app = createHttpServer(copilot, port);

  app.listen(port, () => {
    console.log("==================================================================");
    console.log(" 🪐 PAYBOX JUPITER PERPS COPILOT - PLUGIN SERVER RUNNING");
    console.log("==================================================================");
    console.log(`🌐 Dashboard & Test UI:       http://localhost:${port}`);
    console.log(`🤖 ChatGPT Custom GPT Action: http://localhost:${port}/openapi.json`);
    console.log(`⚡ Remote MCP SSE Endpoint:   http://localhost:${port}/sse`);
    console.log(`⚡ Streamable HTTP MCP:       http://localhost:${port}/mcp`);
    console.log(`🏪 PayBox Plugin Contract:   http://localhost:${port}/contract.json`);
    console.log(`📦 Marketplace Manifest:      http://localhost:${port}/paybox-plugin.json`);
    console.log(`💳 x402 Micropayment Quote:   POST http://localhost:${port}/x402/quote`);
    console.log(`💳 x402 Micropayment Trade:   POST http://localhost:${port}/x402/trade`);
    console.log("==================================================================");
    console.log("💡 For Claude Desktop stdio mode, run: npm run start:stdio");
    console.log("==================================================================");
  });
}

// Auto-run if entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal server error:", err);
    process.exit(1);
  });
}
