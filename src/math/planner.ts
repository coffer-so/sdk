/**
 * TypeScript port of the v6 single-token-liquidity planner
 * (`contracts/programs/single-token-liquidity/src/planner.rs`), the host-side
 * search the program itself does not run.
 *
 * A v6 zap is `deposit_single_token_planned`: the user signs a plan — the
 * gross input to spend on each swap leg (`allocations`, summing to the
 * input), a hash of the pool/mint state it was computed on and an expiry.
 * The program only VERIFIES the plan (budget, hash, age ≤ 90 s, slot) and
 * executes swaps + one proportional join with the user's own accounts. This
 * module picks `allocations`: it replays candidates on the exact integer
 * math of the program (`swapSim`, `poolMath`, `maxSelloff`, `surgeFee`,
 * `transferFee`) and bisects on the post-swap join ratio until every live
 * leg can be joined at the same ratio with the most LP.
 *
 * Every function is pure; `QuotePool` is copied on write. Program-equivalent
 * failures are `MathError` (checked arithmetic / coffer-pool errors) or
 * `SimError` (STLD errors) and are the search's control flow: a candidate
 * that fails is infeasible, never a bug. Anything else propagates.
 */
import { ONE, MathError, assertU64 } from "./fixedPoint";
import { withPowMemo } from "./logExp";
import { simulateSwap, SwapLeg } from "./swapSim";
import { calcDepositCredit, calcJoinRatioAndLp, virtualBalanceAfterDeposit } from "./poolMath";
import { rescaleWindowOnVbChange } from "./maxSelloff";
import { grossOfTransferFee, netOfTransferFee } from "./transferFee";
import { computeAllocations } from "./singleToken";

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
  /** Live slots only (`token_count` entries), each with its epoch fee schedule. */
  tokens: SwapLeg[];
  lpSupply: bigint;
  swapFeeRate: number;
  protocolFeeRate: number;
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
  /** Curve output before surge. */
  rawOutput: bigint;
  surgeFee: bigint;
  /** Vault debit (`rawOutput − surgeFee`). */
  grossOutput: bigint;
  /** What the user's account receives after the output mint's transfer fee. */
  netOutput: bigint;
}

export interface ZapQuote {
  allocations: bigint[];
  swaps: PlannerSwapQuote[];
  /** Per token, what the user holds for the join: the reserved input, or a leg's `netOutput`. */
  available: bigint[];
  /** Per token, the join's gross debit (`credit` grossed up by the transfer fee). */
  depositedGross: bigint[];
  /** Per token, the credit the pool books (`calc_deposit_credit`). */
  creditedNet: bigint[];
  /** `available − depositedGross`: left in the user's accounts. */
  dust: bigint[];
  lp: bigint;
  /** Limiting join ratio (18-decimal fixed point). */
  ratio: bigint;
  stateAfter: QuotePool;
}

const MIN_TOKENS = 2, MAX_TOKENS = 10;

/** `QuotePool::from_pool` invariants (pool/swaps enabled are checked by the caller). */
export function validateQuotePool(pool: QuotePool): void {
  const n = pool.tokens.length;
  if (n < MIN_TOKENS || n > MAX_TOKENS) throw new SimError("InvalidTokenCount");
  if (pool.lpSupply <= 0n) throw new SimError("PoolNotSeeded");
}

const actualOf = (pool: QuotePool): bigint[] => pool.tokens.map((t) => t.actualBalance);

/** `plan::validate_plan_budget`: shape, liveness and exact sum. */
export function validatePlanBudget(allocations: bigint[], amount: bigint, input: number, actual: bigint[]): void {
  if (allocations.length !== actual.length) throw new SimError("InvalidAllocationPlan", "allocation count differs from token count");
  if (!(input >= 0 && input < actual.length) || actual[input] <= 0n) throw new SimError("InvalidAllocationPlan", "input token is sidelined");
  let sum = 0n;
  for (let i = 0; i < allocations.length; i++) {
    if ((allocations[i] === 0n) !== (actual[i] === 0n)) throw new SimError("InvalidAllocationPlan", `allocation liveness mismatch at ${i}`);
    sum += allocations[i];
    if (sum > (1n << 64n) - 1n) throw new SimError("InvalidAllocationPlan", "allocation overflow");
  }
  if (sum !== amount || amount <= 0n) throw new SimError("InvalidAllocationPlan", "allocations must sum to the input");
}

