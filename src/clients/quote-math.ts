import BN from "bn.js";
import { PoolInfo, PoolTokenInfo } from "../types/pool";
import { calcOutGivenIn, calcSpotOut } from "../math/cubicMath";
import { calculateSwapFee, calculateProtocolFee } from "../math/slippage";
import { checkAndAdvanceSelloff } from "../math/maxSelloff";
import { calcSurgeFeeAmount } from "../math/surgeFee";

const U64_MAX = (1n << 64n) - 1n;
export function u64(value: bigint, label: string): bigint {
  if (value < 0n || value > U64_MAX) throw new Error(`${label} must fit u64`);
  return value;
}
const bi = (value: BN | undefined): bigint => BigInt(value?.toString() ?? "0");

/** Compute one deployed-contract swap against a snapshot, optionally advance a private zap copy. */
export function simulatePoolSwap(pool: PoolInfo, tokenInIndex: number, tokenOutIndex: number, amountIn: bigint, now: bigint, mutate = false) {
  if (!Number.isInteger(tokenInIndex) || !Number.isInteger(tokenOutIndex) || tokenInIndex === tokenOutIndex ||
      tokenInIndex < 0 || tokenOutIndex < 0 || tokenInIndex >= pool.tokenCount || tokenOutIndex >= pool.tokenCount) {
    throw new Error("InvalidTokenIndex");
  }
  if (!pool.poolEnabled) throw new Error("PoolDisabled");
  if (!pool.swapsEnabled) throw new Error("SwapsDisabled");
  u64(amountIn, "amountIn");
  if (amountIn === 0n) throw new Error("ZeroAmount");
  const input = pool.tokens[tokenInIndex], output = pool.tokens[tokenOutIndex];
  if (!input.isActive) throw new Error("TokenInactive");
  const virtualBalanceIn = bi(input.virtualBalance), virtualBalanceOut = bi(output.virtualBalance);
  const actualBalanceOut = bi(output.actualBalance);
  if (input.maxSelloffPct > 0 && [input.maxSelloffPeriodLength, input.previousSelloff, input.currentSelloff,
      input.windowStartTimestamp, input.selloffVbSnapshot].some(v => v === undefined)) {
    throw new Error("Selloff state missing: sync the pool before quoting");
  }
  const window = checkAndAdvanceSelloff({
    state: { previousSelloff: bi(input.previousSelloff), currentSelloff: bi(input.currentSelloff),
      windowStartTimestamp: bi(input.windowStartTimestamp), selloffVbSnapshot: bi(input.selloffVbSnapshot) },
    maxSelloffPct: input.maxSelloffPct, period: input.maxSelloffPeriodLength ?? 0,
    amountIn, virtualBalance: virtualBalanceIn, now,
  });
  const feeAmount = calculateSwapFee(amountIn, pool.swapFeeRate);
  const protocolFeeAmount = calculateProtocolFee(feeAmount, pool.protocolFeeRate);
  const amountInAfterFee = amountIn - feeAmount;
  const weightInBps = BigInt(input.weightBps), weightOutBps = BigInt(output.weightBps);
  const grossAmountOut = calcOutGivenIn({ virtualBalanceIn, virtualBalanceOut, weightInBps, weightOutBps, amountIn: amountInAfterFee, actualBalanceOut });
  const surgeFeeAmount = calcSurgeFeeAmount({ window,
    thresholdPct: input.variableFeeThresholdPct ?? 0, slopeLowPct: input.variableFeeSlopeLowPct ?? 0,
    slopeMidPct: input.variableFeeSlopeMidPct ?? 0, slopeHighPct: input.variableFeeSlopeHighPct ?? 0,
    kinkPct: input.variableFeeKinkPct ?? 0, amountInAfterFee, amountOut: grossAmountOut,
    virtualBalanceIn, virtualBalanceOut, weightInBps, weightOutBps, actualBalanceOut });
  const amountOut = grossAmountOut - surgeFeeAmount;
  const netInput = amountIn - protocolFeeAmount;
  const actualInAfter = u64(bi(input.actualBalance) + netInput, "input actual balance");
  const virtualInAfter = u64(virtualBalanceIn + netInput, "input virtual balance");
  const actualOutAfter = u64(actualBalanceOut - grossAmountOut, "output actual balance");
  const virtualOutAfter = u64(virtualBalanceOut - grossAmountOut, "output virtual balance");
  const inputFees = u64(bi(input.protocolFeesOwed) + protocolFeeAmount, "input fees");
  const outputFees = u64(bi(output.protocolFeesOwed) + surgeFeeAmount, "output fees");
  if (mutate) {
    input.actualBalance = new BN(actualInAfter.toString()); input.virtualBalance = new BN(virtualInAfter.toString());
    output.actualBalance = new BN(actualOutAfter.toString()); output.virtualBalance = new BN(virtualOutAfter.toString());
    input.protocolFeesOwed = new BN(inputFees.toString()); output.protocolFeesOwed = new BN(outputFees.toString());
    if (window) {
      input.previousSelloff = new BN(window.previousSelloff.toString()); input.currentSelloff = new BN(window.currentSelloff.toString());
      input.windowStartTimestamp = new BN(window.windowStartTimestamp.toString()); input.selloffVbSnapshot = new BN(window.vbSnapshot.toString());
    }
  }
  const spotOut = calcSpotOut({ virtualBalanceIn, virtualBalanceOut, weightInBps, weightOutBps, amountIn: amountInAfterFee });
  // `window` is exposed for display math (post-trade fill %, span-average
  // surge pct) — null when the input token has no sell-off cap configured.
  return { amountOut, grossAmountOut, feeAmount, protocolFeeAmount, surgeFeeAmount, spotOut, window };
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
