/**
 * Token-2022 `TransferFee` math, mirroring `util/transfer_fee.rs` (contracts
 * `v6`) and the SPL `TransferFee` helpers the program calls.
 *
 * Every `transfer_checked` debits the source in full while the destination
 * receives `amount − fee`; the fee is withheld for the mint's withdraw
 * authority and is never pool liquidity. Pool accounting therefore credits
 * the fee-EXCLUDED amount on the way in and quotes it on the way out, and a
 * deposit that must land exactly `credit` in the vault is grossed up with
 * the inverse fee.
 *
 * The schedule is epoch-aware: `newer` applies from its activation epoch,
 * `older` before it. Select it with the epoch of the snapshot you quote on.
 */
import type { TransferFee, TransferFeeConfig } from "@solana/spl-token";
import { calculateFee } from "@solana/spl-token";
import { MathError, assertU64 } from "./fixedPoint";

/** `MAX_FEE_BASIS_POINTS`: a 100 % fee takes `maximumFee` of every transfer. */
export const MAX_FEE_BASIS_POINTS = 10_000;
const ONE_IN_BASIS_POINTS = 10_000n;

export type { TransferFee, TransferFeeConfig };

/** The schedule in force at `epoch` (SPL `get_epoch_fee`). */
export function selectEpochFee(config: TransferFeeConfig, epoch: bigint): TransferFee {
  return epoch >= config.newerTransferFee.epoch ? config.newerTransferFee : config.olderTransferFee;
}

/** Fee withheld when `gross` is transferred under `schedule` (`calculate_fee`: ceil, capped at `maximumFee`). */
export function transferFeeOf(schedule: TransferFee | null | undefined, gross: bigint): bigint {
  assertU64(gross, "gross");
  if (!schedule) return 0n;
  return assertU64(calculateFee(schedule, gross), "transfer fee");
}

/** `gross − fee`: what the destination actually receives. */
export function netOfTransferFee(schedule: TransferFee | null | undefined, gross: bigint): bigint {
  return gross - transferFeeOf(schedule, gross);
}

/** SPL `calculate_pre_fee_amount`: the smallest gross whose net is at least `net`. */
function preFeeAmount(schedule: TransferFee, net: bigint): bigint {
  const bps = BigInt(schedule.transferFeeBasisPoints);
  const maximumFee = schedule.maximumFee;
  if (bps === 0n) return net;
  if (net === 0n) return 0n;
  if (bps === ONE_IN_BASIS_POINTS) return assertU64(maximumFee + net, "pre-fee amount");
  const numerator = net * ONE_IN_BASIS_POINTS;
  const denominator = ONE_IN_BASIS_POINTS - bps;
  const raw = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  if (raw - net >= maximumFee) return assertU64(net + maximumFee, "pre-fee amount");
  return assertU64(raw, "pre-fee amount");
}

/**
 * Fee to ADD on top of `net` so the destination receives at least `net`
 * (port of `get_transfer_inverse_fee` / `FeeSchedule::gross`): the SPL
 * inverse, the `10_000 bps → maximumFee` special case, and a round-trip
 * check so a rounding quirk can never under-credit the pool.
 */
export function inverseTransferFee(schedule: TransferFee | null | undefined, net: bigint): bigint {
  assertU64(net, "net");
  if (!schedule || schedule.transferFeeBasisPoints === 0 || net === 0n) return 0n;
  const fee =
    schedule.transferFeeBasisPoints === MAX_FEE_BASIS_POINTS
      ? schedule.maximumFee
      : transferFeeOf(schedule, preFeeAmount(schedule, net));
  const gross = assertU64(net + fee, "gross");
  if (transferFeeOf(schedule, gross) > fee) throw new MathError("TransferFeeCalculationMismatch");
  return fee;
}

/** `net + inverseTransferFee(net)`: what to debit so the destination nets `net`. */
export function grossOfTransferFee(schedule: TransferFee | null | undefined, net: bigint): bigint {
  return net + inverseTransferFee(schedule, net);
}
