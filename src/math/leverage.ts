/**
 * leverage — v6.1 (T22) strict leverage invariant, mirrored from
 * `programs/coffer-pool/src/math/pool_math.rs` (`PoolMath::check_leverage`),
 * `constants.rs` (`min_virtual_balance`), `seed_liquidity.rs`
 * (`check_seed_leverage`), `fund_sidelined_token.rs` (`check_fund_leverage`)
 * and `rescale_virtual_balances.rs` (`apply_rescale`).
 *
 * The rule: `virtual_balance[i] > actual_balance[i]` for every slot
 * `i < token_count` (a sidelined slot with `A = 0` needs `V ≥ 1`). The program
 * checks it after every balance write (swap, add, seed, fund, remove, range
 * manager, rescale) and BEFORE any CPI, so a quote that would leave a slot at
 * `V ≤ A` is a quote the program rejects with `VirtualBalanceNotAboveActual`
 * (6104). Where a virtual balance is CHOSEN (`initialize_pool`,
 * `range_manager_update`, `rescale_virtual_balances`) it must also meet the
 * per-slot floor `max(10^decimals, 1_000)` raw (`VirtualBalanceBelowFloor`,
 * 6105); the floor is NOT a post-guard on trades (migrated pools below it are
 * grandfathered).
 *
 * Why strict: a deposit grows a live leg by `ceil(V · c / A)`; at `V ≤ A`
 * every dust deposit adds a full raw unit of `V` (a 100 % error per unit —
 * the HR-01 price-skew extraction); at `V > A` the error is `< 1 / V_raw`
 * relative and the floor bounds it.
 */
import { MAX_TOKEN_DECIMALS, MIN_VIRTUAL_BALANCE_ABS, MIN_VIRTUAL_RESCALE_MULTIPLIER } from "../config";
import { MathError, U64_MAX, assertU64 } from "./fixedPoint";

/** `PoolMath::check_leverage`: throws `MathError("VirtualBalanceNotAboveActual")` unless `V > A`. */
export function checkLeverage(virtualBalance: bigint, actualBalance: bigint): void {
  assertU64(virtualBalance, "virtual balance"); assertU64(actualBalance, "actual balance");
  if (!(virtualBalance > actualBalance)) throw new MathError("VirtualBalanceNotAboveActual");
}

/** `V > A` as a boolean (no throw). */
export function leverageHolds(virtualBalance: bigint, actualBalance: bigint): boolean {
  return virtualBalance > actualBalance;
}

/** Indices `i < tokenCount` whose slot violates `V > A` (`[]` on a compliant pool). */
export function leverageViolations(virtualBalances: readonly bigint[], actualBalances: readonly bigint[], tokenCount = virtualBalances.length): number[] {
  if (actualBalances.length < tokenCount || virtualBalances.length < tokenCount) throw new MathError("InvalidArrayLength");
  const out: number[] = [];
  for (let i = 0; i < tokenCount; i++) if (!leverageHolds(virtualBalances[i], actualBalances[i])) out.push(i);
  return out;
}

/** `CofferPool::assert_leverage_invariant`: every slot `i < tokenCount` holds `V > A`. */
export function assertLeverageInvariant(virtualBalances: readonly bigint[], actualBalances: readonly bigint[], tokenCount = virtualBalances.length): void {
  if (leverageViolations(virtualBalances, actualBalances, tokenCount).length) throw new MathError("VirtualBalanceNotAboveActual");
}

/**
 * `constants::min_virtual_balance(decimals)` = `max(10^decimals, 1_000)` raw,
 * `decimals` clamped at `MAX_TOKEN_DECIMALS` (18) so it fits `u64`.
 */
export function minVirtualBalance(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) throw new MathError("InvalidTokenDecimals");
  const d = decimals > MAX_TOKEN_DECIMALS ? MAX_TOKEN_DECIMALS : decimals;
  const oneToken = 10n ** BigInt(d);
  return oneToken > MIN_VIRTUAL_BALANCE_ABS ? oneToken : MIN_VIRTUAL_BALANCE_ABS;
}

/** Indices `i < tokenCount` whose `V` is below `minVirtualBalance(decimals[i])`. */
export function virtualFloorViolations(virtualBalances: readonly bigint[], decimals: readonly number[], tokenCount = virtualBalances.length): number[] {
  if (decimals.length < tokenCount || virtualBalances.length < tokenCount) throw new MathError("InvalidArrayLength");
  const out: number[] = [];
  for (let i = 0; i < tokenCount; i++) if (virtualBalances[i] < minVirtualBalance(decimals[i])) out.push(i);
  return out;
}

