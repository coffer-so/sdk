/**
 * Pure bigint port of the v6 `swap::handler` accounting (contracts `v6`,
 * `programs/cubic-pool/src/instructions/user/swap.rs`), shared by the
 * client quotes (`clients/quote-math.ts`) and the planned-zap planner.
 *
 * Order of operations is the handler's, byte for byte:
 *   1. Token-2022 transfer fee on the INPUT leg: the vault only receives
 *      `amountIn − transferFeeIn`; everything downstream uses the net.
 *   2. The input token's sell-off window advances by the NET input.
 *   3. Swap fee (ceil) on the net input; protocol share (ceil) of the fee.
 *   4. Curve output from the post-fee input; four-segment surge fee on it.
 *   5. Transfer fee on the OUTPUT leg: the vault is debited
 *      `grossAmountOut − surge`, the user receives that minus the fee.
 *   6. Reserves: input leg grows by `net − protocolFee`, output leg shrinks
 *      by the gross curve output; the OUTPUT token's window is rebased to
 *      its new virtual balance; both protocol-fee buckets grow.
 *
 * Program-equivalent failures are thrown as `MathError` with the Anchor
 * error name so the planner can treat them as "candidate infeasible".
 */
import type { TransferFee } from "@solana/spl-token";
import { calcOutGivenIn, calcSpotOut } from "./cubicMath";
import { MathError, assertU64 } from "./fixedPoint";
import { checkAndAdvanceSelloff, rescaleWindowOnVbChange, SelloffResult, SelloffState } from "./maxSelloff";
import { calculateProtocolFee, calculateSwapFee } from "./slippage";
import { calcSurgeFeeAmount, SurgeCurve } from "./surgeFee";
import { transferFeeOf } from "./transferFee";

/** One pool token as the simulator sees it (`TokenSlot` config + dynamics). */
export interface SwapLeg {
  virtualBalance: bigint;
  actualBalance: bigint;
  protocolFeesOwed: bigint;
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
  /** `Clock.unix_timestamp` the swap executes at. */
  now: bigint;
}

export interface SwapLegAfter {
  virtualBalance: bigint;
  actualBalance: bigint;
  protocolFeesOwed: bigint;
  window: SelloffState;
}

export interface SwapSimResult {
  amountIn: bigint;
  /** Token-2022 fee withheld on the input leg (`transfer_fee_in`). */
  transferFeeIn: bigint;
  /** `amountIn − transferFeeIn`: what the vault actually receives. */
  amountInNet: bigint;
  feeAmount: bigint;
  protocolFeeAmount: bigint;
  /** `amountInNet − feeAmount`: what the curve prices. */
  amountInAfterFee: bigint;
  /** Curve output before the surge fee (`amount_out`). */
  grossAmountOut: bigint;
  surgeFeeAmount: bigint;
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
  const weightInBps = input.weightBps;
  const weightOutBps = output.weightBps;

  const feeAmount = calculateSwapFee(amountInNet, p.swapFeeRate);
  if (p.swapFeeRate !== 0 && feeAmount === 0n) throw new MathError("ZeroFeeAmount");
  const amountInAfterFee = amountInNet - feeAmount;
  const protocolFeeAmount = calculateProtocolFee(feeAmount, p.protocolFeeRate);
  const amountInAfterProtocolFees = amountInNet - protocolFeeAmount;

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
  const inputFees = assertU64(input.protocolFeesOwed + protocolFeeAmount, "input protocol fees");
  const outputFees = assertU64(output.protocolFeesOwed + surgeFeeAmount, "output protocol fees");

  const inputWindow: SelloffState = window
    ? { previousSelloff: window.previousSelloff, currentSelloff: window.currentSelloff, windowStartTimestamp: window.windowStartTimestamp, selloffVbSnapshot: window.vbSnapshot }
    : { ...input.window };

  return {
    amountIn,
    transferFeeIn,
    amountInNet,
    feeAmount,
    protocolFeeAmount,
    amountInAfterFee,
    grossAmountOut,
    surgeFeeAmount,
    amountOut,
    transferFeeOut,
    amountOutReceived,
    spotOut: calcSpotOut({ virtualBalanceIn, weightInBps, virtualBalanceOut, weightOutBps, amountIn: amountInAfterFee }),
    window,
    inputAfter: { virtualBalance: virtualInAfter, actualBalance: actualInAfter, protocolFeesOwed: inputFees, window: inputWindow },
    outputAfter: { virtualBalance: virtualOutAfter, actualBalance: actualOutAfter, protocolFeesOwed: outputFees, window: outputWindow },
  };
}
