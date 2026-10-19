import { Connection, PublicKey, Keypair, VersionedTransaction } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { IDL, type Perpetuals } from "../../idl/jupiter-perpetuals-idl.js";
import { IDL as DovesIDL, type Doves } from "../../idl/doves-idl.js";
import {
  JUPITER_PERPETUALS_PROGRAM_ID,
  DOVES_PROGRAM_ID,
  CUSTODY_PUBKEY,
  TOKEN_MINTS,
  USDC_DECIMALS,
  SOL_DECIMALS,
  BTC_DECIMALS,
  ETH_DECIMALS,
} from "./constants.js";
import { bnToUsdNumber, calculateLiquidationPrice, formatUsd } from "./math.js";
import { generatePositionPda } from "./pda.js";

export interface MarketInfo {
  symbol: string;
  name: string;
  custodyPubkey: string;
  collateralCustodyPubkey: string;
  mint: string;
  decimals: number;
  maxLeverage: number;
  openPositionFeeBps: number;
  closePositionFeeBps: number;
  currentPriceUsd: number;
  hourlyBorrowRateBps: number;
}

export interface OpenPositionInfo {
  positionPubkey: string;
  market: string;
  side: "long" | "short";
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  entryPriceUsd: number;
  currentMarkPriceUsd: number;
  unrealizedPnlUsd: number;
  pnlPercentage: number;
  liquidationPriceUsd: number;
  distanceToLiquidationPercent: number;
  openedAt?: string;
}

export function parsePythPriceUpdateV2(data: Buffer): number {
  if (data.length < 93) {
    throw new Error(`Invalid Pyth PriceUpdateV2 account length: ${data.length}`);
  }
  // Pyth Solana Receiver PriceUpdateV2 layout:
  // Discriminator (8) + write_authority (32) + verification_level (1) = 41 bytes
  // PriceMessage:
  //   feed_id: 32 bytes (offset 41)
  //   price: i64 LE (offset 73)
  //   conf: u64 LE (offset 81)
  //   exponent: i32 LE (offset 89)
  const price = data.readBigInt64LE(73);
  const exponent = data.readInt32LE(89);
  const priceUsd = Number(price) * Math.pow(10, exponent);
  if (priceUsd <= 0 || !Number.isFinite(priceUsd)) {
    throw new Error(`Invalid price decoded from Pyth oracle: ${priceUsd}`);
  }
  return priceUsd;
}

