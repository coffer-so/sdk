import { complement, divDown, divUp, mulDown, ONE, weightToFp, assertU64, assertU128, ceilDiv, MathError } from "./fixedPoint";
import { MIN_LP_SUPPLY } from "../config";
import { powFp } from "./logExp";

/**
 * Port of `PoolMath::calc_out_given_in` from
 * `contracts/programs/coffer-pool/src/math/pool_math.rs`.
 *
 * Formula:   aO = bO * (1 - (bI / (bI + aI))^(wI / wO))
 *
 * Inputs are u64 raw amounts (bigint here to avoid overflow). Decimals
 * cancel in the ratio bI/(bI+aI), so no scaling needed.
 */
export function calcOutGivenIn(params: {
  virtualBalanceIn: bigint;
  weightInBps: bigint;
  virtualBalanceOut: bigint;
  weightOutBps: bigint;
  amountIn: bigint;
  actualBalanceOut: bigint;
}): bigint {
  const { virtualBalanceIn, weightInBps, virtualBalanceOut, weightOutBps, amountIn, actualBalanceOut } =
    params;
  [virtualBalanceIn, weightInBps, virtualBalanceOut, weightOutBps, amountIn, actualBalanceOut].forEach((v) => assertU64(v));
  const denom = assertU128(virtualBalanceIn + amountIn);
  const base = divUp(virtualBalanceIn, denom);
  const exp = divDown(weightToFp(weightInBps), weightToFp(weightOutBps));
  // v6: for equal positive weights `base^1` is exactly `base`; the program
  // skips ln/exp there, so raw quotes differ from v5 at rounding boundaries.
  // Unequal weights keep the fixed-point power path bit for bit.
  let power = weightInBps > 0n && weightInBps === weightOutBps ? base : powFp(base, exp);
  // Match Rust's +1 bias + clamp to ONE.
  power = power + 1n;
  if (power > ONE) power = ONE;
  const comp = complement(power);
  const out = mulDown(virtualBalanceOut, comp);
  if (out > actualBalanceOut) {
    throw new MathError("AmountOutExceedsBalance");
  }
  return assertU64(out);
}

/**
 * Port of `PoolMath::calc_lp_out_given_exact_tokens_in`: the limiting
 * ratio `min(amount_i / actual_i)` over live legs (18-decimal fixed point)
 * and the floor-rounded LP it mints. The ratio is what `calcDepositCredit`
 * sizes each leg's real debit from, so callers that go on to credit the
 * pool need both.
 */
export function calcJoinRatioAndLp(
  actualBalances: bigint[],
  amountsIn: bigint[],
  lpTotalSupply: bigint
): { lp: bigint; ratio: bigint } {
  if (actualBalances.length !== amountsIn.length) {
    throw new MathError("InvalidArrayLength");
  }
  assertU64(lpTotalSupply); actualBalances.forEach((v) => assertU64(v)); amountsIn.forEach((v) => assertU64(v));
  let ratioMin: bigint | null = null;
  for (let i = 0; i < actualBalances.length; i++) {
    if (actualBalances[i] === 0n) continue;
    const ratio = divDown(amountsIn[i], actualBalances[i]);
    ratioMin = ratioMin === null || ratio < ratioMin ? ratio : ratioMin;
  }
  if (ratioMin === null) throw new MathError("PoolNotSeeded");
  return { lp: assertU64(assertU128(lpTotalSupply * ratioMin) / ONE, "lp out"), ratio: ratioMin };
}

/** Proportional join: `lp = total_supply * min(amount_i / actual_balance_i)` across live legs. */
export function calcLpOutGivenExactTokensIn(
  actualBalances: bigint[],
  amountsIn: bigint[],
  lpTotalSupply: bigint
): bigint {
  return calcJoinRatioAndLp(actualBalances, amountsIn, lpTotalSupply).lp;
}

/**
 * Port of `PoolMath::calc_tokens_out_given_lp_in`. Proportional exit.
 */
export function calcTokensOutGivenLpIn(
  actualBalances: bigint[],
  lpAmount: bigint,
  lpTotalSupply: bigint
): bigint[] {
  assertU64(lpAmount); assertU64(lpTotalSupply); actualBalances.forEach((v) => assertU64(v));
  if (lpTotalSupply === 0n) throw new MathError("InvalidLpAmount");
  const ratio = divDown(lpAmount, lpTotalSupply);
  return actualBalances.map((bal) => assertU64(mulDown(bal, ratio)));
}

/**
 * Spot amount-out: aO = aI * (bO * wI) / (bI * wO). Always ≥
 * `calcOutGivenIn` for the same inputs (curve slippage drags the real
 * value below spot). Useful for UI "price impact" calculations.
 */
