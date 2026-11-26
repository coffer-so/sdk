import { ONE, MathError, assertU64, assertInteger, mulDivDown } from "./fixedPoint";

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
 *
 * In v6 this linear split is only the planner's baseline candidate
 * (`quoteZap` replays it and then bisects for a better one); the program
 * no longer computes allocations itself. Failures are `MathError`s named
 * after the `StldError` variants so the planner treats them as infeasible.
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
    throw new MathError("InvalidTokenCount");
  }
  if (!Number.isInteger(tokenInIndex) || tokenInIndex < 0 || tokenInIndex >= n) {
    throw new MathError("InvalidTokenIndex");
  }
  const wScaled: bigint[] = [];
  for (let i = 0; i < n; i++) {
    if (virtualBalances[i] <= 0n) {
      throw new MathError("InvalidVirtualBalance");
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
    throw new MathError("PoolNotSeeded");
  }
  const allocations: bigint[] = wScaled.map((w) => (amountIn * w) / sumW);
  const sumAlloc = allocations.reduce((a, b) => a + b, 0n);
  if (sumAlloc < amountIn) {
    allocations[tokenInIndex] += amountIn - sumAlloc;
  }
  return { allocations, wScaled, sumW };
}