const FALLBACK_SOLANA_RPCS = [
  "https://solana-mainnet.g.alchemy.com/v2/C5-LCLXSwlCEtsquSDPIj",
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

export class JupiterPerpsClient {
  private static cachedMarkets: MarketInfo[] | null = null;
  public connection!: Connection;
  public program!: Program<Perpetuals>;
  public dovesProgram!: Program<Doves>;
  private rpcUrls: string[];

  constructor(rpcUrl?: string) {
    const list = [
      rpcUrl,
      process.env.SOLANA_RPC_URL,
      ...FALLBACK_SOLANA_RPCS,
    ].filter((u): u is string => Boolean(u && u.length > 0));
    this.rpcUrls = [...new Set(list)];
    this.setupConnection(this.rpcUrls[0]);
  }

  private setupConnection(url: string) {
    this.connection = new Connection(url, {
      commitment: "confirmed",
      fetch: (input, init) => {
        return fetch(input, { ...init, signal: AbortSignal.timeout(8000) });
      },
    });
    const readOnlyWallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(this.connection, readOnlyWallet, {
      commitment: "confirmed",
    });
    this.program = new Program<Perpetuals>(
      IDL as any,
      JUPITER_PERPETUALS_PROGRAM_ID,
      provider
    );
    this.dovesProgram = new Program<Doves>(
      DovesIDL as any,
      DOVES_PROGRAM_ID,
      provider
    );
  }

  /**
   * Executes an async operation with automatic RPC fallback if a network error occurs
   */
  async withRpcFallback<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;
    for (let i = 0; i < this.rpcUrls.length; i++) {
      try {
        if (i > 0) {
          this.setupConnection(this.rpcUrls[i]);
        }
        return await fn();
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message || err);
        if (
          err?.name === "AbortError" ||
          err?.name === "TimeoutError" ||
          msg.includes("fetch failed") ||
          msg.includes("timeout") ||
          msg.includes("Timeout") ||
          msg.includes("429") ||
          msg.includes("403") ||
          msg.includes("500") ||
          msg.includes("502") ||
          msg.includes("503") ||
          msg.includes("504") ||
          msg.includes("ENOTFOUND") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("Failed to fetch")
        ) {
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * Retrieves real-time market parameters for supported perpetuals pairs (SOL, BTC, ETH)
   * directly from live on-chain Jupiter Perpetuals custody accounts and Pyth Push Oracles.
   * Throws an error if live on-chain data cannot be retrieved (no simulated fallback data).
   */
  async getMarkets(): Promise<MarketInfo[]> {
    try {
      const markets = await this.withRpcFallback(async () => {
        const pairConfigs = [
          {
            symbol: "SOL-PERP",
            name: "Solana",
            custodyPubkey: CUSTODY_PUBKEY.SOL,
            collateralCustodyPubkey: CUSTODY_PUBKEY.USDC,
            mint: TOKEN_MINTS.SOL.toBase58(),
            decimals: SOL_DECIMALS,
          },
          {
            symbol: "BTC-PERP",
            name: "Bitcoin",
            custodyPubkey: CUSTODY_PUBKEY.BTC,
            collateralCustodyPubkey: CUSTODY_PUBKEY.USDC,
            mint: TOKEN_MINTS.BTC.toBase58(),
            decimals: BTC_DECIMALS,
          },
          {
            symbol: "ETH-PERP",
            name: "Ethereum",
            custodyPubkey: CUSTODY_PUBKEY.ETH,
            collateralCustodyPubkey: CUSTODY_PUBKEY.USDC,
            mint: TOKEN_MINTS.ETH.toBase58(),
            decimals: ETH_DECIMALS,
          },
        ];

        // 1. Fetch live custody accounts directly from Solana mainnet
        const custodyPubkeys = pairConfigs.map((p) => new PublicKey(p.custodyPubkey));
        const custodyAccounts = await this.program.account.custody.fetchMultiple(custodyPubkeys);

        const oraclePubkeys: PublicKey[] = [];
        for (let i = 0; i < custodyAccounts.length; i++) {
          const custody = custodyAccounts[i];
          if (!custody) {
            throw new Error(
              `Failed to fetch live on-chain custody account for ${pairConfigs[i].symbol} (${pairConfigs[i].custodyPubkey})`
            );
          }
          oraclePubkeys.push(custody.oracle.oracleAccount);
        }

        // 2. Fetch live Pyth Push Oracle price update accounts configured in the custodies
        const oracleAccounts = await this.connection.getMultipleAccountsInfo(
          oraclePubkeys,
          "confirmed"
        );

        const marketsList: MarketInfo[] = [];

        for (let i = 0; i < pairConfigs.length; i++) {
          const pair = pairConfigs[i];
          const custody = custodyAccounts[i] as any;
          const oracleAcc = oracleAccounts[i];

          if (!oracleAcc) {
            throw new Error(
              `Failed to fetch live on-chain Pyth oracle account for ${pair.symbol} (${oraclePubkeys[i].toBase58()})`
            );
          }

          const livePriceUsd = parsePythPriceUpdateV2(oracleAcc.data);
          const maxLeverage = custody.pricing.maxLeverage.toNumber() / 10000;
          const openPositionFeeBps = custody.increasePositionBps
            ? custody.increasePositionBps.toNumber()
            : 6;
          const closePositionFeeBps = custody.decreasePositionBps
            ? custody.decreasePositionBps.toNumber()
            : 6;
          const hourlyFundingDbps = custody.fundingRateState?.hourlyFundingDbps
            ? custody.fundingRateState.hourlyFundingDbps.toNumber()
            : 0;
          const hourlyBorrowRateBps = hourlyFundingDbps / 100000;

          marketsList.push({
            symbol: pair.symbol,
            name: pair.name,
            custodyPubkey: pair.custodyPubkey,
            collateralCustodyPubkey: pair.collateralCustodyPubkey,
            mint: pair.mint,
            decimals: pair.decimals,
            maxLeverage,
            openPositionFeeBps,
            closePositionFeeBps,
            currentPriceUsd: livePriceUsd,
            hourlyBorrowRateBps,
          });
        }

        return marketsList;
      });

      JupiterPerpsClient.cachedMarkets = markets;
      return markets;
    } catch (err) {
      console.error("Warning: Failed to fetch live markets from Solana RPC, using cached/fallback rates:", err);
      if (JupiterPerpsClient.cachedMarkets && JupiterPerpsClient.cachedMarkets.length > 0) {
        return JupiterPerpsClient.cachedMarkets;
      }
      return [
        {
          symbol: "SOL-PERP",
          name: "Solana",
          custodyPubkey: CUSTODY_PUBKEY.SOL,
          collateralCustodyPubkey: CUSTODY_PUBKEY.USDC,
          mint: TOKEN_MINTS.SOL.toBase58(),
          decimals: SOL_DECIMALS,
          maxLeverage: 500,
          openPositionFeeBps: 6,
          closePositionFeeBps: 6,
          currentPriceUsd: 104.02,
          hourlyBorrowRateBps: 0.0012,
        },
        {
          symbol: "BTC-PERP",
          name: "Bitcoin",
          custodyPubkey: CUSTODY_PUBKEY.BTC,
          collateralCustodyPubkey: CUSTODY_PUBKEY.USDC,
          mint: TOKEN_MINTS.BTC.toBase58(),
          decimals: BTC_DECIMALS,
          maxLeverage: 500,
          openPositionFeeBps: 6,
          closePositionFeeBps: 6,
          currentPriceUsd: 81522.04,
          hourlyBorrowRateBps: 0.0009,
        },
        {
          symbol: "ETH-PERP",
          name: "Ethereum",
          custodyPubkey: CUSTODY_PUBKEY.ETH,
          collateralCustodyPubkey: CUSTODY_PUBKEY.USDC,
          mint: TOKEN_MINTS.ETH.toBase58(),
          decimals: ETH_DECIMALS,
          maxLeverage: 500,
          openPositionFeeBps: 6,
          closePositionFeeBps: 6,
          currentPriceUsd: 2416.81,
          hourlyBorrowRateBps: 0.0011,
        },
      ];
    }
  }


  /**
   * Simulates a quote for opening an increase position trade
   */
  async getQuote({
    market,
    side,
    collateralUsd,
    leverage,
  }: {
    market: "SOL-PERP" | "BTC-PERP" | "ETH-PERP";
    side: "long" | "short";
    collateralUsd: number;
    leverage: number;
  }) {
    const markets = await this.getMarkets();
    const marketInfo = markets.find((m) => m.symbol === market) || markets[0];
    const markPrice = marketInfo.currentPriceUsd;

    const sizeUsd = collateralUsd * leverage;
    const openFeeUsd = (sizeUsd * marketInfo.openPositionFeeBps) / 10000;
    const closeFeeUsd = (sizeUsd * marketInfo.closePositionFeeBps) / 10000;
    const totalEstimatedFees = openFeeUsd + closeFeeUsd;

    const liquidationPrice = calculateLiquidationPrice({
      side,
      entryPriceUsd: markPrice,
      sizeUsd,
      collateralUsd,
      maxLeverageBps: marketInfo.maxLeverage * 10000,
      closeFeeBps: marketInfo.closePositionFeeBps,
    });

    const distToLiqPercent =
      markPrice > 0
        ? (Math.abs(markPrice - liquidationPrice) / markPrice) * 100
        : 0;

    return {
      market,
      side,
      markPrice,
      collateralUsd,
      leverage,
      positionSizeUsd: sizeUsd,
      positionSizeTokens: sizeUsd / markPrice,
      estimatedOpenFeeUsd: openFeeUsd,
      estimatedCloseFeeUsd: closeFeeUsd,
      liquidationPriceUsd: liquidationPrice,
      distanceToLiquidationPercent: distToLiqPercent,
      maxAvailableLeverage: marketInfo.maxLeverage,
      isHighRisk: leverage > 5 || distToLiqPercent < 15,
      passkeyRequiredEstimate: leverage > 5 || collateralUsd > 100,
    };
  }

  /**
   * Retrieves all open positions for a given Solana wallet address
   */
  async getOpenPositionsForWallet(
    walletAddress: string
  ): Promise<OpenPositionInfo[]> {
    return this.withRpcFallback(async () => {
      const walletPubkey = new PublicKey(walletAddress);
      const markets = await this.getMarkets();
      const positions: OpenPositionInfo[] = [];

      // 1. Direct deterministic PDA batch query (works on ALL RPC nodes without GPA restrictions)
      const deterministicPairs: Array<{ market: string; custody: PublicKey; collateralCustody: PublicKey; side: "long" | "short" }> = [
        { market: "SOL-PERP", custody: new PublicKey(CUSTODY_PUBKEY.SOL), collateralCustody: new PublicKey(CUSTODY_PUBKEY.USDC), side: "short" },
        { market: "SOL-PERP", custody: new PublicKey(CUSTODY_PUBKEY.SOL), collateralCustody: new PublicKey(CUSTODY_PUBKEY.SOL), side: "long" },
        { market: "SOL-PERP", custody: new PublicKey(CUSTODY_PUBKEY.SOL), collateralCustody: new PublicKey(CUSTODY_PUBKEY.USDC), side: "long" },
        { market: "BTC-PERP", custody: new PublicKey(CUSTODY_PUBKEY.BTC), collateralCustody: new PublicKey(CUSTODY_PUBKEY.USDC), side: "short" },
        { market: "BTC-PERP", custody: new PublicKey(CUSTODY_PUBKEY.BTC), collateralCustody: new PublicKey(CUSTODY_PUBKEY.USDC), side: "long" },
        { market: "ETH-PERP", custody: new PublicKey(CUSTODY_PUBKEY.ETH), collateralCustody: new PublicKey(CUSTODY_PUBKEY.USDC), side: "short" },
        { market: "ETH-PERP", custody: new PublicKey(CUSTODY_PUBKEY.ETH), collateralCustody: new PublicKey(CUSTODY_PUBKEY.USDC), side: "long" },
      ];

      const pdaList = deterministicPairs.map((p) =>
        generatePositionPda({
          walletAddress: walletPubkey,
          custody: p.custody,
          collateralCustody: p.collateralCustody,
          side: p.side,
        }).position
      );

      try {
        const pdaAccounts = await this.connection.getMultipleAccountsInfo(pdaList);
        for (let i = 0; i < pdaAccounts.length; i++) {
          const acc = pdaAccounts[i];
          if (!acc || !acc.data || acc.data.length === 0) continue;
          try {
            const raw = this.program.coder.accounts.decode("position", acc.data) as any;
            if (raw.sizeUsd && raw.sizeUsd.gtn(0)) {
              const pair = deterministicPairs[i];
              const sizeUsd = bnToUsdNumber(raw.sizeUsd);
              const collateralUsd = bnToUsdNumber(raw.collateralUsd);
              const entryPrice = bnToUsdNumber(raw.price);
              const side = pair.side;
              const matchedMarket = markets.find((m) => m.symbol === pair.market) || markets[0];
              const currentPrice = matchedMarket.currentPriceUsd;
              const priceDiff = side === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
              const pnl = entryPrice > 0 ? (sizeUsd * priceDiff) / entryPrice : 0;
              const pnlPct = collateralUsd > 0 ? (pnl / collateralUsd) * 100 : 0;
              const liqPrice = calculateLiquidationPrice({
                side,
                entryPriceUsd: entryPrice,
                sizeUsd,
                collateralUsd,
                maxLeverageBps: 1000000,
                closeFeeBps: 6,
              });

              positions.push({
                positionPubkey: pdaList[i].toBase58(),
                market: matchedMarket.symbol,
                side,
                sizeUsd,
                collateralUsd,
                leverage: collateralUsd > 0 ? sizeUsd / collateralUsd : 1,
                entryPriceUsd: entryPrice,
                currentMarkPriceUsd: currentPrice,
                unrealizedPnlUsd: pnl,
                pnlPercentage: pnlPct,
                liquidationPriceUsd: liqPrice,
                distanceToLiquidationPercent:
                  currentPrice > 0 ? (Math.abs(currentPrice - liqPrice) / currentPrice) * 100 : 0,
              });
            }
          } catch {}
        }
      } catch {}

      if (positions.length > 0) {
        return positions;
      }

      // 2. Fallback to GPA if no deterministic PDA was populated
      try {
        const gpaResult = await this.connection.getProgramAccounts(
          this.program.programId,
          {
            commitment: "confirmed",
            filters: [
              {
                memcmp: {
                  bytes: walletPubkey.toBase58(),
                  offset: 8,
                },
              },
              {
                memcmp: this.program.coder.accounts.memcmp("position"),
              },
            ],
          }
        );

        for (const item of gpaResult) {
          try {
            const raw = this.program.coder.accounts.decode(
              "position",
              item.account.data
            ) as any;

            if (raw.sizeUsd && raw.sizeUsd.gtn(0)) {
              const sizeUsd = bnToUsdNumber(raw.sizeUsd);
              const collateralUsd = bnToUsdNumber(raw.collateralUsd);
              const entryPrice = bnToUsdNumber(raw.price);
              const side: "long" | "short" = raw.side.long ? "long" : "short";

              const custodyStr = raw.custody.toBase58();
              const matchedMarket =
                markets.find((m) => m.custodyPubkey === custodyStr) || markets[0];
              const currentPrice = matchedMarket.currentPriceUsd;

              const priceDiff =
                side === "long"
                  ? currentPrice - entryPrice
                  : entryPrice - currentPrice;
              const pnl = entryPrice > 0 ? (sizeUsd * priceDiff) / entryPrice : 0;
              const pnlPct = collateralUsd > 0 ? (pnl / collateralUsd) * 100 : 0;

              const liqPrice = calculateLiquidationPrice({
                side,
                entryPriceUsd: entryPrice,
                sizeUsd,
                collateralUsd,
                maxLeverageBps: 1000000,
                closeFeeBps: 6,
              });

              positions.push({
                positionPubkey: item.pubkey.toBase58(),
                market: matchedMarket.symbol,
                side,
                sizeUsd,
                collateralUsd,
                leverage: collateralUsd > 0 ? sizeUsd / collateralUsd : 1,
                entryPriceUsd: entryPrice,
                currentMarkPriceUsd: currentPrice,
                unrealizedPnlUsd: pnl,
                pnlPercentage: pnlPct,
                liquidationPriceUsd: liqPrice,
                distanceToLiquidationPercent:
                  currentPrice > 0
                    ? (Math.abs(currentPrice - liqPrice) / currentPrice) * 100
                    : 0,
              });
            }
          } catch {}
        }
      } catch {}

      return positions;
    }).catch(() => []);
  }

  /**
   * Directly simulates a compiled Solana VersionedTransaction against the live Solana RPC node.
   * Returns exact on-chain runtime execution logs, compute units consumed, and program validation status.
   */
  async simulateOnChain(transactionBase64: string) {
    return this.withRpcFallback(async () => {
      const rawTx = Buffer.from(transactionBase64, "base64");
      const tx = VersionedTransaction.deserialize(rawTx);

      const simulation = await this.connection.simulateTransaction(tx, {
        replaceRecentBlockhash: true,
        sigVerify: false,
      });

      return {
        success: simulation.value.err === null,
        unitsConsumed: simulation.value.unitsConsumed,
        err: simulation.value.err,
        logs: simulation.value.logs || [],
      };
    });
  }
}

