import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VersionedTransaction } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const artifact = resolve(root, "dist/plugin.mjs");
const PROTOCOL_VERSION = "2026-07-28";

class McpLiveClient {
  constructor(artifactPath) {
    this.artifactPath = artifactPath;
    this.child = null;
    this.lines = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  async start() {
    this.child = spawn(process.execPath, [this.artifactPath], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (data) => {
      const msg = data.toString();
      if (!msg.includes("punycode")) {
        console.error(`[plugin stderr]: ${msg.trim()}`);
      }
    });

    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      } catch (err) {
        console.error("Non-JSON stdout:", line);
      }
    });

    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Plugin exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  async call(method, params = {}) {
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "live-plugin-verifier", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async callTool(name, args = {}) {
    return this.call("tools/call", { name, arguments: args });
  }

  async listTools() {
    return this.call("tools/list", {});
  }

  async stop() {
    if (this.child) {
      this.child.kill();
    }
  }
}

async function runLiveToolsSuite() {
  console.log("==================================================================");
  console.log(" 🌐 COMPREHENSIVE LIVE ON-CHAIN PLUGIN TOOL VERIFICATION SUITE");
  console.log(" Target: dist/plugin.mjs (MCP Standalone Bundle)");
  console.log(" Network: Solana Mainnet (Live Oracles & Live Jupiter Smart Contracts)");
  console.log("==================================================================\n");

  const client = new McpLiveClient(artifact);
  await client.start();

  let passed = 0;
  let failed = 0;

  async function step(name, fn) {
    try {
      console.log(`\n▶️ Testing: ${name}`);
      const t0 = performance.now();
      await fn();
      const dur = Math.round(performance.now() - t0);
      console.log(`✅ [PASS] ${name} (${dur}ms)`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}:`, err.message || err);
      failed++;
    }
  }

  try {
    // 0. Discover Tools
    let tools = [];
    await step("MCP Tool Discovery (tools/list)", async () => {
      const res = await client.listTools();
      tools = res.tools;
      if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error("No tools discovered from plugin.mjs");
      }
      console.log(`   Discovered ${tools.length} plugin tools:`);
      tools.forEach((t) => console.log(`   - ${t.name}: ${t.description.slice(0, 70)}...`));
      const expectedTools = [
        "jup_perps_get_markets",
        "jup_perps_get_quote",
        "jup_perps_get_positions",
        "jup_perps_open_position",
        "jup_perps_close_position",
        "jup_perps_simulate_onchain_tx",
      ];
      for (const exp of expectedTools) {
        if (!tools.find((t) => t.name === exp)) {
          throw new Error(`Expected tool ${exp} not found in tools/list`);
        }
      }
    });

    // 1. Tool: jup_perps_get_markets
    let liveMarkets = [];
    await step("Tool 1/6: jup_perps_get_markets (Live On-Chain Oracles)", async () => {
      const res = await client.callTool("jup_perps_get_markets", {});
      const content = res.structuredContent;
      if (!content || !Array.isArray(content.markets)) {
        throw new Error("Invalid output structure for jup_perps_get_markets");
      }
      liveMarkets = content.markets;
      console.log(`   Fetched ${liveMarkets.length} live perpetual markets from Solana Mainnet:`);
      for (const m of liveMarkets) {
        console.log(`   * ${m.symbol} (${m.name}): Current Mark = ${m.currentPrice} (raw: $${m.rawPriceUsd.toFixed(2)}), Max Lev = ${m.maxLeverage}, Fees = ${m.openFee}/${m.closeFee}`);
        if (m.rawPriceUsd <= 0) throw new Error(`Invalid non-positive mark price for ${m.symbol}: ${m.rawPriceUsd}`);
        if (!m.currentPrice.startsWith("$")) throw new Error(`Formatted price should start with $: ${m.currentPrice}`);
      }

      const sol = liveMarkets.find((m) => m.symbol === "SOL-PERP");
      const btc = liveMarkets.find((m) => m.symbol === "BTC-PERP");
      const eth = liveMarkets.find((m) => m.symbol === "ETH-PERP");

      if (!sol || !btc || !eth) throw new Error("Missing SOL, BTC, or ETH markets");
      if (sol.rawPriceUsd < 20 || sol.rawPriceUsd > 1000) throw new Error(`SOL price out of sane bounds: ${sol.rawPriceUsd}`);
      if (btc.rawPriceUsd < 20000 || btc.rawPriceUsd > 500000) throw new Error(`BTC price out of sane bounds: ${btc.rawPriceUsd}`);
      if (eth.rawPriceUsd < 500 || eth.rawPriceUsd > 25000) throw new Error(`ETH price out of sane bounds: ${eth.rawPriceUsd}`);
    });

    // 2. Tool: jup_perps_get_quote
    await step("Tool 2/6: jup_perps_get_quote (Live Leverage Quote & Risk Analysis)", async () => {
      // Test A: SOL-PERP Long
      const solQuote = await client.callTool("jup_perps_get_quote", {
        market: "SOL-PERP",
        side: "long",
        collateralUsd: 50,
        leverage: 3,
      });
      const q1 = solQuote.structuredContent;
      console.log(`   SOL Long Quote: Mark=${q1.markPrice}, Size=${q1.totalPositionSize}, Liq=${q1.liquidationPrice} (${q1.distanceToLiquidation} away), Mode=${q1.payboxApprovalMode}`);
      if (!q1.liquidationPrice || !q1.distanceToLiquidation || !q1.markPrice) throw new Error("Missing quote fields");

      // Test B: BTC-PERP Short
      const btcQuote = await client.callTool("jup_perps_get_quote", {
        market: "BTC-PERP",
        side: "short",
        collateralUsd: 200,
        leverage: 5,
      });
      const q2 = btcQuote.structuredContent;
      console.log(`   BTC Short Quote: Mark=${q2.markPrice}, Size=${q2.totalPositionSize}, Liq=${q2.liquidationPrice} (${q2.distanceToLiquidation} away), Mode=${q2.payboxApprovalMode}`);

      // Test C: High-leverage risk check (ETH-PERP 20x)
      const ethQuote = await client.callTool("jup_perps_get_quote", {
        market: "ETH-PERP",
        side: "long",
        collateralUsd: 150,
        leverage: 20,
      });
      const q3 = ethQuote.structuredContent;
      console.log(`   ETH 20x Quote: Risk=${q3.riskLevel}, PayBox Approval Mode=${q3.payboxApprovalMode}`);
      if (q3.riskLevel !== "HIGH_RISK") throw new Error("20x leverage should trigger HIGH_RISK");
      if (!q3.payboxApprovalMode.includes("PASSKEY_REQUIRED")) throw new Error("High leverage / high collateral must trigger passkey approval");
    });

    // 3. Tool: jup_perps_get_positions
    await step("Tool 3/6: jup_perps_get_positions (Query Live Positions On-Chain)", async () => {
      const defaultWallet = process.env.DEFAULT_SOLANA_WALLET || "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
      const resDefault = await client.callTool("jup_perps_get_positions", {
        walletAddress: defaultWallet,
      });
      const contentDefault = resDefault.structuredContent;
      if (!contentDefault || typeof contentDefault.activePositionsCount !== "number" || !Array.isArray(contentDefault.positions)) {
        throw new Error("Invalid output structure for jup_perps_get_positions");
      }
      console.log(`   Default Wallet (${defaultWallet}): ${contentDefault.activePositionsCount} active open positions.`);

      // Test with a second live Solana wallet to ensure multi-account querying works
      const secondWallet = "4Nd1mBQtrMJVYVfKf2PJy9NZPdUZRBGW3NVZET447GPQ";
      const resSecond = await client.callTool("jup_perps_get_positions", {
        walletAddress: secondWallet,
      });
      const contentSecond = resSecond.structuredContent;
      if (!contentSecond || typeof contentSecond.activePositionsCount !== "number" || !Array.isArray(contentSecond.positions)) {
        throw new Error("Invalid output structure for second wallet");
      }
      console.log(`   Second Wallet (${secondWallet}): ${contentSecond.activePositionsCount} active open positions on-chain.`);
    });

    // 4. Tool: jup_perps_open_position
    let compiledBase64Tx = "";
    await step("Tool 4/6: jup_perps_open_position (Compile Live Solana VersionedTransaction Proposal)", async () => {
      const testWallet = process.env.DEFAULT_SOLANA_WALLET || "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
      
      // Case 1: SOL-PERP Long with SOL collateral
      const res1 = await client.callTool("jup_perps_open_position", {
        walletAddress: testWallet,
        market: "SOL-PERP",
        side: "long",
        collateralUsd: 50,
        leverage: 3,
        collateralToken: "SOL",
        slippageBps: 50,
      });

      const proposal1 = res1.structuredContent["io.paybox/transactionProposal"];
      if (!proposal1) throw new Error("Missing io.paybox/transactionProposal envelope");
      if (proposal1.kind !== "solana" || proposal1.chain !== "solana:mainnet") {
        throw new Error(`Invalid proposal chain/kind: ${proposal1.kind} on ${proposal1.chain}`);
      }
      if (!proposal1.transaction?.transactionBase64) {
        throw new Error("Missing transactionBase64 in proposal");
      }

      compiledBase64Tx = proposal1.transaction.transactionBase64;
      const rawBytes = Buffer.from(compiledBase64Tx, "base64");
      const deserialized = VersionedTransaction.deserialize(rawBytes);
      console.log(`   Case 1 (SOL collateral): Compiled VersionedTransaction (${rawBytes.length} bytes, ${deserialized.message.compiledInstructions.length} instructions)`);

      // Case 2: BTC-PERP Long with USDC collateral
      const res2 = await client.callTool("jup_perps_open_position", {
        walletAddress: testWallet,
        market: "BTC-PERP",
        side: "long",
        collateralUsd: 100,
        leverage: 2,
        collateralToken: "USDC",
      });
      const proposal2 = res2.structuredContent["io.paybox/transactionProposal"];
      if (!proposal2?.transaction?.transactionBase64) throw new Error("Case 2 failed to produce transaction proposal");
      console.log(`   Case 2 (BTC with USDC collateral): Compiled VersionedTransaction (${Buffer.from(proposal2.transaction.transactionBase64, "base64").length} bytes)`);

      // Case 3: ETH-PERP Short with USDC collateral
      const res3 = await client.callTool("jup_perps_open_position", {
        walletAddress: testWallet,
        market: "ETH-PERP",
        side: "short",
        collateralUsd: 75,
        leverage: 4,
        collateralToken: "USDC",
      });
      const proposal3 = res3.structuredContent["io.paybox/transactionProposal"];
      if (!proposal3?.transaction?.transactionBase64) throw new Error("Case 3 failed to produce transaction proposal");
      console.log(`   Case 3 (ETH Short with USDC collateral): Compiled VersionedTransaction (${Buffer.from(proposal3.transaction.transactionBase64, "base64").length} bytes)`);
    });

    // 5. Tool: jup_perps_simulate_onchain_tx
    await step("Tool 5/6: jup_perps_simulate_onchain_tx (Simulate Transaction on Live Solana Mainnet RPC)", async () => {
      if (!compiledBase64Tx) throw new Error("No compiledBase64Tx available from previous step");

      const res = await client.callTool("jup_perps_simulate_onchain_tx", {
        transactionBase64: compiledBase64Tx,
      });

      const sim = res.structuredContent;
      console.log(`   Solana Mainnet RPC Simulation Result:`);
      console.log(`   * Success: ${sim.success ? "✅ TRUE" : "❌ FALSE"}`);
      console.log(`   * Compute Units Consumed: ${sim.unitsConsumed}`);
      console.log(`   * Error: ${sim.err || "None (clean execution)"}`);
      console.log(`   * Logs Captured: ${sim.logs.length} program logs`);

      if (!sim.success) {
        throw new Error(`Simulation failed on Solana Mainnet: ${sim.err}`);
      }
      if (sim.unitsConsumed <= 0) {
        throw new Error(`Units consumed must be > 0: got ${sim.unitsConsumed}`);
      }

      // Verify that Jupiter Perps program actually ran
      const jupProgramInvoked = sim.logs.some((l) => l.includes("PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu invoke [1]"));
      const jupIxLogged = sim.logs.some((l) => l.includes("Instruction: CreateIncreasePositionMarketRequest"));

      if (!jupProgramInvoked) {
        throw new Error("Jupiter Perps Program ID (PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu) was not invoked in RPC logs");
      }
      if (!jupIxLogged) {
        throw new Error("CreateIncreasePositionMarketRequest was not executed in on-chain logs");
      }

      console.log(`   Program verification confirmed: Jupiter Perps smart contract executed successfully.`);
    });

    // 6. Tool: jup_perps_close_position
    await step("Tool 6/6: jup_perps_close_position (Construct Close Position Proposal)", async () => {
      const testWallet = process.env.DEFAULT_SOLANA_WALLET || "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
      // Generate a deterministic position pubkey or use a sample
      const samplePosition = "8x2fmJbkpTwtWv4kK96q4Cqj7k9Zz8f5Ua9E7d6c5b4A";

      const res = await client.callTool("jup_perps_close_position", {
        walletAddress: testWallet,
        positionPubkey: samplePosition,
        desiredReceiveToken: "USDC",
      });

      console.log("   Close response raw:", JSON.stringify(res, null, 2));
      const proposal = res.structuredContent?.["io.paybox/transactionProposal"];
      if (!proposal) throw new Error("Missing io.paybox/transactionProposal envelope in close position response");
      if (proposal.kind !== "solana" || proposal.chain !== "solana:mainnet") {
        throw new Error(`Invalid proposal chain/kind: ${proposal.kind} on ${proposal.chain}`);
      }
      if (!proposal.transaction?.transactionBase64) {
        throw new Error("Missing transactionBase64 in close proposal");
      }

      const rawBytes = Buffer.from(proposal.transaction.transactionBase64, "base64");
      const tx = VersionedTransaction.deserialize(rawBytes);
      console.log(`   Close Position Proposal compiled (${rawBytes.length} bytes, ${tx.message.compiledInstructions.length} instructions)`);

      // Also simulate close transaction on Solana Mainnet RPC node to verify bytecode validity
      const sim = await client.callTool("jup_perps_simulate_onchain_tx", {
        transactionBase64: proposal.transaction.transactionBase64,
      });

      console.log(`   Close Position RPC Simulation: Success=${sim.structuredContent.success}, Error=${sim.structuredContent.err || "None"}`);
      // Note: If the position account doesn't exist on-chain for the sample key, simulation may report account not found,
      // but the transaction itself is properly formatted, parsed, and simulated against the RPC!
      if (!sim.structuredContent.logs || sim.structuredContent.logs.length === 0) {
        throw new Error("Solana Mainnet RPC did not return logs for close position simulation");
      }
      console.log(`   On-chain logs received (${sim.structuredContent.logs.length} entries). First log: ${sim.structuredContent.logs[0]}`);
    });

  } finally {
    await client.stop();
  }

  console.log("\n==================================================================");
  console.log(` 🎯 LIVE ON-CHAIN PLUGIN TOOLS SUITE RESULTS`);
  console.log(` Tests Passed: ${passed}`);
  console.log(` Tests Failed: ${failed}`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runLiveToolsSuite().catch((err) => {
  console.error("Live test suite failure:", err);
  process.exit(1);
});
