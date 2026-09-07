import { ONE, assertU64, assertInteger, mulDivDown } from "./fixedPoint";
import { calcOutGivenIn } from "./cubicMath";
import { lpBalances, calculateSwapFee, calculateProtocolFee } from "./slippage";

export interface AllocationResult {
  /** Per-token integer amount allocations; sum = amountIn. */
  allocations: bigint[];
  /** Scaled W values, for inspection/debugging. */
  wScaled: bigint[];
  /** Sum of wScaled. */
  sumW: bigint;
}

/**
 * Port of stld `compute_allocations` from
 * `contracts/programs/single-token-liquidity/src/math.rs`.
 *
 * W_i = weight_i * min(actual_i, virtual_i) / virtual_i.
 * Division order matches the two integer divisions on-chain.
 * share_i = W_i / ΣW. amount_alloc[i] = amountIn * share_i.
 *
 * Integer truncation of per-token amounts routes the remainder to the
 * input-token slot so Σ allocations == amountIn exactly.
 */
export function computeAllocations(params: {
  actualBalances: bigint[];
  virtualBalances: bigint[];
  weightsBps: number[];
  amountIn: bigint;
  tokenInIndex: number;
}): AllocationResult {
  const { actualBalances, virtualBalances, weightsBps, amountIn, tokenInIndex } = params;
  assertU64(amountIn, "amountIn");
  const n = actualBalances.length;
  if (n !== virtualBalances.length || n !== weightsBps.length) {
    throw new Error("computeAllocations: length mismatch");
  }
  if (!Number.isInteger(tokenInIndex) || tokenInIndex < 0 || tokenInIndex >= n) {
    throw new Error("computeAllocations: tokenInIndex out of range");
  }
  const wScaled: bigint[] = [];
  for (let i = 0; i < n; i++) {
    if (virtualBalances[i] <= 0n) {
      throw new Error(`computeAllocations: virtualBalance[${i}] must be positive`);
    }
    assertU64(actualBalances[i]); assertU64(virtualBalances[i]);
    assertInteger(weightsBps[i], 0, 10000, "weight");
    const effectiveActual = actualBalances[i] < virtualBalances[i] ? actualBalances[i] : virtualBalances[i];
    const scaled = mulDivDown(effectiveActual, ONE, virtualBalances[i]);
    const w = mulDivDown(scaled, BigInt(weightsBps[i]), 10_000n);
    wScaled.push(w);
  }
  const sumW = wScaled.reduce((a, b) => a + b, 0n);
  if (sumW === 0n) {
    throw new Error("computeAllocations: pool not seeded (ΣW = 0)");
  }
  const allocations: bigint[] = wScaled.map((w) => (amountIn * w) / sumW);
  const sumAlloc = allocations.reduce((a, b) => a + b, 0n);
  if (sumAlloc < amountIn) {
    allocations[tokenInIndex] += amountIn - sumAlloc;
  }
  return { allocations, wScaled, sumW };
}

function swapFeeAmount(amount: bigint, swapFeeRate: number): bigint {
  return calculateSwapFee(amount, swapFeeRate);
}

function amountAfterSwapFee(amount: bigint, swapFeeRate: number): bigint {
  const fee = swapFeeAmount(amount, swapFeeRate);
  if (swapFeeRate > 0 && fee === 0n) {
    throw new Error("computeTwoTokenOptimalAllocations: swap amount too small, fee rounds to zero");
  }
  return amount - fee;
}

function protocolFeeAmount(swapFee: bigint, protocolFeeRate: number): bigint {
  return calculateProtocolFee(swapFee, protocolFeeRate);
}

function scoreTwoTokenSwap(params: {
  actualBalances: [bigint, bigint];
  virtualBalances: [bigint, bigint];
  protocolFeesOwed: [bigint, bigint];
  weightsBps: [number, number];
  amountIn: bigint;
  tokenInIndex: 0 | 1;
  swapToOther: bigint;
  swapFeeRate: number;
  protocolFeeRate: number;
}): { score: bigint; amountOut: bigint } {
  const {
    actualBalances,
    virtualBalances,
    protocolFeesOwed,
    weightsBps,
    amountIn,
    tokenInIndex,
    swapToOther,
    swapFeeRate,
    protocolFeeRate,
  } = params;
  const other = tokenInIndex === 0 ? 1 : 0;
  const remainingInput = amountIn - swapToOther;
  if (swapToOther <= 0n || remainingInput <= 0n) return { score: 0n, amountOut: 0n };

  let afterFee: bigint;
  try {
    afterFee = amountAfterSwapFee(swapToOther, swapFeeRate);
  } catch {
    return { score: 0n, amountOut: 0n };
  }
  const swapFee = swapToOther - afterFee;
  const protocolFee = protocolFeeAmount(swapFee, protocolFeeRate);

  const inLp = lpBalances(
    actualBalances[tokenInIndex],
    virtualBalances[tokenInIndex],
    protocolFeesOwed[tokenInIndex]
  );
  const outLp = lpBalances(
    actualBalances[other],
    virtualBalances[other],
    protocolFeesOwed[other]
  );

  let amountOut: bigint;
  try {
    amountOut = calcOutGivenIn({
      virtualBalanceIn: inLp.lpVirtual,
      weightInBps: BigInt(weightsBps[tokenInIndex]),
      virtualBalanceOut: outLp.lpVirtual,
      weightOutBps: BigInt(weightsBps[other]),
      amountIn: afterFee,
      actualBalanceOut: outLp.lpActual,
    });
  } catch {
    return { score: 0n, amountOut: 0n };
  }
  if (amountOut <= 0n || amountOut >= outLp.lpActual) return { score: 0n, amountOut };

  const lpInAfter = inLp.lpActual + swapToOther - protocolFee;
  const lpOutAfter = outLp.lpActual - amountOut;
  if (lpInAfter <= 0n || lpOutAfter <= 0n) return { score: 0n, amountOut };

  const ratioIn = (remainingInput * ONE) / lpInAfter;
  const ratioOut = (amountOut * ONE) / lpOutAfter;
  return { score: ratioIn < ratioOut ? ratioIn : ratioOut, amountOut };
}

