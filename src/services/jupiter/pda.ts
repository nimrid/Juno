import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import {
  JLP_POOL_ACCOUNT_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM_ID,
} from "./constants.js";

/**
 * Derives the PDA for a user's position request (increase or decrease).
 * Once submitted on-chain, Jupiter keepers fulfill this request.
 */
export function generatePositionRequestPda({
  counter,
  positionPubkey,
  requestChange,
}: {
  counter?: BN;
  positionPubkey: PublicKey;
  requestChange: "increase" | "decrease";
}) {
  if (!counter) {
    counter = new BN(Math.floor(Math.random() * 1_000_000_000));
  }

  const requestChangeEnum = requestChange === "increase" ? [1] : [2];
  const [positionRequest, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position_request"),
      positionPubkey.toBuffer(),
      counter.toArrayLike(Buffer, "le", 8),
      Buffer.from(requestChangeEnum),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID
  );

  return { positionRequest, counter, bump };
}

/**
 * Derives the unique Position PDA for a user and market.
 */
export function generatePositionPda({
  custody,
  collateralCustody,
  walletAddress,
  side,
}: {
  custody: PublicKey;
  collateralCustody: PublicKey;
  walletAddress: PublicKey;
  side: "long" | "short";
}) {
  const [position, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      walletAddress.toBuffer(),
      JLP_POOL_ACCOUNT_PUBKEY.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
      Buffer.from(side === "long" ? [1] : [2]),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID
  );

  return { position, bump };
}

/**
 * Derives the perpetuals master PDA.
 */
export function getPerpetualsPda(): PublicKey {
  const [perpetuals] = PublicKey.findProgramAddressSync(
    [Buffer.from("perpetuals")],
    JUPITER_PERPETUALS_PROGRAM_ID
  );
  return perpetuals;
}