export function calcSpotOut(params: {
  virtualBalanceIn: bigint;
  weightInBps: bigint;
  virtualBalanceOut: bigint;
  weightOutBps: bigint;
  amountIn: bigint;
}): bigint {
  const { virtualBalanceIn, weightInBps, virtualBalanceOut, weightOutBps, amountIn } = params;
  if (virtualBalanceIn === 0n || weightOutBps === 0n) return 0n;
  return (amountIn * virtualBalanceOut * weightInBps) / (virtualBalanceIn * weightOutBps);
}

// ── v6 liquidity rounding (pool_math.rs) ───────────────────────────────

/**
 * `calc_deposit_credit`: credit the pool with `ceil(actual · ratio / ONE)`.
 * Paired with the floor-rounded LP mint so no live leg's backing per LP
 * decreases; the credit still fits under the integer net ceiling that
 * produced `ratio`.
 */
export function calcDepositCredit(actual: bigint, ratioMin: bigint): bigint {
  assertU64(actual); assertU128(ratioMin);
  return assertU64(ceilDiv(assertU128(actual * ratioMin), ONE), "deposit credit");
}

/**
 * `virtual_balance_after_deposit`: a live leg grows from its realized net
 * credit, `ceil(V · (A + c) / A)`; a sidelined leg (`A == 0`, no credit)
 * follows the LP supply growth instead.
 */
export function virtualBalanceAfterDeposit(virtualBalance: bigint, actualBalance: bigint, creditedAmount: bigint, lpMinted: bigint, lpSupply: bigint): bigint {
  [virtualBalance, actualBalance, creditedAmount, lpMinted, lpSupply].forEach((v) => assertU64(v));
  if (virtualBalance === 0n) throw new MathError("InvalidVirtualBalances");
  if (lpSupply === 0n) throw new MathError("InvalidLpAmount");
  assertU64(lpSupply + lpMinted, "lp supply");
  assertU64(actualBalance + creditedAmount, "actual balance");
  let numerator: bigint, denominator: bigint;
  if (actualBalance > 0n) {
    numerator = creditedAmount; denominator = actualBalance;
  } else {
    if (creditedAmount !== 0n) throw new MathError("TokenLivenessMismatch");
    numerator = lpMinted; denominator = lpSupply;
  }
  const increase = ceilDiv(virtualBalance * numerator, denominator);
  return assertU64(virtualBalance + increase, "virtual balance");
}

/**
 * `virtual_balance_after_withdrawal`: a live leg shrinks from the gross
 * vault payout, `floor(V · (A − payout) / A)`, normalised (v6.1, T22) to
 * `max(that, (A − payout) + 1)` so the leg keeps `V' > A'` (the floor
 * reaches equality iff `(V − A)(A − payout) < A`); a sidelined leg follows
 * the remaining LP supply, `max(1, ·)`. The floor pairs with the deposit
 * ceiling so a free join/exit round trip cannot ratchet `V` upward (20
 * exit→deposit cycles from `V = 101, A = 100` end at `V = 102`).
 */
export function virtualBalanceAfterWithdrawal(virtualBalance: bigint, actualBalance: bigint, grossPayout: bigint, lpBurned: bigint, lpSupply: bigint): bigint {
  [virtualBalance, actualBalance, grossPayout, lpBurned, lpSupply].forEach((v) => assertU64(v));
  if (virtualBalance === 0n) throw new MathError("InvalidVirtualBalances");
  if (lpSupply === 0n || lpBurned >= lpSupply) throw new MathError("InvalidLpAmount");
  if (grossPayout > actualBalance) throw new MathError("MathUnderflow");
  const remaining = actualBalance - grossPayout;
  let numerator: bigint, denominator: bigint;
  if (actualBalance > 0n) {
    if (remaining === 0n) throw new MathError("InvalidAmounts");
    numerator = remaining; denominator = actualBalance;
  } else {
    numerator = lpSupply - lpBurned; denominator = lpSupply;
  }
  const next = (virtualBalance * numerator) / denominator;
  if (actualBalance > 0n) {
    // T22 normalisation: `remaining < A ≤ u64::MAX`, so `remaining + 1` fits.
    const floorStrict = remaining + 1n;
    return next > floorStrict ? next : floorStrict;
  }
  return next > 1n ? next : 1n;
}

/** `calc_effective_lp_burn`: honour the caller's ceiling while keeping `MIN_LP_SUPPLY` in supply. */
export function calcEffectiveLpBurn(requested: bigint, supply: bigint): bigint {
  assertU64(requested); assertU64(supply);
  if (requested === 0n || requested > supply) throw new MathError("InvalidLpAmount");
  const maxBurnable = supply > MIN_LP_SUPPLY ? supply - MIN_LP_SUPPLY : 0n;
  if (maxBurnable === 0n) throw new MathError("InvalidLpAmount");
  return requested < maxBurnable ? requested : maxBurnable;
}
