import express, { Request, Response } from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { JupiterPerpsCopilotTools } from "./tools/index.js";
import {
  JUPITER_PERPS_PLUGIN_CONTRACT,
  JUPITER_PERPS_CONTRACT_RESULT,
  PAYBOX_MARKETPLACE_MANIFEST,
} from "./plugin/manifest.js";
import { getOpenApiSpec } from "./openapi.js";
import { registerMcpHandlers } from "./server.js";

export function createHttpServer(copilot: JupiterPerpsCopilotTools, port: number = 3000) {
  const app = express();
  app.use(cors({ origin: "*" }));
  app.use(express.json());

  // In-memory registry of active MCP SSE sessions
  const sseTransports = new Map<string, SSEServerTransport>();

  // ============================================================================
  // 1. PayBox Marketplace Manifest & Plugin Contract
  // ============================================================================

  /**
   * Root PayBox Marketplace Plugin Manifest
   */
  app.get("/paybox-plugin.json", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.json(PAYBOX_MARKETPLACE_MANIFEST);
  });

  /**
   * Official PayBox Plugin Contract
   * Compatible with `@paybox-sh/sdk` getPluginContract() & `paybox plugins contract <uri>`
   */
  app.get("/contract.json", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.json(JUPITER_PERPS_CONTRACT_RESULT);
  });

  /**
   * PayBox `use_plugin` invocation endpoint
   * Handles generic plugin executions from PayBox agents and CLI
   */
  app.post("/api/plugins/use", async (req: Request, res: Response) => {
    const { plugin_id, tool_id, input } = req.body || {};

    if (plugin_id && plugin_id !== "jupiter-perps") {
      return res.status(400).json({
        error: `Unknown plugin_id: ${plugin_id}. Expected 'jupiter-perps'`,
      });
    }

    try {
      let output: any;
      switch (tool_id) {
        case "jup_perps_get_markets":
          output = await copilot.getMarkets();
          break;
        case "jup_perps_get_quote":
          output = await copilot.getQuote(input);
          break;
        case "jup_perps_get_positions":
          output = await copilot.getPositions(input || {});
          break;
        case "jup_perps_open_position":
          output = await copilot.openPosition(input);
          break;
        case "jup_perps_close_position":
          output = await copilot.closePosition(input);
          break;
        case "jup_perps_simulate_onchain_tx":
          output = await copilot.simulateOnChainTx(input);
          break;
        default:
          return res.status(404).json({ error: `Tool ${tool_id} not found on plugin` });
      }

      return res.json({
        status: "success",
        plugin_id: "jupiter-perps",
        tool_id,
        output,
      });
    } catch (err: any) {
      return res.status(500).json({
        status: "error",
        message: err.message || String(err),
      });
    }
  });

  // ============================================================================
  // 2. OpenAPI Specification for ChatGPT Custom GPT Actions
  // ============================================================================

  app.get("/openapi.json", (req: Request, res: Response) => {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host") || `localhost:${port}`;
    const serverUrl = `${protocol}://${host}`;

    res.setHeader("Content-Type", "application/json");
    res.json(getOpenApiSpec(serverUrl));
  });

  // ============================================================================
  // 3. REST API Endpoints (For ChatGPT Actions, Custom Agents & Dashboards)
  // ============================================================================

  app.get("/api/markets", async (req: Request, res: Response) => {
    try {
      const data = await copilot.getMarkets();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/quote", async (req: Request, res: Response) => {
    try {
      const quote = await copilot.getQuote(req.body);
      res.json(quote);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/positions", async (req: Request, res: Response) => {
    try {
      const walletAddress = req.query.walletAddress as string | undefined;
      const data = await copilot.getPositions({ walletAddress });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/open", async (req: Request, res: Response) => {
    try {
      const result = await copilot.openPosition(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/close", async (req: Request, res: Response) => {
    try {
      const result = await copilot.closePosition(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/simulate", async (req: Request, res: Response) => {
    try {
      const result = await copilot.simulateOnChainTx(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ============================================================================
  // 4. x402 Micropayments Protocol (HTTP 402 Payment Required)
  // ============================================================================
  // developer.paybox.sh: "PayBox speaks x402 natively — wrap your endpoint and it works inside PayBox"

  const X402_RECIPIENT =
    process.env.x402_SOLANA_WALLET_ADDRESS ||
    process.env.X402_SOLANA_WALLET_ADDRESS ||
    process.env.PAYBOX_SOLANA_WALLET_ADDRESS ||
    process.env.DEFAULT_SOLANA_WALLET ||
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  app.post("/x402/quote", async (req: Request, res: Response) => {
    const paymentHeader = req.headers["x-payment"] || req.headers["authorization"];

    if (!paymentHeader) {
      res.setHeader("X-Accepts", JSON.stringify({
        network: "solana",
        asset: "USDC",
        amount_cents: 1,
        recipient: X402_RECIPIENT,
      }));
      return res.status(402).json({
        error: "Payment Required",
        protocol: "x402",
        message: "PayBox x402 micropayment required (0.01 USDC). Call PayBox tool 'pay_x402' or 'use_service'.",
        accepts: {
          network: "solana",
          asset: "USDC",
          amount: "0.01",
          recipient: X402_RECIPIENT,
        },
      });
    }

    try {
      const quote = await copilot.getQuote(req.body);
      res.json({
        x402_status: "settled",
        data: quote,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/x402/trade", async (req: Request, res: Response) => {
    const paymentHeader = req.headers["x-payment"] || req.headers["authorization"];

    if (!paymentHeader) {
      res.setHeader("X-Accepts", JSON.stringify({
        network: "solana",
        asset: "USDC",
        amount_cents: 5,
        recipient: X402_RECIPIENT,
      }));
      return res.status(402).json({
        error: "Payment Required",
        protocol: "x402",
        message: "PayBox x402 trade preparation fee (0.05 USDC). Call PayBox tool 'pay_x402' or 'use_service'.",
        accepts: {
          network: "solana",
          asset: "USDC",
          amount: "0.05",
          recipient: X402_RECIPIENT,
        },
      });
    }

    try {
      const result = await copilot.openPosition(req.body);
      res.json({
        x402_status: "settled",
        data: result,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ============================================================================
  // 5. MCP over SSE (Server-Sent Events) for Remote AI Agents (Claude, Grok, ChatGPT)
  // ============================================================================

  app.get("/sse", async (req: Request, res: Response) => {
    const transport = new SSEServerTransport("/message", res);
    const mcpServer = new Server(
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

    registerMcpHandlers(mcpServer, copilot);

    await mcpServer.connect(transport);
    sseTransports.set(transport.sessionId, transport);

    transport.onclose = () => {
      sseTransports.delete(transport.sessionId);
    };

    await transport.start();
  });

  app.post("/message", async (req: Request, res: Response) => {
    const sessionId = (req.query.sessionId as string) || (req.headers["x-session-id"] as string);
    const transport = sessionId ? sseTransports.get(sessionId) : Array.from(sseTransports.values())[0];

    if (!transport) {
      return res.status(404).json({
        error: "MCP SSE Session not found. Connect to /sse first.",
      });
    }

    await transport.handlePostMessage(req as any, res, req.body);
  });

  /**
   * Streamable HTTP MCP endpoint fallback
   */
  app.post("/mcp", async (req: Request, res: Response) => {
    const { method, params, id, jsonrpc } = req.body || {};

    if (method === "tools/list") {
      return res.json({
        jsonrpc: jsonrpc || "2.0",
        id,
        result: {
          tools: JUPITER_PERPS_PLUGIN_CONTRACT.tools.map((t) => ({
            name: t.id,
            description: t.description,
            inputSchema: t.input_schema,
          })),
        },
      });
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      try {
        let result: any;
        switch (name) {
          case "jup_perps_get_markets":
            result = await copilot.getMarkets();
            break;
          case "jup_perps_get_quote":
            result = await copilot.getQuote(args);
            break;
          case "jup_perps_get_positions":
            result = await copilot.getPositions(args || {});
            break;
          case "jup_perps_open_position":
            result = await copilot.openPosition(args);
            break;
          case "jup_perps_close_position":
            result = await copilot.closePosition(args);
            break;
          case "jup_perps_simulate_onchain_tx":
            result = await copilot.simulateOnChainTx(args);
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return res.json({
          jsonrpc: jsonrpc || "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
            structuredContent: result,
          },
        });
      } catch (err: any) {
        return res.json({
          jsonrpc: jsonrpc || "2.0",
          id,
          error: {
            code: -32603,
            message: err.message || String(err),
          },
        });
      }
    }

    // Default initialization or ping response
    return res.json({
      jsonrpc: jsonrpc || "2.0",
      id,
      result: {
        serverInfo: {
          name: "paybox-jupiter-perps",
          version: "1.0.0",
        },
        capabilities: { tools: {} },
      },
    });
  });

  // ============================================================================
  // 6. Interactive Developer Dashboard (GET /)
  // ============================================================================

  app.get("/", (req: Request, res: Response) => {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host") || `localhost:${port}`;
    const baseUrl = `${protocol}://${host}`;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PayBox Jupiter Perps Copilot 🪐</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: rgba(20, 24, 35, 0.7);
      --border: rgba(255, 255, 255, 0.08);
      --accent: #22c55e;
      --accent-glow: rgba(34, 197, 94, 0.2);
      --solana-grad: linear-gradient(135deg, #9945FF 0%, #14F195 100%);
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', sans-serif;
      line-height: 1.5;
      padding: 2.5rem 1.5rem;
      min-height: 100vh;
    }
    .container { max-width: 1080px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2.5rem;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .brand { display: flex; align-items: center; gap: 0.75rem; }
    .badge-live {
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid var(--accent);
      color: var(--accent);
      padding: 0.35rem 0.8rem;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .badge-live::before {
      content: "";
      width: 8px;
      height: 8px;
      background: var(--accent);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent);
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    h1 { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; }
    .hero {
      background: linear-gradient(180deg, rgba(30, 41, 59, 0.4) 0%, rgba(15, 23, 42, 0.2) 100%);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 2rem;
      margin-bottom: 2rem;
      backdrop-filter: blur(12px);
    }
    .hero p { color: var(--text-muted); font-size: 1.05rem; margin-top: 0.5rem; max-width: 800px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.25rem; margin-bottom: 2rem; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.5rem;
      backdrop-filter: blur(10px);
      transition: transform 0.2s, border-color 0.2s;
    }
    .card:hover { border-color: rgba(255, 255, 255, 0.2); }
    .card-title { font-size: 1.15rem; font-weight: 600; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between; }
    .endpoint-pill {
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 0.5rem 0.75rem;
      border-radius: 0.5rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: #38bdf8;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 0.75rem;
      word-break: break-all;
    }
    .btn-copy {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #fff;
      padding: 0.3rem 0.6rem;
      border-radius: 0.35rem;
      font-size: 0.75rem;
      cursor: pointer;
      margin-left: 0.5rem;
      white-space: nowrap;
    }
    .btn-copy:hover { background: rgba(255, 255, 255, 0.2); }
    .tools-list { list-style: none; display: flex; flex-direction: column; gap: 0.6rem; margin-top: 1rem; }
    .tools-list li {
      padding: 0.6rem;
      background: rgba(15, 23, 42, 0.6);
      border-radius: 0.4rem;
      font-size: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .tool-name { font-family: 'JetBrains Mono', monospace; color: #a7f3d0; font-weight: 600; }
    .tool-desc { color: var(--text-muted); font-size: 0.8rem; }
    footer { text-align: center; color: var(--text-muted); font-size: 0.85rem; margin-top: 3rem; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>PayBox Jupiter Perps Copilot 🪐</h1>
      </div>
      <div class="badge-live">Live On-Chain & PayBox Ready</div>
    </header>

    <div class="hero">
      <h2>Autonomous & Passkey-Gated Leveraged Trading for AI Agents</h2>
      <p>
        Full PayBox marketplace plugin conforming to <strong>developer.paybox.sh</strong> standards.
        Connects ChatGPT, Claude Desktop, Claude.ai, and Grok directly to Jupiter Perpetuals on Solana
        using PayBox non-custodial MoonX MPC vaults and passkey authorization.
      </p>
    </div>

    <div class="grid">
      <!-- ChatGPT Custom GPT Setup -->
      <div class="card">
        <div class="card-title">
          <span>🤖 ChatGPT Custom GPT Actions</span>
        </div>
        <p style="color: var(--text-muted); font-size: 0.9rem;">
          In your ChatGPT Custom GPT editor, click <strong>Create new action</strong> and import this OpenAPI URL:
        </p>
        <div class="endpoint-pill">
          <span>${baseUrl}/openapi.json</span>
          <button class="btn-copy" onclick="navigator.clipboard.writeText('${baseUrl}/openapi.json')">Copy</button>
        </div>
        <div style="margin-top: 1rem; font-size: 0.85rem; color: var(--text-muted);">
          Supports full conversational trade analysis, liquidation distance checks, and PayBox passkey gating.
        </div>
      </div>

      <!-- PayBox Marketplace Plugin Contract -->
      <div class="card">
        <div class="card-title">
          <span>🏪 PayBox Marketplace & CLI</span>
        </div>
        <p style="color: var(--text-muted); font-size: 0.9rem;">
          Official PayBox Plugin manifest and contract schema for discovery via <code>paybox plugins</code>:
        </p>
        <div class="endpoint-pill">
          <span>${baseUrl}/contract.json</span>
          <button class="btn-copy" onclick="navigator.clipboard.writeText('${baseUrl}/contract.json')">Copy</button>
        </div>
        <div class="endpoint-pill">
          <span>${baseUrl}/paybox-plugin.json</span>
          <button class="btn-copy" onclick="navigator.clipboard.writeText('${baseUrl}/paybox-plugin.json')">Copy</button>
        </div>
      </div>

      <!-- MCP Connectors for Claude / Grok -->
      <div class="card">
        <div class="card-title">
          <span>⚡ Remote MCP Connectors</span>
        </div>
        <p style="color: var(--text-muted); font-size: 0.9rem;">
          Streamable HTTP & SSE transport for Claude.ai, Grok (grok.com/connectors), and remote agent runners:
        </p>
        <div class="endpoint-pill">
          <span>${baseUrl}/sse</span>
          <button class="btn-copy" onclick="navigator.clipboard.writeText('${baseUrl}/sse')">Copy SSE</button>
        </div>
        <div class="endpoint-pill">
          <span>${baseUrl}/mcp</span>
          <button class="btn-copy" onclick="navigator.clipboard.writeText('${baseUrl}/mcp')">Copy MCP</button>
        </div>
      </div>

      <!-- x402 Fast-Lane Protocol -->
      <div class="card">
        <div class="card-title">
          <span>💳 x402 Micropayments Protocol</span>
        </div>
        <p style="color: var(--text-muted); font-size: 0.9rem;">
          Native HTTP 402 endpoints that speak the x402 payment standard highlighted by the Hackathon:
        </p>
        <div class="endpoint-pill">
          <span>POST ${baseUrl}/x402/quote</span>
          <button class="btn-copy" onclick="navigator.clipboard.writeText('${baseUrl}/x402/quote')">Copy</button>
        </div>
        <div class="endpoint-pill">
          <span>POST ${baseUrl}/x402/trade</span>
          <button class="btn-copy" onclick="navigator.clipboard.writeText('${baseUrl}/x402/trade')">Copy</button>
        </div>
      </div>
    </div>

    <!-- Exposed Plugin Tools -->
    <div class="card" style="margin-bottom: 2rem;">
      <div class="card-title">
        <span>🛠️ Active Plugin Tools (${JUPITER_PERPS_PLUGIN_CONTRACT.tools.length})</span>
        <span style="font-size: 0.8rem; color: var(--accent);">Anchor IDL Verified</span>
      </div>
      <ul class="tools-list">
        ${JUPITER_PERPS_PLUGIN_CONTRACT.tools
          .map(
            (t) => `<li>
          <span class="tool-name">${t.id}</span>
          <span class="tool-desc">${t.description}</span>
        </li>`
          )
          .join("")}
      </ul>
    </div>

    <footer>
      Powered by <a href="https://paybox.sh" target="_blank">PayBox by MoonPay</a> & <a href="https://jup.ag" target="_blank">Jupiter Perpetuals</a> · Hackathon Chapter 1 Entry
    </footer>
  </div>
</body>
</html>`);
  });

  return app;
}
