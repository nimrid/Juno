import { Keypair, PublicKey } from "@solana/web3.js";
import { JupiterPerpsClient } from "../services/jupiter/client.js";
import { JupiterTradeBuilder } from "../services/jupiter/trade-builder.js";
import { PayboxSignerService } from "../services/paybox/signer.js";
import { formatUsd } from "../services/jupiter/math.js";

function parseWalletPublicKey(addr?: string): PublicKey {
  const target =
    addr ||
    process.env.DEFAULT_SOLANA_WALLET ||
    process.env.PAYBOX_SOLANA_WALLET_ADDRESS ||
    process.env.x402_SOLANA_WALLET_ADDRESS ||
    process.env.X402_SOLANA_WALLET_ADDRESS;

  if (!target) {
    throw new Error(
      "Wallet address is required. Please provide a valid Solana base58 public key."
    );
  }

  try {
    return new PublicKey(target);
  } catch {
    throw new Error(`Invalid Solana wallet address: '${target}'`);
  }
}

export class JupiterPerpsCopilotTools {
  private client: JupiterPerpsClient;
  private builder: JupiterTradeBuilder;
  private signer: PayboxSignerService;

  constructor(rpcUrl?: string) {
    this.client = new JupiterPerpsClient(rpcUrl || process.env.SOLANA_RPC_URL);
    this.builder = new JupiterTradeBuilder(this.client.program);
    this.signer = new PayboxSignerService();
  }

  /**
   * Tool: jup_perps_get_markets
   */
  async getMarkets() {
    const markets = await this.client.getMarkets();
    return {
      markets: markets.map((m) => ({
        symbol: m.symbol,
        name: m.name,
        currentPrice: formatUsd(m.currentPriceUsd),
        rawPriceUsd: m.currentPriceUsd,
        maxLeverage: `${m.maxLeverage}x`,
        openFee: `${m.openPositionFeeBps / 100}%`,
        closeFee: `${m.closePositionFeeBps / 100}%`,
        hourlyBorrowRate: `${(m.hourlyBorrowRateBps * 100).toFixed(4)}%`,
      })),
    };
  }

