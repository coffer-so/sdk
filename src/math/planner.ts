/**
 * TypeScript port of the v6.1 single-token-liquidity planner
 * (`contracts/programs/single-token-liquidity/src/planner.rs`), the host-side
 * search the program itself does not run.
 *
 * A v6 zap is `deposit_single_token_planned`: the user signs a plan — the
 * gross input to spend on each swap leg (`allocations`, summing to the
 * input), a hash of the pool/mint state it was computed on and an expiry.
 * The program only VERIFIES the plan (budget, hash, age ≤ 90 s, slot) and
 * executes swaps + one proportional join with the user's own accounts. This
 * module picks `allocations`: it replays candidates on the exact integer
 * math of the program (`swapSim`, `poolMath`, `surgeBucket`,
 * `liquidityFee`, `maxSelloff`, `surgeFee`, `transferFee`) and bisects on
 * the post-swap join ratio until every live leg can be joined at the same
 * ratio with the most LP.
 *
 * v6.1: the swap legs run the T15/T14 fee cascade (creator share, surge
 * split; the LP surge share lands in the output slot's bucket); the join is
 * priced on NAV (`actual + surge_fees_owed`, T12) and buys into the bucket;
 * the deposit fee (T7) is applied so `lp` is the NET mint; a dynamic-fee
 * hook's rate (T9) may be supplied as `hookFeeOverride`.
 *
 * Every function is pure; `QuotePool` is copied on write. Program-equivalent
 * failures are `MathError` (checked arithmetic / coffer-pool errors) or
 * `SimError` (STLD errors) and are the search's control flow: a candidate
 * that fails is infeasible, never a bug. Anything else propagates.
 */
import { ONE, MathError, assertU64 } from "./fixedPoint";
import { withPowMemo } from "./logExp";
import { effectiveSwapFeeRate, simulateSwap, SwapLeg } from "./swapSim";
import { checkLeverage } from "./leverage";
import { calcJoinRatioAndLp, virtualBalanceAfterDeposit } from "./poolMath";
import { rescaleWindowOnVbChange } from "./maxSelloff";
import { grossOfTransferFee, netOfTransferFee } from "./transferFee";
import { computeAllocations } from "./singleToken";
import { nav, splitDepositCredit } from "./surgeBucket";
import { applyDepositFee } from "./liquidityFee";

/** STLD-program failure (`StldError` name) raised by the planner's checks. */
export class SimError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "SimError";
  }
}

/** `true` for the failures the search treats as "candidate infeasible". */
export function isSimFailure(e: unknown): boolean {
  return e instanceof MathError || e instanceof SimError;
}

/** Pool snapshot the planner works on (`planner.rs::QuotePool`). */
export interface QuotePool {
  /**
   * Live slots only (`token_count` entries), each with its epoch fee
   * schedule and (v6.1) its `creatorFeesOwed` / `surgeFeesOwed` buckets
   * (`undefined` = 0).
   */
  tokens: SwapLeg[];
  lpSupply: bigint;
  swapFeeRate: number;
  protocolFeeRate: number;
  /** v6.1 (T14): `pool.creator_fee_bps`, replayed on both fees (default 0). */
  creatorFeeBps?: number;
  /** v6.1 (T7): `pool.deposit_fee_bps` — the zap's final join is an `add_liquidity` (default 0). */
  depositFeeBps?: number;
  /**
   * v6.1 (T9): the swap fee rate a `DYNAMIC_FEE` hook will apply to the
   * zap's legs, if the client learned it (simulate a `swap` and read
   * `Swap.effective_fee_rate`, or replicate the hook's rule off chain).
   * `undefined` ⇒ `swapFeeRate`. Clamped into `[hookFeeMin, hookFeeMax]`
   * like the program; every leg of one zap gets the same rate.
   */
  hookFeeOverride?: number;
  hookFeeMin?: number;
  hookFeeMax?: number;
  /** Clock seconds the route executes at (window decay). */
  now: bigint;
}

