import { SLIPPAGE_PRECISION } from "../config";
import { assertInteger, assertU64, MathError, ONE } from "./fixedPoint";
import { calcJoinRatioAndLp, calcDepositCredit } from "./poolMath";

/** Deposit rounding rejection from the proposed contract bound or caller policy. */
export class DepositRoundingLossError extends Error {
  constructor(readonly tokenIndex: number, readonly maxLossHundredthsBps: number, readonly onchainBound = false) {
    super(onchainBound
      ? `DepositRoundingLossTooLarge (6110): token ${tokenIndex}'s credit exceeds ceil(NAV * gross LP / supply) + floor(fair / 1000) + 1; increase or align the deposit to whole raw LP units`
      : `DepositRoundingLoss: token ${tokenIndex}'s credited NAV buys too little LP for the ${maxLossHundredthsBps} hundredths-bps rounding-loss limit; increase the deposit or explicitly review a higher slippage tolerance`);
    this.name = "DepositRoundingLossError";
  }
}

/** Proposed F-02 contract rule. D6 owner ratification remains pending. */
export function checkDepositRounding(nav: bigint, credit: bigint, lpGross: bigint, supply: bigint, tokenIndex = 0): void {
  assertU64(nav, "NAV"); assertU64(credit, "deposit credit");
  assertU64(lpGross, "gross LP"); assertU64(supply, "LP supply");
  if (supply === 0n) throw new MathError("InvalidLpAmount");
  const product = nav * lpGross;
  const fair = product / supply + (product % supply === 0n ? 0n : 1n);
  if (credit > fair + fair / 1_000n + 1n) throw new DepositRoundingLossError(tokenIndex, 1_000, true);
}

/** Net per-leg ceilings for at least targetLp gross LP, before transfer fees.
 * A fresh quote must validate the complete state, fees and resulting mint.
 */
export function sizeDepositForLp(navBalances: bigint[], targetLp: bigint, supply: bigint): bigint[] {
  assertU64(targetLp, "target LP"); assertU64(supply, "LP supply");
  if (targetLp === 0n || supply === 0n) throw new MathError("InvalidLpAmount");
  const ceilings = navBalances.map(nav => {
    assertU64(nav, "NAV");
    if (nav === 0n) return 0n;
    const product = nav * targetLp;
    const increment = nav / ONE + (nav % ONE === 0n ? 0n : 1n);
    return assertU64(product / supply + (product % supply === 0n ? 0n : 1n) + increment, "deposit ceiling");
  });
  const { lp, ratio } = calcJoinRatioAndLp(navBalances, ceilings, supply);
  if (lp < targetLp) throw new MathError("DepositLpTargetNotReached");
  assertU64(supply + lp, "resulting gross LP supply");
  navBalances.forEach((nav,i) => {
    const credit = calcDepositCredit(nav,ratio);
    if (credit > ceilings[i]) throw new MathError("DepositCreditExceedsCeiling");
    checkDepositRounding(nav,credit,lp,supply,i);
  });
  return ceilings;
}

/**
 * Refuse a join whose gross LP represents less than (1 - tolerance) of
 * any credited leg at its pre-join NAV price. Exact cross-products include
 * BOTH the LP floor and token-credit ceiling, without a supply cutoff or
 * token-price oracle. Deposit fees and Token-2022 fees remain separate,
 * explicitly quoted costs. The proposed on-chain bound is checked first;
 * caller policy may be stricter and cannot relax that bound.
 */
export function assertDepositRoundingLoss(
  navBalances: bigint[], creditedAmounts: bigint[], supply: bigint,
  lpGross: bigint, maxLossHundredthsBps: number
): void {
  assertInteger(maxLossHundredthsBps, 0, SLIPPAGE_PRECISION, "slippage");
  assertU64(supply, "LP supply"); assertU64(lpGross, "gross LP");
  if (supply === 0n || lpGross === 0n) throw new MathError("InvalidLpAmount");
  if (navBalances.length !== creditedAmounts.length) throw new MathError("InvalidArrayLength");
  const precision = BigInt(SLIPPAGE_PRECISION);
  const retained = precision - BigInt(maxLossHundredthsBps);
  navBalances.forEach((nav, i) => {
    const credit = creditedAmounts[i];
    assertU64(nav, "NAV"); assertU64(credit, "deposit credit");
    if ((nav > 0n) !== (credit > 0n)) throw new MathError("TokenLivenessMismatch");
    checkDepositRounding(nav, credit, lpGross, supply, i);
    if (lpGross * nav * precision < credit * supply * retained) {
      throw new DepositRoundingLossError(i, maxLossHundredthsBps);
    }
  });
}
