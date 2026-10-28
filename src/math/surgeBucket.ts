/**
 * LP-claimable surge bucket math (v6.1, T12). Port of
 * `programs/coffer-pool/src/math/surge_bucket.rs`.
 *
 * The surge fee charged on a swap's OUTPUT token goes through the cascade
 * (`feeSplit`); the LP remainder is booked to `surge_fees_owed[token_out]`
 * instead of re-entering the reserves. The bucket is LP capital OUTSIDE the
 * curve: never traded, never priced. The LP token's net asset value per
 * slot is therefore `nav_i = actual_balance_i + surge_fees_owed_i`.
 *
 * * `add_liquidity` prices the join on `nav` and credits
 *   `total_credit_i = ceil(nav_i · ratio)` per leg, of which
 *   `bucket_in_i = floor(surge_i · ratio)` buys into the bucket and the rest
 *   goes to the reserves. A reserve-less slot (`actual_i == 0 < surge_i`)
 *   routes the WHOLE credit to the bucket.
 * * `remove_liquidity` pays `floor(actual_i · burn / supply)` from the
 *   reserves PLUS `floor(surge_i · burn / supply)` from the bucket in one
 *   transfer; the T7 withdraw fee is charged on BOTH parts (each `ceil`).
 *
 * Rounding (audited): the join's total credit rounds UP, its bucket part
 * DOWN (the ceil residue lands in the reserves, never the bucket); every
 * payout rounds DOWN; every fee rounds UP.
 */
import { MathError, ONE, assertU64, assertU128, mulDivDown } from "./fixedPoint";
import { calcDepositCredit } from "./poolMath";
import { applyWithdrawFee } from "./liquidityFee";

/** `actual_balance + surge_fees_owed` for one slot (`MathOverflow` on a corrupted pair). */
export function nav(actual: bigint, surge: bigint): bigint {
  assertU64(actual, "actual balance"); assertU64(surge, "surge bucket");
  const sum = actual + surge;
  if (sum > (1n << 64n) - 1n) throw new MathError("MathOverflow");
  return sum;
}

/** Per-slot NAV for the active prefix (`actual.length == surge.length`). */
export function navBalances(actual: bigint[], surge: bigint[]): bigint[] {
  if (actual.length !== surge.length) throw new MathError("InvalidArrayLength");
  return actual.map((a, i) => nav(a, surge[i]));
}

/** One deposit leg, split between the reserves and the bucket. */
export interface DepositLeg {
  /** `ceil(nav · ratio)` — what the vault must receive (net of any Token-2022 fee); `LiquidityAdded.credited_amounts`. */
  totalCredit: bigint;
  /** Booked to `actual_balance` (`total_credit − bucket_in`); feeds the virtual-balance growth. */
  actualIn: bigint;
  /** Booked to `surge_fees_owed` (`floor(surge · ratio)`, or the whole credit on a reserve-less slot); `LiquidityAdded.surge_buy_in`. */
  bucketIn: bigint;
}

/**
 * `split_deposit_credit(actual, surge, ratio)`: one leg's NAV-based credit
 * (`calc_deposit_credit` on `nav`) split into its reserve and bucket parts.
 * `ratio` is the join ratio in 18-decimal fixed point.
 */
export function splitDepositCredit(actual: bigint, surge: bigint, ratio: bigint): DepositLeg {
  assertU128(ratio, "ratio");
  const totalCredit = calcDepositCredit(nav(actual, surge), ratio);
  const bucketIn = actual === 0n ? totalCredit : assertU64(mulDivDown(surge, ratio, ONE), "bucket buy-in");
  const actualIn = totalCredit - bucketIn;
  if (actualIn < 0n) throw new MathError("MathUnderflow");
  return { totalCredit, actualIn, bucketIn };
}

/** One exit leg: the two gross pro-rata parts, the T7 fee on each, and the two net parts (ONE transfer). */
export interface ExitLeg {
  /** `floor(actual · burn / supply)`. */
  actualGross: bigint;
  /** `floor(surge · burn / supply)`. */
  surgeGross: bigint;
  /** `actual_gross − ceil(actual_gross · bps / 1e4)`; leaves `actual_balance` (`LiquidityRemoved.token_amounts`). */
  actualPayout: bigint;
  /** `surge_gross − ceil(surge_gross · bps / 1e4)`; leaves `surge_fees_owed` (`LiquidityRemoved.surge_amounts`). */
  surgePayout: bigint;
  /** Withdraw fee withheld on the reserve part (stays in `actual_balance`). */
  feeActual: bigint;
  /** Withdraw fee withheld on the bucket part (stays in `surge_fees_owed`). */
  feeSurge: bigint;
  /** `actual_payout + surge_payout`: what the vault transfers (before any Token-2022 fee). */
  transferAmount: bigint;
  /** `fee_actual + fee_surge` (`LiquidityRemoved.withdraw_fee_amounts`). */
  feeTotal: bigint;
  /** `actual_gross + surge_gross`. */
  grossTotal: bigint;
}

/**
 * `split_exit_payout(actual_gross, surge_gross, withdraw_fee_bps)`: the T7
 * withdraw fee on BOTH gross parts of one exit leg (each `ceil`), so the
 * bucket cannot be used to dodge the exit fee.
 */
export function splitExitPayout(actualGross: bigint, surgeGross: bigint, withdrawFeeBps: number): ExitLeg {
  const a = applyWithdrawFee(actualGross, withdrawFeeBps);
  const s = applyWithdrawFee(surgeGross, withdrawFeeBps);
  return {
    actualGross,
    surgeGross,
    actualPayout: a.net,
    surgePayout: s.net,
    feeActual: a.fee,
    feeSurge: s.fee,
    transferAmount: a.net + s.net,
    feeTotal: a.fee + s.fee,
    grossTotal: actualGross + surgeGross,
  };
}