export interface PlannerSwapQuote {
  input: number;
  output: number;
  /** Plan allocation: gross input the user is debited. */
  grossInput: bigint;
  /** After the input mint's transfer fee. */
  netInput: bigint;
  baseFee: bigint;
  protocolFee: bigint;
  /** v6.1 (T14): pool admin's share of `baseFee`, booked to `creator_fees_owed[input]`. */
  creatorFee: bigint;
  /** Curve output before surge. */
  rawOutput: bigint;
  surgeFee: bigint;
  /** v6.1 (T15): protocol share of `surgeFee`. */
  surgeProtocolFee: bigint;
  /** v6.1 (T14): pool admin's share of `surgeFee`, booked to `creator_fees_owed[output]`. */
  surgeCreatorFee: bigint;
  /** v6.1 (T12): LP holders' share of `surgeFee`, booked to `surge_fees_owed[output]`. */
  surgeLpFee: bigint;
  /** Vault debit (`rawOutput − surgeFee`). */
  grossOutput: bigint;
  /** What the user's account receives after the output mint's transfer fee. */
  netOutput: bigint;
  /** v6.1 (T9): the rate the cascade ran on. */
  effectiveFeeRate: number;
}

export interface ZapQuote {
  allocations: bigint[];
  swaps: PlannerSwapQuote[];
  /** Per token, what the user holds for the join: the reserved input, or a leg's `netOutput`. */
  available: bigint[];
  /** Per token, the join's gross debit (`credit` grossed up by the transfer fee). */
  depositedGross: bigint[];
  /** Per token, the credit the pool books (`split_deposit_credit.total_credit` on NAV). */
  creditedNet: bigint[];
  /** v6.1 (T12): the part of `creditedNet[i]` that bought into the surge bucket (`surge_buy_in`). */
  surgeBuyIn: bigint[];
  /** `available − depositedGross`: left in the user's accounts. */
  dust: bigint[];
  /** LP the user receives: NET of the pool's deposit fee (v6.1 T7). */
  lp: bigint;
  /** LP the proportional join computes before the deposit fee. */
  lpGross: bigint;
  /** `lpGross − lp`: withheld by the deposit fee for the existing LPs. */
  depositFeeLp: bigint;
  /** Limiting join ratio (18-decimal fixed point), over NAV. */
  ratio: bigint;
  stateAfter: QuotePool;
}

const MIN_TOKENS = 2, MAX_TOKENS = 10;

/**
 * `QuotePool::from_pool` invariants (pool/swaps enabled are checked by the
 * caller). v6.1 (T22): a pool that already violates the strict leverage
 * invariant cannot trade (every swap / join CPI reverts with
 * `VirtualBalanceNotAboveActual`), so no plan is built against it.
 */
export function validateQuotePool(pool: QuotePool): void {
  const n = pool.tokens.length;
  if (n < MIN_TOKENS || n > MAX_TOKENS) throw new SimError("InvalidTokenCount");
  if (pool.lpSupply <= 0n) throw new SimError("PoolNotSeeded");
  for (const t of pool.tokens) checkLeverage(t.virtualBalance, t.actualBalance);
}

const actualOf = (pool: QuotePool): bigint[] => pool.tokens.map((t) => t.actualBalance);
/** v6.1 (T12): per-slot NAV `actual + surge_fees_owed` — the basis of the join ratio and its liveness rule. */
export const navOf = (pool: QuotePool): bigint[] => pool.tokens.map((t) => nav(t.actualBalance, t.surgeFeesOwed ?? 0n));

/** `plan::validate_plan_budget`: shape, liveness (on NAV since v6.1) and exact sum. */
export function validatePlanBudget(allocations: bigint[], amount: bigint, input: number, nav: bigint[]): void {
  if (allocations.length !== nav.length) throw new SimError("InvalidAllocationPlan", "allocation count differs from token count");
  if (!(input >= 0 && input < nav.length) || nav[input] <= 0n) throw new SimError("InvalidAllocationPlan", "input token is sidelined");
  let sum = 0n;
  for (let i = 0; i < allocations.length; i++) {
    if ((allocations[i] === 0n) !== (nav[i] === 0n)) throw new SimError("InvalidAllocationPlan", `allocation liveness mismatch at ${i}`);
    sum += allocations[i];
    if (sum > (1n << 64n) - 1n) throw new SimError("InvalidAllocationPlan", "allocation overflow");
  }
  if (sum !== amount || amount <= 0n) throw new SimError("InvalidAllocationPlan", "allocations must sum to the input");
}

