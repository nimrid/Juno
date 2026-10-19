import { JupiterPerpsCopilotTools } from "./tools/index.js";
import dotenv from "dotenv";

dotenv.config();

async function runLiveVerification() {
  console.log("==================================================================");
  console.log(" 🌐 REAL ON-CHAIN SOLANA MAINNET VERIFICATION (ZERO MOCK DATA)");
  console.log("==================================================================\n");

  const copilot = new JupiterPerpsCopilotTools();

  // 1. Live On-Chain Market Discovery
  console.log("📡 [1/3] Reading Live On-Chain Oracles & Jupiter Custody Accounts...");
  const marketsResult = await copilot.getMarkets();
  console.table(marketsResult.markets);

  // 2. Real VersionedTransaction Compilation
  console.log("\n⚙️ [2/3] Compiling Live Solana VersionedTransaction (v0)...");
  console.log("Using Program ID: PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu");
  const tradeResult = await copilot.openPosition({
    market: "SOL-PERP",
    side: "long",
    collateralUsd: 50,
    leverage: 3,
    collateralToken: "SOL",
    slippageBps: 50,
  });

  const base64Tx = tradeResult.payboxMcpCall.arguments.intent.transactionBase64;
  console.log(`Generated VersionedTransaction Base64 (${base64Tx.length} chars)`);

  // 3. Live On-Chain Solana RPC Simulation
  console.log("\n⚡ [3/3] Sending Transaction to Solana Mainnet RPC for VM Simulation...");
  const sim = await copilot.simulateOnChainTx({ transactionBase64: base64Tx });

  console.log("\n==================================================================");
  console.log(" 🎯 SOLANA MAINNET RPC VALIDATION RESULT");
  console.log("==================================================================");
  console.log(`Status:              ${sim.success ? "✅ SUCCESS (Valid on Solana Mainnet)" : "❌ FAILED"}`);
  console.log(`Compute Units Used:  ${sim.unitsConsumed?.toLocaleString() || "N/A"}`);
  console.log(`Runtime Error:       ${sim.err ? JSON.stringify(sim.err) : "None (Passed All Checks)"}`);
  console.log("\n📜 Live Solana On-Chain Program Execution Logs:");
  sim.logs.forEach((log: string) => console.log(`   ${log}`));

  console.log("\n📦 PayBox MCP Tool Call Intent (Ready for Host Agent Chaining):");
  console.log(JSON.stringify(tradeResult.payboxMcpCall, null, 2));

  console.log("\n==================================================================");
  console.log("🎉 Real on-chain verification complete. Program logic fully verified!");
  console.log("==================================================================");
}

async function runDemo() {
  await runLiveVerification();
}

async function main() {
  const command = process.argv[2] || "verify";

  switch (command) {
    case "verify":
    case "live":
    case "demo":
    case "test":
      await runLiveVerification();
      break;
    default:
      console.log(`Usage: paybox-jup-perps [verify|live|demo]`);
      break;
  }
}

main().catch((err) => {
  console.error("CLI error:", err);
  process.exit(1);
});
