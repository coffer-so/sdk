/**
 * Pure bigint port of the v6.1 `swap::handler` accounting (contracts
 * `v6.1`, `programs/coffer-pool/src/instructions/user/swap.rs`), shared by
 * the client quotes (`clients/quote-math.ts`) and the planned-zap planner.
 *
 * Order of operations is the handler's, byte for byte:
 *   1. Token-2022 transfer fee on the INPUT leg: the vault only receives
 *      `amountIn − transferFeeIn`; everything downstream uses the net.
 *   2. The input token's sell-off window advances by the NET input.
 *   3. T10: a sidelined OUTPUT (`actual_balance_out == 0`) fails with
 *      `InsufficientLiquidity` before any fee / curve math.
 *   4. T9: the effective fee rate — a dynamic-fee hook's override clamped
 *      into `[hookFeeMin, hookFeeMax]`, else `swapFeeRate`.
 *   5. Swap fee (ceil) on the net input, split by the T15/T14 cascade
 *      (`splitFee`): protocol (ceil) → creator (floor of the rest) → LP.
 *   6. Curve output from the post-fee input; four-segment surge fee on it,
 *      split by the SAME cascade; the LP share goes to the output token's
 *      surge bucket (T12), outside the curve.
 *   7. Transfer fee on the OUTPUT leg: the vault is debited
 *      `grossAmountOut − surge`, the user receives that minus the fee.
 *   8. Reserves: input leg grows by `net − protocol − creator`, output leg
 *      (virtual AND actual) shrinks by the GROSS curve output; the OUTPUT
 *      token's window is rebased to its new virtual balance; the owed
 *      buckets grow: `protocol[in] += protocol`, `creator[in] += creator`,
 *      `protocol[out] += surgeProtocol`, `creator[out] += surgeCreator`,
 *      `surge[out] += surgeLp`.
 *
 * Program-equivalent failures are thrown as `MathError` with the Anchor
 * error name so the planner can treat them as "candidate infeasible".
 */
import type { TransferFee } from "@solana/spl-token";
import { calcOutGivenIn, calcSpotOut } from "./poolMath";
import { MathError, assertU64 } from "./fixedPoint";
import { checkAndAdvanceSelloff, rescaleWindowOnVbChange, SelloffResult, SelloffState } from "./maxSelloff";
import { calculateSwapFee } from "./slippage";
import { calcSurgeFeeAmount, SurgeCurve } from "./surgeFee";
import { transferFeeOf } from "./transferFee";
import { splitFee } from "./feeSplit";
import { MAX_SWAP_FEE_RATE } from "../config";

/** One pool token as the simulator sees it (`TokenSlot` config + dynamics + the v6.1 pool-level buckets). */
export interface SwapLeg {
  virtualBalance: bigint;
  actualBalance: bigint;
  protocolFeesOwed: bigint;
  /** v6.1 (T14): `creator_fees_owed[i]`; `undefined` = 0 (v5 reading). */
  creatorFeesOwed?: bigint;
  /** v6.1 (T12): `surge_fees_owed[i]` — the LP holders' surge bucket; `undefined` = 0. */
  surgeFeesOwed?: bigint;
  weightBps: bigint;
  isActive: boolean;
  maxSelloffPct: number;
  maxSelloffPeriodLength: number;
  curve: SurgeCurve;
  window: SelloffState;
  /** Transfer-fee schedule in force at the quoted epoch; `null` for fee-less mints. */
  transferFee: TransferFee | null;
}

export interface SwapSimParams {
  input: SwapLeg;
  output: SwapLeg;
  /** Gross input the user signs for (`amount_in`). */
  amountIn: bigint;
  swapFeeRate: number;
  protocolFeeRate: number;
  /** v6.1 (T14): `pool.creator_fee_bps` (default 0). */
  creatorFeeBps?: number;
  /**
   * v6.1 (T9): the fee rate a `DYNAMIC_FEE` hook returned for this swap
   * (hundredths of bps). Clamped into `[hookFeeMin, hookFeeMax]` exactly
   * like `hooks::clamp_fee_override`. `undefined` ⇒ `swapFeeRate`.
   */
  hookFeeOverride?: number;
  hookFeeMin?: number;
  hookFeeMax?: number;
  /** `Clock.unix_timestamp` the swap executes at. */
  now: bigint;
}

export interface SwapLegAfter {
  virtualBalance: bigint;
  actualBalance: bigint;
  protocolFeesOwed: bigint;
  creatorFeesOwed: bigint;
  surgeFeesOwed: bigint;
  window: SelloffState;
}

