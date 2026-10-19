import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const JUPITER_PERPETUALS_PROGRAM_ID = new PublicKey(
  "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu"
);

export const JUPITER_PERPETUALS_EVENT_AUTHORITY_PUBKEY = new PublicKey(
  "37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN"
);

export const JLP_POOL_ACCOUNT_PUBKEY = new PublicKey(
  "5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq"
);

export const JLP_MINT_PUBKEY = new PublicKey(
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"
);

export const DOVES_PROGRAM_ID = new PublicKey(
  "DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e"
);

// Known Custody Accounts on Solana Mainnet
export enum CUSTODY_PUBKEY {
  SOL = "7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz",
  ETH = "AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn",
  BTC = "5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm",
  USDC = "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa",
  USDT = "4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk",
}

// Token Mints
export const TOKEN_MINTS = {
  SOL: new PublicKey("So11111111111111111111111111111111111111112"),
  WSOL: new PublicKey("So11111111111111111111111111111111111111112"),
  USDC: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  BTC: new PublicKey("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"), // WBTC
  ETH: new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"), // WETH
  USDT: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
};

export const CUSTODY_PUBKEYS = [
  new PublicKey(CUSTODY_PUBKEY.SOL),
  new PublicKey(CUSTODY_PUBKEY.BTC),
  new PublicKey(CUSTODY_PUBKEY.ETH),
  new PublicKey(CUSTODY_PUBKEY.USDC),
  new PublicKey(CUSTODY_PUBKEY.USDT),
];

export const USDC_DECIMALS = 6;
export const SOL_DECIMALS = 9;
export const BTC_DECIMALS = 8;
export const ETH_DECIMALS = 8;

export const BPS_POWER = new BN(10_000);
export const DBPS_POWER = new BN(100_000);
export const RATE_POWER = new BN(1_000_000_000);
export const DEBT_POWER = RATE_POWER;
export const BORROW_SIZE_PRECISION = new BN(1000);
export const JLP_DECIMALS = 6;