/**
 * `QuotePool::swap`: one ordered swap on a private copy. Returns the leg and
 * the advanced pool; the input pool is untouched. A bucket-only output slot
 * (`actual == 0 < surge`) fails with `InsufficientLiquidity` (T10).
 */
export function swapInPool(pool: QuotePool, input: number, output: number, gross: bigint): { leg: PlannerSwapQuote; pool: QuotePool } {
  const n = pool.tokens.length;
  if (!(input >= 0 && input < n && output >= 0 && output < n && input !== output)) throw new SimError("InvalidTokenIndex");
  if (gross <= 0n) throw new SimError("ZeroAmount");
  const r = simulateSwap({
    input: pool.tokens[input], output: pool.tokens[output], amountIn: gross,
    swapFeeRate: pool.swapFeeRate, protocolFeeRate: pool.protocolFeeRate, creatorFeeBps: pool.creatorFeeBps ?? 0,
    hookFeeOverride: pool.hookFeeOverride, hookFeeMin: pool.hookFeeMin, hookFeeMax: pool.hookFeeMax, now: pool.now,
  });
  const tokens = pool.tokens.slice();
  tokens[input] = { ...pool.tokens[input], ...r.inputAfter };
  tokens[output] = { ...pool.tokens[output], ...r.outputAfter };
  // v6.1 (T22): the program's post-state guard, leg for leg (`swap.rs`
  // `assert_leverage_invariant`), on the same shared rule.
  checkLeverage(tokens[input].virtualBalance, tokens[input].actualBalance);
  checkLeverage(tokens[output].virtualBalance, tokens[output].actualBalance);
  return {
    leg: {
      input, output, grossInput: gross, netInput: r.amountInNet, baseFee: r.feeAmount, protocolFee: r.protocolFeeAmount, creatorFee: r.creatorFeeAmount,
      rawOutput: r.grossAmountOut, surgeFee: r.surgeFeeAmount, surgeProtocolFee: r.surgeProtocolFeeAmount, surgeCreatorFee: r.surgeCreatorFeeAmount, surgeLpFee: r.surgeLpFeeAmount,
      grossOutput: r.amountOut, netOutput: r.amountOutReceived, effectiveFeeRate: r.effectiveFeeRate,
    },
    pool: { ...pool, tokens },
  };
}

/**
 * `planner::replay`: the economic oracle. Executes the plan's swaps in slot
 * order, then the exact v6.1 join (priced on NAV, bucket buy-in, deposit
 * fee) on what the user holds afterwards. Prior wallet balances are not
 * inputs and cannot change the result.
 */