export interface SwapSimResult {
  amountIn: bigint;
  /** Token-2022 fee withheld on the input leg (`transfer_fee_in`). */
  transferFeeIn: bigint;
  /** `amountIn − transferFeeIn`: what the vault actually receives. */
  amountInNet: bigint;
  /** The rate the cascade ran on (`Swap.effective_fee_rate`): the clamped hook override or `swapFeeRate`. */
  effectiveFeeRate: number;
  feeAmount: bigint;
  /** Protocol share of `feeAmount` (ceil at `protocolFeeRate`); booked to `protocol_fees_owed[in]`. */
  protocolFeeAmount: bigint;
  /** v6.1 (T14): pool admin's share of `feeAmount`; booked to `creator_fees_owed[in]`. */
  creatorFeeAmount: bigint;
  /** LP share of `feeAmount` (`feeAmount − protocol − creator`); stays in the input reserves. */
  lpFeeAmount: bigint;
  /** `amountInNet − feeAmount`: what the curve prices. */
  amountInAfterFee: bigint;
  /** Curve output before the surge fee (`amount_out`). */
  grossAmountOut: bigint;
  /** Total surge fee on the output token. */
  surgeFeeAmount: bigint;
  /** v6.1 (T15): protocol share of the surge; booked to `protocol_fees_owed[out]`. */
  surgeProtocolFeeAmount: bigint;
  /** v6.1 (T14): pool admin's share of the surge; booked to `creator_fees_owed[out]`. */
  surgeCreatorFeeAmount: bigint;
  /** v6.1 (T12): LP holders' share of the surge; booked to `surge_fees_owed[out]` (outside the curve). */
  surgeLpFeeAmount: bigint;
  /** `grossAmountOut − surgeFeeAmount`: the vault debit and the event's `amount_out`. */
  amountOut: bigint;
  /** Token-2022 fee withheld on the output leg (`transfer_fee_out`). */
  transferFeeOut: bigint;
  /** `amountOut − transferFeeOut`: what lands in the user's account; the slippage floor compares to this. */
  amountOutReceived: bigint;
  /** Spot-price output of the post-fee input (price-impact baseline). */
  spotOut: bigint;
  /** Input-token window after the advance; `null` when its cap is disabled. */
  window: SelloffResult | null;
  inputAfter: SwapLegAfter;
  outputAfter: SwapLegAfter;
}

/** `hooks::clamp_fee_override`: `fee.clamp(min, max)` (Rust panics on `min > max`; here a `MathError`). */
export function clampHookFeeOverride(fee: number, feeMin: number, feeMax: number): number {
  for (const [v, label] of [[fee, "hook fee override"], [feeMin, "hook fee min"], [feeMax, "hook fee max"]] as const) {
    if (!Number.isSafeInteger(v) || v < 0 || v > MAX_SWAP_FEE_RATE) throw new MathError(`${label}: outside 0..=${MAX_SWAP_FEE_RATE}`);
  }
  if (feeMin > feeMax) throw new MathError("InvalidHookConfig");
  return Math.min(Math.max(fee, feeMin), feeMax);
}

/** `swap.rs` `effective_fee_rate`: the clamped hook override when one is set, else the pool's rate. */
export function effectiveSwapFeeRate(p: Pick<SwapSimParams, "swapFeeRate" | "hookFeeOverride" | "hookFeeMin" | "hookFeeMax">): number {
  return p.hookFeeOverride === undefined ? p.swapFeeRate : clampHookFeeOverride(p.hookFeeOverride, p.hookFeeMin ?? 0, p.hookFeeMax ?? 0);
}

