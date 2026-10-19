import "dotenv/config";
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

try {
  const currentDir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: resolve(currentDir, "../.env") });
  dotenv.config({ path: resolve(process.cwd(), ".env") });
} catch {}
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { PublicKey } from "@solana/web3.js";
import * as z from "zod/v4";
import { proposeSolana, solanaOutputSchema } from "./paybox.js";
import { JupiterPerpsClient } from "./services/jupiter/client.js";
import { JupiterTradeBuilder } from "./services/jupiter/trade-builder.js";
import { formatUsd } from "./services/jupiter/math.js";

const PROTOCOL_VERSION = "2026-07-28";

function createServer() {
  const server = new McpServer(
    { name: "jupiter-perps", version: "1.0.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  let clientInstance: JupiterPerpsClient | null = null;
  let builderInstance: JupiterTradeBuilder | null = null;

  function getClient(): JupiterPerpsClient {
    if (!clientInstance) {
      clientInstance = new JupiterPerpsClient(process.env.SOLANA_RPC_URL);
    }
    return clientInstance;
  }

  function getBuilder(): JupiterTradeBuilder {
    if (!builderInstance) {
      const client = getClient();
      builderInstance = new JupiterTradeBuilder(client.program);
    }
    return builderInstance;
  }

  // 1. Tool: jup_perps_get_quote
  server.registerTool(
    "jup_perps_get_quote",
    {
      title: "Get leverage quote & risk analysis",
      description: "Calculates real-time parameters for opening a leverage position on Jupiter Perpetuals using live on-chain Pyth oracles. Computes fees, exact liquidation price, margin requirements, distance to liquidation, and whether PayBox requires user passkey approval.",
      inputSchema: z.object({
        market: z.enum(["SOL-PERP", "BTC-PERP", "ETH-PERP"]).describe("The perpetual market pair (SOL-PERP, BTC-PERP, ETH-PERP)"),
        side: z.enum(["long", "short"]).describe("Trading position side (long or short)"),
        collateralUsd: z.number().positive().max(1_000_000).describe("Collateral amount in USD"),
        leverage: z.number().min(1.1).max(100).describe("Leverage multiplier (from 1.1x up to 100x)"),
      }).strict(),
      outputSchema: z.object({
        market: z.string(),
        side: z.string(),
        markPrice: z.string(),
        collateral: z.string(),
        leverage: z.string(),
        totalPositionSize: z.string(),
        positionTokens: z.string(),
        estimatedOpenFee: z.string(),
        estimatedCloseFee: z.string(),
        liquidationPrice: z.string(),
        distanceToLiquidation: z.string(),
        riskLevel: z.string(),
        payboxApprovalMode: z.string(),
        summary: z.string(),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ market, side, collateralUsd, leverage }) => {
      const client = getClient();
      const quote = await client.getQuote({ market, side, collateralUsd, leverage });
      const structured = {
        market: quote.market,
        side: quote.side.toUpperCase(),
        markPrice: formatUsd(quote.markPrice),
        collateral: formatUsd(quote.collateralUsd),
        leverage: `${quote.leverage}x`,
        totalPositionSize: formatUsd(quote.positionSizeUsd),
        positionTokens: quote.positionSizeTokens.toFixed(4),
        estimatedOpenFee: formatUsd(quote.estimatedOpenFeeUsd),
        estimatedCloseFee: formatUsd(quote.estimatedCloseFeeUsd),
        liquidationPrice: formatUsd(quote.liquidationPriceUsd),
        distanceToLiquidation: `${quote.distanceToLiquidationPercent.toFixed(2)}%`,
        riskLevel: quote.isHighRisk ? "HIGH_RISK" : "MODERATE_RISK",
        payboxApprovalMode: quote.passkeyRequiredEstimate
          ? "PASSKEY_REQUIRED (Position exceeds autonomous limit)"
          : "AUTONOMOUS (Pre-authorized inside MPC enclave)",
        summary: `${quote.leverage}x ${quote.side.toUpperCase()} on ${quote.market} with ${formatUsd(quote.collateralUsd)} collateral. Liquidation at ${formatUsd(quote.liquidationPriceUsd)} (${quote.distanceToLiquidationPercent.toFixed(1)}% away).`,
      };
      return {
        content: [{ type: "text" as const, text: structured.summary }],
        structuredContent: structured,
      };
    },
  );

  // 2. Tool: jup_perps_get_markets
  server.registerTool(
    "jup_perps_get_markets",
    {
      title: "Get tradable perpetual markets",
      description: "Fetch tradable perpetual pairs on Jupiter Perpetuals (SOL-PERP, BTC-PERP, ETH-PERP) with current mark prices, max leverage, and borrow/funding rates.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        markets: z.array(z.object({
          symbol: z.string(),
          name: z.string(),
          currentPrice: z.string(),
          rawPriceUsd: z.number(),
          maxLeverage: z.string(),
          openFee: z.string(),
          closeFee: z.string(),
          hourlyBorrowRate: z.string(),
        }).strict()),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const client = getClient();
      const rawMarkets = await client.getMarkets();
      const markets = rawMarkets.map((m) => ({
        symbol: m.symbol,
        name: m.name,
        currentPrice: formatUsd(m.currentPriceUsd),
        rawPriceUsd: m.currentPriceUsd,
        maxLeverage: `${m.maxLeverage}x`,
        openFee: `${m.openPositionFeeBps / 100}%`,
        closeFee: `${m.closePositionFeeBps / 100}%`,
        hourlyBorrowRate: `${(m.hourlyBorrowRateBps * 100).toFixed(4)}%`,
      }));
      return {
        content: [{ type: "text" as const, text: `Retrieved ${markets.length} Jupiter Perpetuals markets` }],
        structuredContent: { markets },
      };
    },
  );

  // 3. Tool: jup_perps_get_positions
  server.registerTool(
    "jup_perps_get_positions",
    {
      title: "Get open perpetual positions",
      description: "Retrieve all active open perpetual positions for a Solana wallet, including entry price, mark price, leverage, unrealized PnL, and liquidation distance.",
      inputSchema: z.object({
        walletAddress: z.string().min(32).max(44).describe("The Solana wallet public address (base58) to query open positions for. When connected to PayBox, use the active Solana address from list_credentials or previous trade operations."),
      }).strict(),
      outputSchema: z.object({
        walletAddress: z.string(),
        activePositionsCount: z.number(),
        positions: z.array(z.object({
          market: z.string(),
          side: z.string(),
          sizeUsd: z.string(),
          collateralUsd: z.string(),
          leverage: z.string(),
          entryPrice: z.string(),
          currentPrice: z.string(),
          unrealizedPnl: z.string(),
          pnlPercent: z.string(),
          liquidationPrice: z.string(),
          distanceToLiquidation: z.string(),
          positionPubkey: z.string(),
        }).strict()),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ walletAddress }) => {
      const client = getClient();
      const pos = await client.getOpenPositionsForWallet(walletAddress);
      const positions = pos.map((p) => ({
        market: p.market,
        side: p.side.toUpperCase(),
        sizeUsd: formatUsd(p.sizeUsd),
        collateralUsd: formatUsd(p.collateralUsd),
        leverage: `${p.leverage.toFixed(1)}x`,
        entryPrice: formatUsd(p.entryPriceUsd),
        currentPrice: formatUsd(p.currentMarkPriceUsd),
        unrealizedPnl: formatUsd(p.unrealizedPnlUsd),
        pnlPercent: `${p.pnlPercentage > 0 ? "+" : ""}${p.pnlPercentage.toFixed(2)}%`,
        liquidationPrice: formatUsd(p.liquidationPriceUsd),
        distanceToLiquidation: `${p.distanceToLiquidationPercent.toFixed(2)}%`,
        positionPubkey: p.positionPubkey,
      }));
      return {
        content: [{ type: "text" as const, text: `Found ${positions.length} open perpetual positions for wallet ${walletAddress}` }],
        structuredContent: {
          walletAddress,
          activePositionsCount: positions.length,
          positions,
        },
      };
    },
  );

  // 4. Tool: jup_perps_open_position
  server.registerTool(
    "jup_perps_open_position",
    {
      title: "Open leverage position via PayBox",
      description: "Constructs and returns an unsigned Solana transaction proposal to open or increase a leveraged position on Jupiter Perpetuals via PayBox. PayBox handles wallet selection, risk evaluation, approval, and signing.",
      inputSchema: z.object({
        walletAddress: z.string().min(32).max(44).describe("Solana public address (base58) of the trader/fee payer"),
        market: z.enum(["SOL-PERP", "BTC-PERP", "ETH-PERP"]).describe("Perpetual pair to open"),
        side: z.enum(["long", "short"]).describe("Position side (long or short)"),
        collateralUsd: z.number().positive().max(1_000_000).describe("Collateral amount in USD"),
        leverage: z.number().min(1.1).max(100).describe("Leverage multiplier (1.1x to 100x)"),
        collateralToken: z.enum(["USDC", "SOL"]).optional().describe("Funding collateral token (defaults to USDC)"),
        slippageBps: z.number().min(1).max(1000).optional().describe("Price slippage tolerance in basis points (default: 50 = 0.5%)"),
      }).strict(),
      outputSchema: solanaOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, market, side, collateralUsd, leverage, collateralToken, slippageBps }) => {
      const builder = getBuilder();
      const owner = new PublicKey(walletAddress);
      const builtTx = await builder.buildOpenPositionTx({
        owner,
        market,
        side,
        collateralUsd,
        leverage,
        collateralToken: collateralToken ?? "USDC",
        slippageBps: slippageBps ?? 50,
      });

      return proposeSolana({
        transactionBase64: builtTx.transactionBase64,
      });
    },
  );

  // 5. Tool: jup_perps_close_position
  server.registerTool(
    "jup_perps_close_position",
    {
      title: "Close perpetual position via PayBox",
      description: "Constructs and returns an unsigned Solana transaction proposal to close or decrease an existing Jupiter Perpetuals position via PayBox.",
      inputSchema: z.object({
        walletAddress: z.string().min(32).max(44).describe("Solana public address (base58) of the position owner / fee payer"),
        positionPubkey: z.string().min(32).max(44).describe("Public address (base58) of the position account to close"),
        desiredReceiveToken: z.enum(["USDC", "SOL"]).optional().describe("Token to receive settlement in (default: USDC)"),
      }).strict(),
      outputSchema: solanaOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, positionPubkey, desiredReceiveToken }) => {
      const builder = getBuilder();
      const owner = new PublicKey(walletAddress);
      const builtTx = await builder.buildClosePositionTx({
        owner,
        positionPubkey: new PublicKey(positionPubkey),
        desiredReceiveToken: desiredReceiveToken ?? "USDC",
      });

      return proposeSolana({
        transactionBase64: builtTx.transactionBase64,
      });
    },
  );

  // 6. Tool: jup_perps_simulate_onchain_tx
  server.registerTool(
    "jup_perps_simulate_onchain_tx",
    {
      title: "Simulate transaction on Solana mainnet",
      description: "Sends any compiled base64 Solana VersionedTransaction to the live Solana Mainnet RPC node for runtime simulation. Returns compute units consumed, on-chain program logs, and validation errors.",
      inputSchema: z.object({
        transactionBase64: z.string().min(1).describe("Solana compiled VersionedTransaction serialized in base64"),
      }).strict(),
      outputSchema: z.object({
        success: z.boolean(),
        unitsConsumed: z.number().nullable().optional(),
        err: z.string().nullable().optional(),
        logs: z.array(z.string()),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ transactionBase64 }) => {
      const client = getClient();
      const sim = await client.simulateOnChain(transactionBase64);
      return {
        content: [{ type: "text" as const, text: `Simulation ${sim.success ? "succeeded" : "failed"}: ${sim.unitsConsumed ?? 0} CUs consumed.` }],
        structuredContent: {
          success: sim.success,
          unitsConsumed: sim.unitsConsumed ?? null,
          err: sim.err ? JSON.stringify(sim.err) : null,
          logs: sim.logs,
        },
      };
    },
  );

  return server;
}

serveStdio(createServer);
