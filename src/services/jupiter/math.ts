import BN from "bn.js";
import { BPS_POWER, RATE_POWER, USDC_DECIMALS } from "./constants.js";

/**
 * Division with ceiling rounding for BNs
 */
export const divCeil = (a: BN, b: BN): BN => {
  const dm = a.divmod(b);
  if (dm.mod.isZero()) return dm.div;
  return dm.div.ltn(0) ? dm.div.isubn(1) : dm.div.iaddn(1);
};

/**
 * Formats BN scaled values to human-readable numbers/USD strings
 */
export function bnToUsdNumber(value: BN, decimals: number = USDC_DECIMALS): number {
  const str = value.toString();
  const negative = str.startsWith("-");
  const absStr = negative ? str.slice(1) : str;
  const num = Number(absStr) / Math.pow(10, decimals);
  return negative ? -num : num;
}

export function formatUsd(val: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

/**
 * Calculates liquidation price given position, fees, and leverage parameters.
 */
export function calculateLiquidationPrice({
  side,
  entryPriceUsd,
  sizeUsd,
  collateralUsd,
  maxLeverageBps,
  closeFeeBps,
}: {
  side: "long" | "short";
  entryPriceUsd: number;
  sizeUsd: number;
  collateralUsd: number;
  maxLeverageBps: number; // e.g. 100000 = 100x, or 20000 = 20x
  closeFeeBps: number;
}): number {
  if (sizeUsd <= 0 || entryPriceUsd <= 0) return 0;

  const totalFeeUsd = (sizeUsd * closeFeeBps) / 10000;
  // Maximum allowed loss before liquidation threshold
  const maxLossUsd = (sizeUsd * 10000) / maxLeverageBps + totalFeeUsd;
  const maxPriceDiff = (Math.abs(maxLossUsd - collateralUsd) * entryPriceUsd) / sizeUsd;

  if (side === "long") {
    return maxLossUsd > collateralUsd
      ? entryPriceUsd + maxPriceDiff
      : Math.max(0, entryPriceUsd - maxPriceDiff);
  } else {
    return maxLossUsd > collateralUsd
      ? Math.max(0, entryPriceUsd - maxPriceDiff)
      : entryPriceUsd + maxPriceDiff;
  }
}