export function replay(pool: QuotePool, input: number, amount: bigint, allocations: bigint[]): ZapQuote {
  validatePlanBudget(allocations, amount, input, navOf(pool));
  let state = pool;
  const n = state.tokens.length;
  const available: bigint[] = new Array(n).fill(0n);
  available[input] = allocations[input];
  const swaps: PlannerSwapQuote[] = [];
  for (let i = 0; i < n; i++) {
    if (i === input || allocations[i] === 0n) continue;
    const r = swapInPool(state, input, i, allocations[i]);
    state = r.pool;
    available[i] = r.leg.netOutput;
    swaps.push(r.leg);
  }
  const actual = actualOf(state);
  const navs = navOf(state);
  const net: bigint[] = [];
  for (let i = 0; i < n; i++) {
    if ((navs[i] > 0n) !== (available[i] > 0n)) throw new MathError("TokenLivenessMismatch");
    net.push(netOfTransferFee(state.tokens[i].transferFee, available[i]));
    if (available[i] !== 0n && net[i] === 0n) throw new MathError("AmountFullyConsumedByTransferFee");
  }
  const { lp: lpGross, ratio } = calcJoinRatioAndLp(navs, net, state.lpSupply);
  if (lpGross <= 0n) throw new MathError("DepositTooSmall");
  const { net: lp, fee: depositFeeLp } = applyDepositFee(lpGross, state.depositFeeBps ?? 0);
  if (lp <= 0n) throw new MathError("DepositFeeConsumesAll");
  const tokens = state.tokens.slice();
  const creditedNet: bigint[] = [], surgeBuyIn: bigint[] = [], depositedGross: bigint[] = [], dust: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const leg = splitDepositCredit(actual[i], tokens[i].surgeFeesOwed ?? 0n, ratio);
    const credit = leg.totalCredit;
    const charged = grossOfTransferFee(tokens[i].transferFee, credit);
    if (credit > net[i] || charged > available[i]) throw new SimError("TokenBudgetExceeded");
    const oldVb = tokens[i].virtualBalance;
    // `lpGross`, not the net mint: a sidelined leg follows the join's
    // proportional factor; the virtual balance follows the ACTUAL leg only.
    const newVb = virtualBalanceAfterDeposit(oldVb, actual[i], leg.actualIn, lpGross, state.lpSupply);
    const window = rescaleWindowOnVbChange(tokens[i].window, oldVb, newVb);
    const surgeAfter = (tokens[i].surgeFeesOwed ?? 0n) + leg.bucketIn;
    if (surgeAfter > (1n << 64n) - 1n) throw new MathError("SurgeBucketOverflow");
    tokens[i] = { ...tokens[i], virtualBalance: newVb, actualBalance: assertU64(actual[i] + leg.actualIn, "actual balance"), surgeFeesOwed: surgeAfter, window };
    // v6.1 (T22): `add_liquidity.rs`'s post-guard, slot for slot.
    checkLeverage(tokens[i].virtualBalance, tokens[i].actualBalance);
    creditedNet.push(credit); surgeBuyIn.push(leg.bucketIn); depositedGross.push(charged); dust.push(available[i] - charged);
  }
  const stateAfter: QuotePool = { ...state, tokens, lpSupply: assertU64(state.lpSupply + lp, "lp supply") };
  return { allocations: allocations.slice(), swaps, available, depositedGross, creditedNet, surgeBuyIn, dust, lp, lpGross, depositFeeLp, ratio, stateAfter };
}

/**
 * `planner::leg_for_ratio`: the smallest gross input of one leg whose
 * post-swap join ratio (on NAV) reaches `ratio`. Failed high probes narrow
 * the bracket; the chosen endpoint is re-executed before it is accepted.
 */
function legForRatio(pool: QuotePool, input: number, output: number, max: bigint, ratio: bigint): { gross: bigint; pool: QuotePool } {
  // A fully withheld input or a one-unit input consumed by the ceiling base
  // fee is a LOW probe, not evidence that the curve's upper bound was
  // exceeded; starting above it keeps the bracket meaningful.
  const minNet = effectiveSwapFeeRate(pool) === 0 ? 1n : 2n;
  let lo = grossOfTransferFee(pool.tokens[input].transferFee, minNet);
  let hi = max;
  if (hi < lo) throw new SimError("AmountTooSmall");
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    let probe: { leg: PlannerSwapQuote; pool: QuotePool };
    try {
      probe = swapInPool(pool, input, output, mid);
    } catch (e) {
      if (!isSimFailure(e)) throw e;
      hi = mid;
      continue;
    }
    const navOut = nav(probe.pool.tokens[output].actualBalance, probe.pool.tokens[output].surgeFeesOwed ?? 0n);
    // The probe applies the output fee a second time, like the Rust search.
    const netJoin = netOfTransferFee(probe.pool.tokens[output].transferFee, probe.leg.netOutput);
    if (navOut === 0n || (netJoin * ONE) / navOut >= ratio) hi = mid;
    else lo = mid + 1n;
  }
  const chosen = swapInPool(pool, input, output, lo);
  const navOut = nav(chosen.pool.tokens[output].actualBalance, chosen.pool.tokens[output].surgeFeesOwed ?? 0n);
  if (navOut <= 0n) throw new MathError("TokenLivenessMismatch");
  const net = netOfTransferFee(chosen.pool.tokens[output].transferFee, chosen.leg.netOutput);
  if ((net * ONE) / navOut < ratio) throw new SimError("AmountTooSmall");
  return { gross: lo, pool: chosen.pool };
}

