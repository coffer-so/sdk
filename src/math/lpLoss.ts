import {
  PROTOCOL_FEE_PRECISION,
  SWAP_FEE_PRECISION,
  WEIGHT_SCALE,
} from "../config";

export interface PredictLpLossParams {
  /** Normalized weights in bps (sum = WEIGHT_SCALE). */
  weightsBps: number[];
  virtualBalances: bigint[];
  /** LP-accessible balances: actual − protocolFeesOwed. */
  lpActualBalances: bigint[];
  decimals: number[];
  bptTotalSupply: bigint;
  swapFeeRate: number;
  protocolFeeRate: number;
  tokenInIndex: number;
  amountIn: bigint;
  /** Per-token input allocations from the quote (sum = amountIn). */
  allocations: bigint[];
  /** Per-leg expected swap outputs (0 for the input token / sidelined). */
  expectedOuts: bigint[];
  /** Amounts passed to add_liquidity after proportional capping. */
  depositedAmounts: bigint[];
  /** Helper-held excess refunded to the user. */
  refundAmounts: bigint[];
  estimatedBpt: bigint;
  /**
   * External per-token prices in any common unit. When omitted or incomplete
   * the pool-spot-implied prices (w_i / V_i) are used instead.
   */
  prices?: Array<number | null | undefined>;
}

const toWhole = (raw: bigint, decimals: number): number =>
  Number(raw) / 10 ** decimals;

/**
 * Predicted total value loss of the LP position minted by a single-token
 * deposit, as a percent of the deposited value, measured AFTER arbitrageurs
 * rebalance the pool back to external prices — the slippage-proof cost the
 * depositor actually bears.
 *
 * Replays the quote's swap legs and join onto the pool state, then values
 * the position at the closed-form zero-fee-arb equilibrium: with the
 * invariant ∏V_i^w_i preserved, equilibrium virtuals are V'_i = λ·w_i/p_i
 * and actual balances move by the same deltas. Validated against a full
 * profit-maximizing arbitrage simulation of the contract math (±0.03 pp,
 * slightly conservative). Float math — ample for percent-level output.
 *
 * Returns `null` when the pool is empty or inputs cannot price.
 */
export function predictLpLoss(params: PredictLpLossParams): number | null {
  const {
    weightsBps,
    virtualBalances,
    lpActualBalances,
    decimals,
    bptTotalSupply,
    swapFeeRate,
    protocolFeeRate,
    tokenInIndex,
    amountIn,
    allocations,
    expectedOuts,
    depositedAmounts,
    refundAmounts,
    estimatedBpt,
    prices: externalPrices,
  } = params;

  const n = weightsBps.length;
  if (
    virtualBalances.length !== n ||
    lpActualBalances.length !== n ||
    decimals.length !== n
  ) {
    throw new Error("predictLpLoss: length mismatch");
  }
  if (tokenInIndex < 0 || tokenInIndex >= n) {
    throw new Error("predictLpLoss: tokenInIndex out of range");
  }

  const supply = Number(bptTotalSupply);
  const estBpt = Number(estimatedBpt);
  const amountInWhole = toWhole(amountIn, decimals[tokenInIndex]);
  if (supply <= 0 || estBpt <= 0 || amountInWhole <= 0) return null;

  const weights: number[] = [];
  const virtuals: number[] = [];
  const actuals: number[] = [];
  for (let i = 0; i < n; i++) {
    weights.push(weightsBps[i] / WEIGHT_SCALE);
    virtuals.push(toWhole(virtualBalances[i], decimals[i]));
    actuals.push(toWhole(lpActualBalances[i], decimals[i]));
  }

  const externalComplete =
    externalPrices !== undefined &&
    externalPrices.length === n &&
    externalPrices.every((p) => typeof p === "number" && p > 0);
  const prices: number[] = [];
  for (let i = 0; i < n; i++) {
    const price = externalComplete
      ? (externalPrices![i] as number)
      : weights[i] / virtuals[i];
    if (!Number.isFinite(price) || price <= 0) return null;
    prices.push(price);
  }

  const feeRate = swapFeeRate / SWAP_FEE_PRECISION;
  const protoRate = protocolFeeRate / PROTOCOL_FEE_PRECISION;
  for (let i = 0; i < n; i++) {
    if (i === tokenInIndex) continue;
    const alloc = toWhole(allocations[i] ?? 0n, decimals[tokenInIndex]);
    const out = toWhole(expectedOuts[i] ?? 0n, decimals[i]);
    if (alloc <= 0 || out <= 0) continue;
    const protoFee = alloc * feeRate * protoRate;
    virtuals[tokenInIndex] += alloc - protoFee;
    actuals[tokenInIndex] += alloc - protoFee;
    virtuals[i] -= out;
    actuals[i] -= out;
  }

  const mintRatio = estBpt / supply;
  for (let i = 0; i < n; i++) {
    actuals[i] += toWhole(depositedAmounts[i] ?? 0n, decimals[i]);
    virtuals[i] *= 1 + mintRatio;
  }

  let logInvariant = 0;
  let logTarget = 0;
  for (let i = 0; i < n; i++) {
    if (weights[i] <= 0 || virtuals[i] <= 0) return null;
    logInvariant += weights[i] * Math.log(virtuals[i]);
    logTarget += weights[i] * Math.log(weights[i] / prices[i]);
  }
  const lambda = Math.exp(logInvariant - logTarget);

  let equilibriumPoolValue = 0;
  for (let i = 0; i < n; i++) {
    const equilibriumVirtual = (lambda * weights[i]) / prices[i];
    const equilibriumActual = Math.max(
      0,
      actuals[i] - (virtuals[i] - equilibriumVirtual)
    );
    equilibriumPoolValue += equilibriumActual * prices[i];
  }

  const lpValue = (mintRatio / (1 + mintRatio)) * equilibriumPoolValue;
  let refundValue = 0;
  for (let i = 0; i < n; i++) {
    refundValue += toWhole(refundAmounts[i] ?? 0n, decimals[i]) * prices[i];
  }
  const depositValue = amountInWhole * prices[tokenInIndex];
  if (depositValue <= 0) return null;

  const loss = 1 - (lpValue + refundValue) / depositValue;
  return Math.min(100, Math.max(0, loss * 100));
}