/** @deprecated Analytical base-fee-only optimizer. The deployed helper uses computeAllocations; this does not model selloff/surge. */
export function computeTwoTokenOptimalAllocations(params: {
  actualBalances: [bigint, bigint];
  virtualBalances: [bigint, bigint];
  protocolFeesOwed: [bigint, bigint];
  weightsBps: [number, number];
  amountIn: bigint;
  tokenInIndex: 0 | 1;
  swapFeeRate: number;
  protocolFeeRate: number;
}): AllocationResult {
  const { amountIn, tokenInIndex } = params;
  if (amountIn <= 1n) {
    throw new Error("computeTwoTokenOptimalAllocations: amountIn too small");
  }

  let low = 1n;
  let high = amountIn - 1n;
  for (let i = 0; i < 32 && low < high; i++) {
    const mid = low + (high - low) / 2n;
    const current = scoreTwoTokenSwap({ ...params, swapToOther: mid }).score;
    const next = scoreTwoTokenSwap({
      ...params,
      swapToOther: mid + 1n < amountIn ? mid + 1n : amountIn - 1n,
    }).score;
    if (next >= current) low = mid + 1n;
    else high = mid;
  }

  const center = low < 1n ? 1n : low >= amountIn ? amountIn - 1n : low;
  let bestSwap = center;
  let bestScore = 0n;
  const start = center > 8n ? center - 8n : 1n;
  const end = center + 8n < amountIn ? center + 8n : amountIn - 1n;
  for (let swapToOther = start; swapToOther <= end; swapToOther++) {
    const { score, amountOut } = scoreTwoTokenSwap({ ...params, swapToOther });
    if (amountOut > 0n && score > bestScore) {
      bestScore = score;
      bestSwap = swapToOther;
    }
  }
  if (bestScore === 0n) {
    throw new Error("computeTwoTokenOptimalAllocations: amount too small");
  }

  const allocations: [bigint, bigint] = [0n, 0n];
  const other = tokenInIndex === 0 ? 1 : 0;
  allocations[tokenInIndex] = amountIn - bestSwap;
  allocations[other] = bestSwap;
  return { allocations, wScaled: [], sumW: bestScore };
}

/**
 * Mirror of stld `cap_deposit_amounts_to_lp_ratio`.
 *
 * Stored actual balances already exclude protocol fees. The helper deposits
 * the common raw-actual ratio and refunds the remaining basket.
 */
export function capDepositAmountsToLpRatio(params: {
  helperBalances: bigint[];
  actualBalances: bigint[];
  /** Retained for compatibility; actual balances already exclude these fees. */
  protocolFeesOwed?: bigint[];
}): { depositAmounts: bigint[]; refundAmounts: bigint[]; lpBalancesForAdd: bigint[] } {
  const { helperBalances, actualBalances, protocolFeesOwed } = params;
  const n = helperBalances.length;
  if (n !== actualBalances.length || (protocolFeesOwed && n !== protocolFeesOwed.length)) {
    throw new Error("capDepositAmountsToLpRatio: length mismatch");
  }

  helperBalances.forEach((b) => assertU64(b));
  const lpBalancesForAdd = actualBalances.map((actual) => assertU64(actual));
  let ratioMin: bigint | null = null;

  for (let i = 0; i < n; i++) {
    if (lpBalancesForAdd[i] === 0n) continue;
    if (helperBalances[i] <= 0n) {
      throw new Error("capDepositAmountsToLpRatio: amount too small");
    }
    const ratio = (helperBalances[i] * ONE) / lpBalancesForAdd[i];
    ratioMin = ratioMin === null || ratio < ratioMin ? ratio : ratioMin;
  }

  if (ratioMin === null || ratioMin === 0n) {
    throw new Error("capDepositAmountsToLpRatio: amount too small");
  }

  const depositAmounts = lpBalancesForAdd.map((lp, i) => {
    if (lp === 0n) return 0n;
    const amount = (lp * ratioMin!) / ONE;
    if (amount <= 0n) {
      throw new Error("capDepositAmountsToLpRatio: amount too small");
    }
    return amount > helperBalances[i] ? helperBalances[i] : amount;
  });
  const refundAmounts = helperBalances.map((balance, i) =>
    balance > depositAmounts[i] ? balance - depositAmounts[i] : 0n
  );

  return { depositAmounts, refundAmounts, lpBalancesForAdd };
}