/** `planner::basket_for_ratio`: one leg per live (NAV > 0) non-input slot, in slot order. */
function basketForRatio(pool: QuotePool, input: number, amount: bigint, ratio: bigint): bigint[] {
  let state = pool;
  const n = state.tokens.length;
  const allocations: bigint[] = new Array(n).fill(0n);
  let remaining = amount;
  for (let i = 0; i < n; i++) {
    if (i === input || nav(state.tokens[i].actualBalance, state.tokens[i].surgeFeesOwed ?? 0n) === 0n) continue;
    const r = legForRatio(state, input, i, remaining > 0n ? remaining - 1n : 0n, ratio);
    allocations[i] = r.gross;
    if (r.gross > remaining) throw new MathError("MathUnderflow");
    remaining -= r.gross;
    state = r.pool;
  }
  allocations[input] = remaining;
  const netInputJoin = netOfTransferFee(state.tokens[input].transferFee, remaining);
  const navInput = nav(state.tokens[input].actualBalance, state.tokens[input].surgeFeesOwed ?? 0n);
  if ((netInputJoin * ONE) / navInput < ratio) throw new SimError("AmountTooSmall");
  return allocations;
}

function better(candidate: ZapQuote, best: ZapQuote | undefined): boolean {
  return !best || candidate.lp > best.lp || (candidate.lp === best.lp && candidate.ratio > best.ratio);
}

/**
 * `planner::quote`: bisect the common join ratio (on NAV) over the ordered
 * route. Bounded (≤ 128 outer iterations); every returned basket is fully
 * replayed, and the legacy linear split is also evaluated so the result is
 * never worse than that baseline. Throws `SimError("AmountTooSmall")` when
 * no candidate is feasible — including a pool with a bucket-only slot
 * (`actual == 0 < surge`), which must be joined but cannot be bought (T10).
 */
export function quoteZap(pool: QuotePool, input: number, amount: bigint): ZapQuote {
  validateQuotePool(pool);
  const n = pool.tokens.length;
  if (!(input >= 0 && input < n) || pool.tokens[input].actualBalance <= 0n) throw new SimError("InvalidTokenIndex");
  if (amount <= 0n) throw new SimError("ZeroAmount");
  assertU64(amount, "amount");
  return withPowMemo(() => {
    const actual = actualOf(pool);
    const navs = navOf(pool);
    let best: ZapQuote | undefined;
    try {
      const legacy = computeAllocations({ actualBalances: actual, virtualBalances: pool.tokens.map((t) => t.virtualBalance), weightsBps: pool.tokens.map((t) => Number(t.weightBps)), amountIn: amount, tokenInIndex: input });
      best = replay(pool, input, amount, legacy.allocations);
    } catch (e) {
      if (!isSimFailure(e)) throw e;
    }
    let lo = 1n;
    let hi = (netOfTransferFee(pool.tokens[input].transferFee, amount) * ONE) / navs[input];
    while (lo <= hi) {
      const ratio = lo + (hi - lo) / 2n;
      let candidate: ZapQuote | undefined;
      try {
        candidate = replay(pool, input, amount, basketForRatio(pool, input, amount, ratio));
      } catch (e) {
        if (!isSimFailure(e)) throw e;
      }
      if (candidate) {
        if (better(candidate, best)) best = candidate;
        lo = ratio + 1n;
      } else {
        hi = ratio - 1n;
      }
    }
    if (!best) throw new SimError("AmountTooSmall");
    return best;
  });
}