/**
 * `QuotePool::swap`: one ordered swap on a private copy. Returns the leg and
 * the advanced pool; the input pool is untouched.
 */
export function swapInPool(pool: QuotePool, input: number, output: number, gross: bigint): { leg: PlannerSwapQuote; pool: QuotePool } {
  const n = pool.tokens.length;
  if (!(input >= 0 && input < n && output >= 0 && output < n && input !== output)) throw new SimError("InvalidTokenIndex");
  if (gross <= 0n) throw new SimError("ZeroAmount");
  const r = simulateSwap({ input: pool.tokens[input], output: pool.tokens[output], amountIn: gross, swapFeeRate: pool.swapFeeRate, protocolFeeRate: pool.protocolFeeRate, now: pool.now });
  const tokens = pool.tokens.slice();
  tokens[input] = { ...pool.tokens[input], ...r.inputAfter };
  tokens[output] = { ...pool.tokens[output], ...r.outputAfter };
  return {
    leg: { input, output, grossInput: gross, netInput: r.amountInNet, baseFee: r.feeAmount, protocolFee: r.protocolFeeAmount, rawOutput: r.grossAmountOut, surgeFee: r.surgeFeeAmount, grossOutput: r.amountOut, netOutput: r.amountOutReceived },
    pool: { ...pool, tokens },
  };
}

/**
 * `planner::replay`: the economic oracle. Executes the plan's swaps in slot
 * order, then the exact v6 join on what the user holds afterwards. Prior
 * wallet balances are not inputs and cannot change the result.
 */
export function replay(pool: QuotePool, input: number, amount: bigint, allocations: bigint[]): ZapQuote {
  validatePlanBudget(allocations, amount, input, actualOf(pool));
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
  const net: bigint[] = [];
  for (let i = 0; i < n; i++) {
    if ((actual[i] > 0n) !== (available[i] > 0n)) throw new MathError("TokenLivenessMismatch");
    net.push(netOfTransferFee(state.tokens[i].transferFee, available[i]));
    if (available[i] !== 0n && net[i] === 0n) throw new MathError("AmountFullyConsumedByTransferFee");
  }
  const { lp, ratio } = calcJoinRatioAndLp(actual, net, state.lpSupply);
  if (lp <= 0n) throw new MathError("DepositTooSmall");
  const tokens = state.tokens.slice();
  const creditedNet: bigint[] = [], depositedGross: bigint[] = [], dust: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const credit = calcDepositCredit(actual[i], ratio);
    const charged = grossOfTransferFee(tokens[i].transferFee, credit);
    if (credit > net[i] || charged > available[i]) throw new SimError("TokenBudgetExceeded");
    const oldVb = tokens[i].virtualBalance;
    const newVb = virtualBalanceAfterDeposit(oldVb, actual[i], credit, lp, state.lpSupply);
    const window = rescaleWindowOnVbChange(tokens[i].window, oldVb, newVb);
    tokens[i] = { ...tokens[i], virtualBalance: newVb, actualBalance: assertU64(actual[i] + credit, "actual balance"), window };
    creditedNet.push(credit); depositedGross.push(charged); dust.push(available[i] - charged);
  }
  const stateAfter: QuotePool = { ...state, tokens, lpSupply: assertU64(state.lpSupply + lp, "lp supply") };
  return { allocations: allocations.slice(), swaps, available, depositedGross, creditedNet, dust, lp, ratio, stateAfter };
}

