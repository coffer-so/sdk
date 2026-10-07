import BN from "bn.js";
import { PoolInfo, PoolTokenInfo } from "../types/pool";
import { simulateSwap, SwapLeg, SwapSimResult } from "../math/swapSim";
import { MathError } from "../math/fixedPoint";

const U64_MAX = (1n << 64n) - 1n;
export function u64(value: bigint, label: string): bigint {
  if (value < 0n || value > U64_MAX) throw new Error(`${label} must fit u64`);
  return value;
}
const bi = (value: BN | undefined): bigint => BigInt(value?.toString() ?? "0");
const bn = (value: bigint): BN => new BN(value.toString());

/** `PoolTokenInfo` (BN snapshot) → simulator leg (bigint). */
export function swapLegOf(t: PoolTokenInfo): SwapLeg {
  if (t.maxSelloffPct > 0 && [t.maxSelloffPeriodLength, t.previousSelloff, t.currentSelloff, t.windowStartTimestamp, t.selloffVbSnapshot].some((v) => v === undefined)) {
    throw new Error("Selloff state missing: sync the pool before quoting");
  }
  return {
    virtualBalance: bi(t.virtualBalance),
    actualBalance: bi(t.actualBalance),
    protocolFeesOwed: bi(t.protocolFeesOwed),
    weightBps: BigInt(t.weightBps),
    isActive: t.isActive,
    maxSelloffPct: t.maxSelloffPct,
    maxSelloffPeriodLength: t.maxSelloffPeriodLength ?? 0,
    curve: {
      thresholdPct: t.variableFeeThresholdPct ?? 0,
      slopeLowPct: t.variableFeeSlopeLowPct ?? 0,
      slopeMidPct: t.variableFeeSlopeMidPct ?? 0,
      slopeHighPct: t.variableFeeSlopeHighPct ?? 0,
      kinkPct: t.variableFeeKinkPct ?? 0,
    },
    window: { previousSelloff: bi(t.previousSelloff), currentSelloff: bi(t.currentSelloff), windowStartTimestamp: bi(t.windowStartTimestamp), selloffVbSnapshot: bi(t.selloffVbSnapshot) },
    transferFee: t.transferFee ?? null,
  };
}

function applyLeg(t: PoolTokenInfo, after: SwapSimResult["inputAfter"]): void {
  t.virtualBalance = bn(after.virtualBalance);
  t.actualBalance = bn(after.actualBalance);
  t.protocolFeesOwed = bn(after.protocolFeesOwed);
  t.previousSelloff = bn(after.window.previousSelloff);
  t.currentSelloff = bn(after.window.currentSelloff);
  t.windowStartTimestamp = bn(after.window.windowStartTimestamp);
  t.selloffVbSnapshot = bn(after.window.selloffVbSnapshot);
}

/**
 * Compute one v6 swap against a `PoolInfo` snapshot; with `mutate` the
 * snapshot is advanced in place (used for sequential simulations).
 * Throws with the program's error name on a program-equivalent failure.
 */
export function simulatePoolSwap(pool: PoolInfo, tokenInIndex: number, tokenOutIndex: number, amountIn: bigint, now: bigint, mutate = false): SwapSimResult {
  if (!Number.isInteger(tokenInIndex) || !Number.isInteger(tokenOutIndex) || tokenInIndex === tokenOutIndex ||
      tokenInIndex < 0 || tokenOutIndex < 0 || tokenInIndex >= pool.tokenCount || tokenOutIndex >= pool.tokenCount) {
    throw new Error("InvalidTokenIndex");
  }
  if (!pool.poolEnabled) throw new Error("PoolDisabled");
  if (!pool.swapsEnabled) throw new Error("SwapsDisabled");
  u64(amountIn, "amountIn");
  const input = pool.tokens[tokenInIndex], output = pool.tokens[tokenOutIndex];
  let r: SwapSimResult;
  try {
    r = simulateSwap({ input: swapLegOf(input), output: swapLegOf(output), amountIn, swapFeeRate: pool.swapFeeRate, protocolFeeRate: pool.protocolFeeRate, now });
  } catch (e) {
    // Surface program error names to the client's code mapping.
    if (e instanceof MathError) throw new Error(e.message);
    throw e;
  }
  if (mutate) {
    applyLeg(input, r.inputAfter);
    applyLeg(output, r.outputAfter);
  }
  return r;
}

/** Clock from sync; callers may supply the transaction's expected Unix timestamp explicitly. */
export function quoteTimestamp(pool: PoolInfo, nowSeconds?: number): bigint {
  const now = nowSeconds ?? pool.chainTimestamp;
  if (now === undefined) {
    if (pool.tokens.some(t => t.maxSelloffPct > 0)) throw new Error("Chain timestamp missing: sync or supply nowSeconds");
    return 0n;
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid quote timestamp");
  return BigInt(now);
}