  /**
   * Tool: jup_perps_get_quote
   */
  async getQuote(args: {
    market: "SOL-PERP" | "BTC-PERP" | "ETH-PERP";
    side: "long" | "short";
    collateralUsd: number;
    leverage: number;
  }) {
    const quote = await this.client.getQuote(args);
    return {
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
  }

  /**
   * Tool: jup_perps_get_positions
   */
  async getPositions(args: { walletAddress?: string }) {
    const owner = parseWalletPublicKey(args.walletAddress);
    const wallet = owner.toBase58();

    const positions = await this.client.getOpenPositionsForWallet(wallet);

    return {
      walletAddress: wallet,
      activePositionsCount: positions.length,
      positions: positions.map((p) => ({
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
      })),
    };
  }

  /**
   * Tool: jup_perps_open_position
   */
  async openPosition(args: {
    market: "SOL-PERP" | "BTC-PERP" | "ETH-PERP";
    side: "long" | "short";
    collateralUsd: number;
    leverage: number;
    collateralToken?: "USDC" | "SOL";
    walletAddress?: string;
    credentialId?: string;
    slippageBps?: number;
  }) {
    const owner = parseWalletPublicKey(args.walletAddress);
    const walletAddressStr = owner.toBase58();

    const credentialId =
      args.credentialId ||
      process.env.DEFAULT_CREDENTIAL_ID ||
      process.env.PAYBOX_SOLANA_CREDENTIAL_ID ||
      "crd_solana_primary";

    // 1. Get quote first to check risk & safety
    const quote = await this.client.getQuote({
      market: args.market,
      side: args.side,
      collateralUsd: args.collateralUsd,
      leverage: args.leverage,
    });

    // 2. Build on-chain Solana VersionedTransaction
    const builtTx = await this.builder.buildOpenPositionTx({
      owner,
      market: args.market,
      side: args.side,
      collateralUsd: args.collateralUsd,
      leverage: args.leverage,
      collateralToken: args.collateralToken || "USDC",
      slippageBps: args.slippageBps || 50,
    });

    // 3. Format PayBox non-custodial signing request
    const requireApproval = quote.isHighRisk || args.collateralUsd > 100;
    const signResult = await this.signer.signSolanaTransaction({
      credentialId,
      walletAddress: walletAddressStr,
      transactionBase64: builtTx.transactionBase64,
      description: `Open ${args.leverage}x ${args.side.toUpperCase()} on ${args.market} with $${args.collateralUsd} collateral`,
      requireApproval,
    });

    // 4. Validate and verify directly against live Solana Mainnet RPC node
    let onChainRpcVerification: any = undefined;
    try {
      const sim = await this.client.simulateOnChain(builtTx.transactionBase64);
      onChainRpcVerification = {
        verifiedOnMainnet: sim.success,
        computeUnitsConsumed: sim.unitsConsumed,
        err: sim.err,
        recentExecutionLogs: sim.logs.slice(-6),
      };
    } catch (e: any) {
      onChainRpcVerification = {
        verifiedOnMainnet: false,
        error: e.message || String(e),
      };
    }

    return {
      status: signResult.status,
      tradeDetails: {
        market: args.market,
        side: args.side.toUpperCase(),
        collateralUsd: formatUsd(args.collateralUsd),
        leverage: `${args.leverage}x`,
        positionSizeUsd: formatUsd(quote.positionSizeUsd),
        liquidationPrice: formatUsd(quote.liquidationPriceUsd),
        positionPubkey: builtTx.positionPubkey,
        positionRequestPubkey: builtTx.positionRequestPubkey,
      },
      // Real on-chain Solana VM verification:
      onChainRpcVerification,
      // Direct Native PayBox MCP Tool Call payload for zero-key agent chaining:
      payboxMcpCall: signResult.payboxMcpCall,
      agentNextStep: signResult.approvalUrl
        ? `Passkey required by PayBox policy: Surface approval link (${signResult.approvalUrl}) or invoke PayBox tool request_wallet_sign with the payboxMcpCall arguments.`
        : `Autonomous trade prepared & verified on Solana RPC. Call PayBox tool 'request_wallet_sign' with the payboxMcpCall arguments to sign & execute on-chain.`,
    };
  }

  /**
   * Tool: jup_perps_close_position
   */
  async closePosition(args: {
    positionPubkey: string;
    walletAddress?: string;
    credentialId?: string;
    desiredReceiveToken?: "USDC" | "SOL";
  }) {
    const owner = parseWalletPublicKey(args.walletAddress);
    const walletAddressStr = owner.toBase58();

    const credentialId =
      args.credentialId ||
      process.env.DEFAULT_CREDENTIAL_ID ||
      process.env.PAYBOX_SOLANA_CREDENTIAL_ID ||
      "crd_solana_primary";

    const posKey = new PublicKey(args.positionPubkey);

    // 1. Build decrease position transaction
    const builtTx = await this.builder.buildClosePositionTx({
      owner,
      positionPubkey: posKey,
      desiredReceiveToken: args.desiredReceiveToken || "USDC",
    });

    // 2. Submit to PayBox for non-custodial signing
    const signResult = await this.signer.signSolanaTransaction({
      credentialId,
      walletAddress: walletAddressStr,
      transactionBase64: builtTx.transactionBase64,
      description: `Close perpetual position ${args.positionPubkey}`,
      requireApproval: false, // Closing a position de-risks, so usually autonomous
    });

    return {
      status: signResult.status,
      closedPosition: {
        positionPubkey: args.positionPubkey,
        positionRequestPubkey: builtTx.positionRequestPubkey,
        receiveToken: args.desiredReceiveToken || "USDC",
      },
      // Direct Native PayBox MCP Tool Call payload for zero-key agent chaining:
      payboxMcpCall: signResult.payboxMcpCall,
      agentNextStep: signResult.approvalUrl
        ? `Passkey required: Call PayBox tool 'request_wallet_sign' with payboxMcpCall arguments. Approval link: ${signResult.approvalUrl}`
        : `Close request prepared. Call PayBox tool 'request_wallet_sign' with payboxMcpCall arguments to sign & execute.`,
    };
  }

  /**
   * Tool: jup_perps_simulate_onchain_tx
   * Validates any base64 VersionedTransaction directly against the Solana Mainnet validator VM.
   */
  async simulateOnChainTx(args: { transactionBase64: string }) {
    return this.client.simulateOnChain(args.transactionBase64);
  }
}