/** `CofferPool::assert_virtual_floor`: every slot `i < tokenCount` holds `V ≥ minVirtualBalance(decimals[i])`. */
export function assertVirtualFloor(virtualBalances: readonly bigint[], decimals: readonly number[], tokenCount = virtualBalances.length): void {
  if (virtualFloorViolations(virtualBalances, decimals, tokenCount).length) throw new MathError("VirtualBalanceBelowFloor");
}

/**
 * `seed_liquidity::check_seed_leverage`: the seed books `actual_i = net_i`
 * against the creator's `virtual_i`, so every slot needs `net_i < virtual_i`
 * (a sidelined slot with `net = 0` passes for any `V > 0`). Runs on the
 * NET amounts (after Token-2022 fee netting), before any transfer.
 */
export function checkSeedLeverage(virtualBalances: readonly bigint[], netAmounts: readonly bigint[]): void {
  if (virtualBalances.length !== netAmounts.length) throw new MathError("InvalidArrayLength");
  for (let i = 0; i < virtualBalances.length; i++) checkLeverage(virtualBalances[i], netAmounts[i]);
}

/** `fund_sidelined_token::check_fund_leverage`: the funded slot books `actual = net`, so `net < virtual`. */
export function checkFundLeverage(virtualBalance: bigint, netAmount: bigint): void {
  checkLeverage(virtualBalance, netAmount);
}

export interface RescaleResult {
  /** `V_i · multiplier` per slot. */
  newVirtualBalances: bigint[];
  /** Slots that violated `V > A` BEFORE the rescale (what the repair fixes). */
  repairedSlots: number[];
}

/**
 * `rescale_virtual_balances::apply_rescale`: `multiplier ≥ 2`
 * (`InvalidVirtualRescale`), every `V_i · multiplier` checked
 * (`MathOverflow`; `V_i = 0` is `InvalidVirtualBalances`), then the result
 * must satisfy the strict invariant and — when `decimals` are given — the
 * per-slot floor. Price-neutral: `V_i' · V_j = V_i · V_j'`. The sell-off
 * window snapshots rescale with the same ratio on chain (not modelled here).
 */
export function applyRescale(
  virtualBalances: readonly bigint[],
  actualBalances: readonly bigint[],
  multiplier: bigint,
  decimals?: readonly number[],
): RescaleResult {
  assertU64(multiplier, "multiplier");
  if (multiplier < MIN_VIRTUAL_RESCALE_MULTIPLIER) throw new MathError("InvalidVirtualRescale");
  const n = virtualBalances.length;
  if (actualBalances.length !== n || (decimals && decimals.length !== n)) throw new MathError("InvalidArrayLength");
  const repairedSlots = leverageViolations(virtualBalances, actualBalances);
  const newVirtualBalances: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const old = assertU64(virtualBalances[i], "virtual balance");
    if (old === 0n) throw new MathError("InvalidVirtualBalances");
    const next = old * multiplier;
    if (next > U64_MAX) throw new MathError("MathOverflow");
    newVirtualBalances.push(next);
  }
  assertLeverageInvariant(newVirtualBalances, actualBalances);
  if (decimals) assertVirtualFloor(newVirtualBalances, decimals);
  return { newVirtualBalances, repairedSlots };
}

/**
 * Smallest multiplier `m ≥ 2` that repairs every slot (`V_i · m > A_i`) and,
 * with `decimals`, meets every floor; `null` when no `u64` multiplier does
 * (a slot with `V = 0`, or the product would overflow). The runbook's
 * `CME49e5C…` repair is `1e9`; this helper gives the lower bound, callers
 * usually round up to a power of ten.
 */
export function minRescaleMultiplier(virtualBalances: readonly bigint[], actualBalances: readonly bigint[], decimals?: readonly number[]): bigint | null {
  const n = virtualBalances.length;
  if (actualBalances.length !== n || (decimals && decimals.length !== n)) throw new MathError("InvalidArrayLength");
  let m = MIN_VIRTUAL_RESCALE_MULTIPLIER;
  for (let i = 0; i < n; i++) {
    const v = virtualBalances[i];
    if (v <= 0n) return null;
    const needLeverage = actualBalances[i] / v + 1n; // smallest m with v·m > a
    const floor = decimals ? minVirtualBalance(decimals[i]) : 0n;
    const needFloor = floor > 0n ? (floor + v - 1n) / v : 0n; // ceil(floor / v)
    const need = needLeverage > needFloor ? needLeverage : needFloor;
    if (need > m) m = need;
  }
  for (let i = 0; i < n; i++) if (virtualBalances[i] * m > U64_MAX) return null;
  return m;
}