/**
 * `planner::leg_for_ratio`: the smallest gross input of one leg whose
 * post-swap join ratio reaches `ratio`. Failed high probes narrow the
 * bracket; the chosen endpoint is re-executed before it is accepted.
 */
function legForRatio(pool: QuotePool, input: number, output: number, max: bigint, ratio: bigint): { gross: bigint; pool: QuotePool } {
  // A fully withheld input or a one-unit input consumed by the ceiling base
  // fee is a LOW probe, not evidence that the curve's upper bound was
  // exceeded; starting above it keeps the bracket meaningful.
  const minNet = pool.swapFeeRate === 0 ? 1n : 2n;
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
    const actual = probe.pool.tokens[output].actualBalance;
    // The probe applies the output fee a second time, like the Rust search.
    const netJoin = netOfTransferFee(probe.pool.tokens[output].transferFee, probe.leg.netOutput);
    if (actual === 0n || (netJoin * ONE) / actual >= ratio) hi = mid;
    else lo = mid + 1n;
  }
  const chosen = swapInPool(pool, input, output, lo);
  const actual = chosen.pool.tokens[output].actualBalance;
  if (actual <= 0n) throw new MathError("TokenLivenessMismatch");
  const net = netOfTransferFee(chosen.pool.tokens[output].transferFee, chosen.leg.netOutput);
  if ((net * ONE) / actual < ratio) throw new SimError("AmountTooSmall");
  return { gross: lo, pool: chosen.pool };
}

/** `planner::basket_for_ratio`: one leg per live non-input slot, in slot order. */
function basketForRatio(pool: QuotePool, input: number, amount: bigint, ratio: bigint): bigint[] {
  let state = pool;
  const n = state.tokens.length;
  const allocations: bigint[] = new Array(n).fill(0n);
  let remaining = amount;
  for (let i = 0; i < n; i++) {
    if (i === input || state.tokens[i].actualBalance === 0n) continue;
    const r = legForRatio(state, input, i, remaining > 0n ? remaining - 1n : 0n, ratio);
    allocations[i] = r.gross;
    if (r.gross > remaining) throw new MathError("MathUnderflow");
    remaining -= r.gross;
    state = r.pool;
  }
  allocations[input] = remaining;
  const netInputJoin = netOfTransferFee(state.tokens[input].transferFee, remaining);
  if ((netInputJoin * ONE) / state.tokens[input].actualBalance < ratio) throw new SimError("AmountTooSmall");
  return allocations;
}

function better(candidate: ZapQuote, best: ZapQuote | undefined): boolean {
  return !best || candidate.lp > best.lp || (candidate.lp === best.lp && candidate.ratio > best.ratio);
}

/**
 * `planner::quote`: bisect the common join ratio over the ordered route.
 * Bounded (≤ 128 outer iterations); every returned basket is fully replayed,
 * and the legacy linear split is also evaluated so the result is never
 * worse than that baseline. Throws `SimError("AmountTooSmall")` when no
 * candidate is feasible.
 */
export function quoteZap(pool: QuotePool, input: number, amount: bigint): ZapQuote {
  validateQuotePool(pool);
  const n = pool.tokens.length;
  if (!(input >= 0 && input < n) || pool.tokens[input].actualBalance <= 0n) throw new SimError("InvalidTokenIndex");
  if (amount <= 0n) throw new SimError("ZeroAmount");
  assertU64(amount, "amount");
  return withPowMemo(() => {
    const actual = actualOf(pool);
    let best: ZapQuote | undefined;
    try {
      const legacy = computeAllocations({ actualBalances: actual, virtualBalances: pool.tokens.map((t) => t.virtualBalance), weightsBps: pool.tokens.map((t) => Number(t.weightBps)), amountIn: amount, tokenInIndex: input });
      best = replay(pool, input, amount, legacy.allocations);
    } catch (e) {
      if (!isSimFailure(e)) throw e;
    }
    let lo = 1n;
    let hi = (netOfTransferFee(pool.tokens[input].transferFee, amount) * ONE) / actual[input];
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