export function simulateSwap(p: SwapSimParams): SwapSimResult {
  const { input, output, amountIn, now } = p;
  assertU64(amountIn, "amountIn");
  if (amountIn === 0n) throw new MathError("ZeroAmount");
  if (!input.isActive) throw new MathError("TokenInactive");

  const transferFeeIn = transferFeeOf(input.transferFee, amountIn);
  const amountInNet = amountIn - transferFeeIn;
  if (amountInNet <= 0n) throw new MathError("AmountFullyConsumedByTransferFee");

  const virtualBalanceIn = input.virtualBalance;
  const window = checkAndAdvanceSelloff({
    state: input.window,
    maxSelloffPct: input.maxSelloffPct,
    period: input.maxSelloffPeriodLength,
    amountIn: amountInNet,
    virtualBalance: virtualBalanceIn,
    now,
  });

  const virtualBalanceOut = output.virtualBalance;
  const actualBalanceOut = output.actualBalance;
  // T10 `check_output_side_live`: a sidelined output has nothing to pay out
  // of — fail before the fee / curve math, never a 0-out "quote".
  if (actualBalanceOut === 0n) throw new MathError("InsufficientLiquidity");
  const weightInBps = input.weightBps;
  const weightOutBps = output.weightBps;

  const effectiveFeeRate = effectiveSwapFeeRate(p);
  const creatorFeeBps = p.creatorFeeBps ?? 0;
  const feeAmount = calculateSwapFee(amountInNet, effectiveFeeRate);
  if (effectiveFeeRate !== 0 && feeAmount === 0n) throw new MathError("ZeroFeeAmount");
  const amountInAfterFee = amountInNet - feeAmount;
  const swapSplit = splitFee(feeAmount, p.protocolFeeRate, creatorFeeBps);
  const amountInAfterProtocolFees = amountInNet - swapSplit.protocol - swapSplit.creator;

  const curve = { virtualBalanceIn, weightInBps, virtualBalanceOut, weightOutBps, actualBalanceOut };
  const grossAmountOut = calcOutGivenIn({ ...curve, amountIn: amountInAfterFee });

  // The handler feeds `amount_in_after_fee · (u − before) / span` back into
  // the curve for every segment boundary; `span` is the NET input.
  const surgeFeeAmount = window
    ? calcSurgeFeeAmount({
        before: window.effectiveSelloffBefore,
        after: window.effectiveSelloff,
        cap: window.maxSelloffCap,
        curve: input.curve,
        amountOut: grossAmountOut,
        cumulativeOut: (u) => {
          const span = window.effectiveSelloff - window.effectiveSelloffBefore;
          return calcOutGivenIn({ ...curve, amountIn: (amountInAfterFee * (u - window.effectiveSelloffBefore)) / span });
        },
      })
    : 0n;
  const amountOut = grossAmountOut - surgeFeeAmount;
  if (amountOut < 0n) throw new MathError("MathUnderflow");
  const surgeSplit = splitFee(surgeFeeAmount, p.protocolFeeRate, creatorFeeBps);
  const transferFeeOut = transferFeeOf(output.transferFee, amountOut);
  const amountOutReceived = amountOut - transferFeeOut;
  // `calc_out_given_in` already bounds the gross output by `actual_balance_out`.
  if (grossAmountOut > actualBalanceOut) throw new MathError("InsufficientLiquidity");

  const virtualInAfter = assertU64(virtualBalanceIn + amountInAfterProtocolFees, "input virtual balance");
  const virtualOutAfter = virtualBalanceOut - grossAmountOut;
  if (virtualOutAfter < 0n) throw new MathError("MathUnderflow");
  const outputWindow = rescaleWindowOnVbChange(output.window, virtualBalanceOut, virtualOutAfter);
  const actualInAfter = assertU64(input.actualBalance + amountInAfterProtocolFees, "input actual balance");
  const actualOutAfter = actualBalanceOut - grossAmountOut;
  const inputProtocol = assertU64(input.protocolFeesOwed + swapSplit.protocol, "input protocol fees");
  const outputProtocol = assertU64(output.protocolFeesOwed + surgeSplit.protocol, "output protocol fees");
  const inputCreator = assertU64((input.creatorFeesOwed ?? 0n) + swapSplit.creator, "input creator fees");
  const outputCreator = assertU64((output.creatorFeesOwed ?? 0n) + surgeSplit.creator, "output creator fees");
  const outputSurge = output.surgeFeesOwed ?? 0n;
  const outputSurgeAfter = outputSurge + surgeSplit.lp;
  if (outputSurgeAfter > (1n << 64n) - 1n) throw new MathError("SurgeBucketOverflow");

  const inputWindow: SelloffState = window
    ? { previousSelloff: window.previousSelloff, currentSelloff: window.currentSelloff, windowStartTimestamp: window.windowStartTimestamp, selloffVbSnapshot: window.vbSnapshot }
    : { ...input.window };

  return {
    amountIn,
    transferFeeIn,
    amountInNet,
    effectiveFeeRate,
    feeAmount,
    protocolFeeAmount: swapSplit.protocol,
    creatorFeeAmount: swapSplit.creator,
    lpFeeAmount: swapSplit.lp,
    amountInAfterFee,
    grossAmountOut,
    surgeFeeAmount,
    surgeProtocolFeeAmount: surgeSplit.protocol,
    surgeCreatorFeeAmount: surgeSplit.creator,
    surgeLpFeeAmount: surgeSplit.lp,
    amountOut,
    transferFeeOut,
    amountOutReceived,
    spotOut: calcSpotOut({ virtualBalanceIn, weightInBps, virtualBalanceOut, weightOutBps, amountIn: amountInAfterFee }),
    window,
    inputAfter: { virtualBalance: virtualInAfter, actualBalance: actualInAfter, protocolFeesOwed: inputProtocol, creatorFeesOwed: inputCreator, surgeFeesOwed: input.surgeFeesOwed ?? 0n, window: inputWindow },
    outputAfter: { virtualBalance: virtualOutAfter, actualBalance: actualOutAfter, protocolFeesOwed: outputProtocol, creatorFeesOwed: outputCreator, surgeFeesOwed: outputSurgeAfter, window: outputWindow },
  };
}
