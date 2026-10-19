import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Perpetuals } from "../../idl/jupiter-perpetuals-idl.js";
import {
  CUSTODY_PUBKEY,
  JLP_POOL_ACCOUNT_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM_ID,
  TOKEN_MINTS,
  USDC_DECIMALS,
  SOL_DECIMALS,
} from "./constants.js";
import {
  generatePositionPda,
  generatePositionRequestPda,
  getPerpetualsPda,
} from "./pda.js";

export interface OpenTradeBuildParams {
  owner: PublicKey;
  market: "SOL-PERP" | "BTC-PERP" | "ETH-PERP";
  side: "long" | "short";
  collateralUsd: number;
  leverage: number;
  collateralToken?: "USDC" | "SOL";
  slippageBps?: number;
  recentBlockhash?: string;
}

export interface CloseTradeBuildParams {
  owner: PublicKey;
  positionPubkey: PublicKey;
  desiredReceiveToken?: "USDC" | "SOL";
  recentBlockhash?: string;
}

export class JupiterTradeBuilder {
  public program: Program<Perpetuals>;

  constructor(program: Program<Perpetuals>) {
    this.program = program;
  }

  /**
   * Constructs a VersionedTransaction for opening an increase position trade on Jupiter Perps
   */
  async buildOpenPositionTx({
    owner,
    market,
    side,
    collateralUsd,
    leverage,
    collateralToken = "USDC",
    slippageBps = 50,
    recentBlockhash,
  }: OpenTradeBuildParams) {
    const custodyMap: Record<string, PublicKey> = {
      "SOL-PERP": new PublicKey(CUSTODY_PUBKEY.SOL),
      "BTC-PERP": new PublicKey(CUSTODY_PUBKEY.BTC),
      "ETH-PERP": new PublicKey(CUSTODY_PUBKEY.ETH),
    };

    const custodyPubkey = custodyMap[market] || custodyMap["SOL-PERP"];
    // By default for shorts and USDC longs, collateral is USDC. For native SOL longs, collateral is SOL.
    const collateralMint =
      collateralToken === "SOL" ? TOKEN_MINTS.WSOL : TOKEN_MINTS.USDC;
    const collateralCustodyPubkey =
      collateralToken === "SOL"
        ? new PublicKey(CUSTODY_PUBKEY.SOL)
        : new PublicKey(CUSTODY_PUBKEY.USDC);

    // 1. Generate Position PDA
    const { position: positionPubkey } = generatePositionPda({
      custody: custodyPubkey,
      collateralCustody: collateralCustodyPubkey,
      walletAddress: owner,
      side,
    });

    // 2. Generate Position Request PDA
    const { positionRequest, counter } = generatePositionRequestPda({
      positionPubkey,
      requestChange: "increase",
    });

    // 3. ATAs
    const positionRequestAta = getAssociatedTokenAddressSync(
      collateralMint,
      positionRequest,
      true
    );
    const fundingAccount = getAssociatedTokenAddressSync(collateralMint, owner);

    const preInstructions: TransactionInstruction[] = [];
    const postInstructions: TransactionInstruction[] = [];

    // Scale collateral and size delta:
    // Collateral token delta is in the collateral token's decimals (6 for USDC, 9 for SOL)
    const decimals = collateralToken === "SOL" ? SOL_DECIMALS : USDC_DECIMALS;
    const collateralTokenDelta = new BN(
      Math.floor(collateralUsd * Math.pow(10, decimals))
    );
    // sizeUsdDelta is in USDC decimals (1e6)
    const sizeUsdDelta = new BN(
      Math.floor(collateralUsd * leverage * Math.pow(10, USDC_DECIMALS))
    );

    // 4. Wrap SOL if funding in native SOL
    if (collateralMint.equals(NATIVE_MINT)) {
      preInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          fundingAccount,
          owner,
          NATIVE_MINT
        ),
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: fundingAccount,
          lamports: BigInt(collateralTokenDelta.toString()),
        }),
        createSyncNativeInstruction(fundingAccount)
      );

      postInstructions.push(
        createCloseAccountInstruction(fundingAccount, owner, owner)
      );
    } else {
      // Ensure user's USDC ATA exists
      preInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          fundingAccount,
          owner,
          TOKEN_MINTS.USDC
        )
      );
    }

    // 5. Instruction from Anchor program
    const sideEnum = side === "long" ? { long: {} } : { short: {} };
    const priceSlippage = new BN(slippageBps);

    const increaseIx = await this.program.methods
      .createIncreasePositionMarketRequest({
        counter,
        collateralTokenDelta,
        jupiterMinimumOut: null,
        priceSlippage,
        side: sideEnum as any,
        sizeUsdDelta,
      })
      .accounts({
        owner,
        fundingAccount,
        perpetuals: getPerpetualsPda(),
        pool: JLP_POOL_ACCOUNT_PUBKEY,
        position: positionPubkey,
        positionRequest,
        positionRequestAta,
        custody: custodyPubkey,
        collateralCustody: collateralCustodyPubkey,
        inputMint: collateralMint,
        referral: null,
      } as any)
      .instruction();

    // 6. Compute budget instructions for reliable Solana inclusion
    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ...preInstructions,
      increaseIx,
      ...postInstructions,
    ];

    let blockhash = recentBlockhash;
    if (!blockhash) {
      try {
        const latest = await this.program.provider.connection.getLatestBlockhash("confirmed");
        blockhash = latest.blockhash;
      } catch {
        blockhash = PublicKey.default.toBase58();
      }
    }

    const messageV0 = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    const transactionBase64 = Buffer.from(transaction.serialize()).toString(
      "base64"
    );

    return {
      transaction,
      transactionBase64,
      positionPubkey: positionPubkey.toBase58(),
      positionRequestPubkey: positionRequest.toBase58(),
      counter: counter.toString(),
      collateralTokenDelta: collateralTokenDelta.toString(),
      sizeUsdDelta: sizeUsdDelta.toString(),
      side,
      market,
    };
  }

  /**
   * Constructs a VersionedTransaction for closing or reducing an existing position
   */
  async buildClosePositionTx({
    owner,
    positionPubkey,
    desiredReceiveToken = "USDC",
    recentBlockhash,
  }: CloseTradeBuildParams) {
    const { positionRequest, counter } = generatePositionRequestPda({
      positionPubkey,
      requestChange: "decrease",
    });

    const desiredMint =
      desiredReceiveToken === "SOL" ? TOKEN_MINTS.WSOL : TOKEN_MINTS.USDC;
    const receivingAccount = getAssociatedTokenAddressSync(
      desiredMint,
      owner,
      true
    );
    const positionRequestAta = getAssociatedTokenAddressSync(
      desiredMint,
      positionRequest,
      true
    );

    const preInstructions: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        receivingAccount,
        owner,
        desiredMint
      ),
    ];
    const postInstructions: TransactionInstruction[] = [];

    if (desiredMint.equals(NATIVE_MINT)) {
      postInstructions.push(
        createCloseAccountInstruction(receivingAccount, owner, owner)
      );
    }

    let custody = new PublicKey(CUSTODY_PUBKEY.SOL);
    let collateralCustody = new PublicKey(CUSTODY_PUBKEY.USDC);
    try {
      const posAcc = await this.program.account.position.fetch(positionPubkey);
      if (posAcc && (posAcc as any).custody) {
        custody = (posAcc as any).custody;
      }
      if (posAcc && (posAcc as any).collateralCustody) {
        collateralCustody = (posAcc as any).collateralCustody;
      }
    } catch {
      // Position account not found on-chain or not yet created; use defaults
    }

    const decreaseIx = await this.program.methods
      .createDecreasePositionMarketRequest({
        collateralUsdDelta: new BN(0),
        sizeUsdDelta: new BN(0),
        priceSlippage: new BN(500), // 5% buffer for slippage on market close
        jupiterMinimumOut: null,
        counter,
        entirePosition: true,
      })
      .accounts({
        owner,
        receivingAccount,
        perpetuals: getPerpetualsPda(),
        pool: JLP_POOL_ACCOUNT_PUBKEY,
        position: positionPubkey,
        positionRequest,
        positionRequestAta,
        custody,
        collateralCustody,
        desiredMint,
        referral: null,
      } as any)
      .instruction();

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ...preInstructions,
      decreaseIx,
      ...postInstructions,
    ];

    let blockhash = recentBlockhash;
    if (!blockhash) {
      try {
        const latest = await this.program.provider.connection.getLatestBlockhash("confirmed");
        blockhash = latest.blockhash;
      } catch {
        blockhash = PublicKey.default.toBase58();
      }
    }

    const messageV0 = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    const transactionBase64 = Buffer.from(transaction.serialize()).toString(
      "base64"
    );

    return {
      transaction,
      transactionBase64,
      positionPubkey: positionPubkey.toBase58(),
      positionRequestPubkey: positionRequest.toBase58(),
      counter: counter.toString(),
    };
  }
}
