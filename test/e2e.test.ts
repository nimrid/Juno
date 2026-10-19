import { createHttpServer } from "../src/http-server.js";
import { JupiterPerpsCopilotTools } from "../src/tools/index.js";
import type { Server } from "http";

async function runTests() {
  console.log("==================================================================");
  console.log(" 🧪 RUNNING PAYBOX MULTI-AGENT PLUGIN INTEGRATION TESTS");
  console.log("==================================================================\n");

  const copilot = new JupiterPerpsCopilotTools();
  const testPort = 3987;
  const app = createHttpServer(copilot, testPort);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(testPort, () => resolve(s));
  });

  const baseUrl = `http://localhost:${testPort}`;
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`❌ [FAIL] ${name}:`, err.message || err);
      failed++;
    }
  }

  try {
    // 1. PayBox Marketplace Manifest
    await test("GET /paybox-plugin.json (Marketplace Manifest)", async () => {
      const res = await fetch(`${baseUrl}/paybox-plugin.json`);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const json = await res.json();
      if (json.id !== "jupiter-perps") throw new Error(`Unexpected id ${json.id}`);
      if (!Array.isArray(json.tools) || json.tools.length < 5) throw new Error("Missing tools");
    });

    // 2. PayBox Plugin Contract
    await test("GET /contract.json (PayBox Plugin Contract)", async () => {
      const res = await fetch(`${baseUrl}/contract.json`);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const json = await res.json();
      if (json.contract_uri !== "paybox://plugins/jupiter-perps") {
        throw new Error(`Invalid contract_uri: ${json.contract_uri}`);
      }
      if (!json.contract?.tools) throw new Error("Missing contract tools");
    });

    // 3. PayBox Generic use_plugin Invocation
    await test("POST /api/plugins/use (PayBox generic use_plugin)", async () => {
      const res = await fetch(`${baseUrl}/api/plugins/use`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plugin_id: "jupiter-perps",
          tool_id: "jup_perps_get_markets",
          input: {},
        }),
      });
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const json = await res.json();
      if (json.status !== "success" || !json.output?.markets) {
        throw new Error("Invalid output format");
      }
    });

    // 4. OpenAPI 3.1.0 for ChatGPT Custom GPT Actions
    await test("GET /openapi.json (ChatGPT Custom GPT Actions)", async () => {
      const res = await fetch(`${baseUrl}/openapi.json`);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const json = await res.json();
      if (json.openapi !== "3.1.0") throw new Error(`Expected OpenAPI 3.1.0, got ${json.openapi}`);
      if (!json.paths["/api/markets"] || !json.paths["/api/quote"]) {
        throw new Error("Missing required OpenAPI paths");
      }
    });

    // 5. REST /api/markets
    await test("GET /api/markets (REST Market Data)", async () => {
      const res = await fetch(`${baseUrl}/api/markets`);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const json = await res.json();
      if (!json.markets || json.markets.length === 0) throw new Error("Empty markets array");
    });

    // 6. REST /api/quote
    await test("POST /api/quote (REST Trade Quote & Risk Calculation)", async () => {
      const res = await fetch(`${baseUrl}/api/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market: "SOL-PERP",
          side: "long",
          collateralUsd: 50,
          leverage: 3,
        }),
      });
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const json = await res.json();
      if (!json.liquidationPrice || !json.payboxApprovalMode) {
        throw new Error("Missing quote fields");
      }
    });

    // 7. x402 Micropayment Protocol (HTTP 402 challenge)
    await test("POST /x402/quote (x402 Protocol Challenge)", async () => {
      const res = await fetch(`${baseUrl}/x402/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market: "SOL-PERP",
          side: "long",
          collateralUsd: 50,
          leverage: 3,
        }),
      });
      if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);
      const accepts = res.headers.get("x-accepts");
      if (!accepts) throw new Error("Missing X-Accepts header");
      const json = await res.json();
      if (json.error !== "Payment Required") throw new Error("Missing error payload");
    });

    // 8. x402 Micropayment Protocol (Settled with header)
    await test("POST /x402/quote with X-PAYMENT (x402 Execution)", async () => {
      const res = await fetch(`${baseUrl}/x402/quote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment": "solana:tx:settlement_proof",
        },
        body: JSON.stringify({
          market: "SOL-PERP",
          side: "long",
          collateralUsd: 50,
          leverage: 3,
        }),
      });
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const json = await res.json();
      if (json.x402_status !== "settled" || !json.data) throw new Error("Invalid x402 result");
    });

    // 9. Streamable HTTP MCP tools/list
    await test("POST /mcp (Streamable HTTP MCP JSON-RPC tools/list)", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const json = await res.json();
      if (!json.result?.tools || json.result.tools.length < 5) {
        throw new Error("tools/list failed or incomplete");
      }
    });

    // 10. Dashboard HTML Status
    await test("GET / (Interactive Dashboard)", async () => {
      const res = await fetch(`${baseUrl}/`);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const text = await res.text();
      if (!text.includes("PayBox Jupiter Perps Copilot")) {
        throw new Error("Dashboard title missing");
      }
    });

  } finally {
    server.close();
  }

  console.log("\n==================================================================");
  console.log(` 🎯 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
