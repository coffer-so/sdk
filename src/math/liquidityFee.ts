/**
 * Deposit / withdraw fee math (v6.1, T7). Port of
 * `programs/coffer-pool/src/math/liquidity_fee.rs`:
 *
 * ```text
 * fee = ceil(gross · bps / LIQUIDITY_FEE_PRECISION)      (bps ≤ 10_000)
 * net = gross − fee                                        (= floor(gross · (1 − bps/1e4)))
 * ```
 *
 * * `add_liquidity`: `gross` is the LP the proportional join would mint
 *   (`lp_gross`), `net` is what is minted; the tokens are credited in full.
 * * `remove_liquidity`: `gross` is one part of a token's pro-rata payout,
 *   `net` is what leaves the vault; the fee stays where it came from.
 *
 * The fee rounds UP, so `net` rounds DOWN — never in the user's favour. A
 * rate above the cap fails closed (`MathError("LiquidityFeeMaxExceeded")`).
 */
import { LIQUIDITY_FEE_PRECISION, MAX_LIQUIDITY_FEE_BPS } from "../config";
import { MathError, assertU64 } from "./fixedPoint";

export interface LiquidityFeeResult {
  /** `gross − fee`. */
  net: bigint;
  /** `ceil(gross · bps / 1e4)`. */
  fee: bigint;
}

/**
 * `apply_liquidity_fee(gross, bps)` → `(net, fee)`. `net + fee == gross`,
 * `fee == 0` iff `bps == 0 || gross == 0`.
 */
export function applyLiquidityFee(gross: bigint, bps: number): LiquidityFeeResult {
  assertU64(gross, "gross");
  if (!Number.isSafeInteger(bps) || bps < 0) throw new MathError("LiquidityFeeMaxExceeded: invalid rate");
  if (bps > MAX_LIQUIDITY_FEE_BPS) throw new MathError("LiquidityFeeMaxExceeded");
  if (bps === 0 || gross === 0n) return { net: gross, fee: 0n };
  const precision = BigInt(LIQUIDITY_FEE_PRECISION);
  const numerator = gross * BigInt(bps);
  const fee = numerator / precision + (numerator % precision === 0n ? 0n : 1n);
  const net = gross - fee;
  if (net < 0n) throw new MathError("MathUnderflow");
  return { net, fee };
}

/** Deposit side: `{ net: lp_minted, fee: deposit_fee_lp }` from the join's gross LP. */
export function applyDepositFee(lpGross: bigint, depositFeeBps: number): LiquidityFeeResult {
  return applyLiquidityFee(lpGross, depositFeeBps);
}

/** Withdraw side: `{ net: payout, fee: withdraw_fee }` for one gross payout part. */
export function applyWithdrawFee(grossPayout: bigint, withdrawFeeBps: number): LiquidityFeeResult {
  return applyLiquidityFee(grossPayout, withdrawFeeBps);
}

/**
 * `lp_burn_net_of_withdraw_fee`: `burn − ceil(burn · bps / 1e4)`. Used only
 * to scale a SIDELINED slot's virtual balance on `remove_liquidity`, so it
 * shrinks by the same `(supply − burn_net) / supply` factor the live legs
 * shrink by from their NET payouts.
 */
export function lpBurnNetOfWithdrawFee(effectiveLpBurn: bigint, withdrawFeeBps: number): bigint {
  return applyLiquidityFee(effectiveLpBurn, withdrawFeeBps).net;
}
