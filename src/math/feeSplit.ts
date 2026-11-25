/**
 * Normative fee cascade (v6.1, T15 §3.3 / T14) — the one place a charged
 * fee is split between the protocol, the pool creator and the LPs. Port of
 * `programs/coffer-pool/src/math/fee_split.rs`:
 *
 * ```text
 * protocol = ceil (fee · protocol_fee_rate / PROTOCOL_FEE_PRECISION)   ≤ fee
 * lp_pool  = fee − protocol
 * creator  = floor(lp_pool · creator_fee_bps / CREATOR_FEE_PRECISION)   ≤ lp_pool
 * lp       = lp_pool − creator                                           (stays in reserves)
 * ```
 *
 * The protocol's share rounds UP (dust can never zero the protocol's cut),
 * the creator's share rounds DOWN, the LPs absorb the remainder; the three
 * parts always sum to `fee`. Both call sites in `swap.rs` (base fee on the
 * input token, surge fee on the output token) use the pool's
 * `protocol_fee_rate` AND `creator_fee_bps`.
 *
 * A rate above its precision fails closed (`MathError` with the program's
 * error name) instead of booking a negative LP share.
 */
import { CREATOR_FEE_PRECISION, PROTOCOL_FEE_PRECISION } from "../config";
import { MathError, assertU64 } from "./fixedPoint";

/** One fee, split three ways. `protocol + creator + lp == fee` always. */
export interface FeeSplit {
  /** Protocol's share (rounded up). Booked to `protocol_fees_owed`. */
  protocol: bigint;
  /** Pool admin's ("creator's") share (rounded down). Booked to `creator_fees_owed`. */
  creator: bigint;
  /** LPs' share — the remainder. Stays in the trading reserves (or the surge bucket). */
  lp: bigint;
}

function rate(value: number, max: number, error: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new MathError(`${error}: invalid rate`);
  if (value > max) throw new MathError(error);
  return BigInt(value);
}

/**
 * `split_fee(fee, protocol_fee_rate, creator_fee_bps)`.
 *
 * @param fee the charged fee (swap fee or surge fee), raw units (u64).
 * @param protocolFeeRate `pool.protocol_fee_rate`, bps of `PROTOCOL_FEE_PRECISION` (0..=10_000).
 * @param creatorFeeBps `pool.creator_fee_bps`, bps of `CREATOR_FEE_PRECISION` (0..=10_000).
 * @throws MathError `ProtocolFeeRateMaxExceeded` / `CreatorFeeBpsMaxExceeded` for a rate above 100 %.
 */
export function splitFee(fee: bigint, protocolFeeRate: number, creatorFeeBps: number): FeeSplit {
  assertU64(fee, "fee");
  const pr = rate(protocolFeeRate, PROTOCOL_FEE_PRECISION, "ProtocolFeeRateMaxExceeded");
  const cr = rate(creatorFeeBps, CREATOR_FEE_PRECISION, "CreatorFeeBpsMaxExceeded");
  const protocolScale = BigInt(PROTOCOL_FEE_PRECISION);
  const creatorScale = BigInt(CREATOR_FEE_PRECISION);
  const num = fee * pr;
  const protocol = num / protocolScale + (num % protocolScale === 0n ? 0n : 1n);
  const lpPool = fee - protocol;
  if (lpPool < 0n) throw new MathError("MathUnderflow");
  const creator = (lpPool * cr) / creatorScale;
  const lp = lpPool - creator;
  if (lp < 0n) throw new MathError("MathUnderflow");
  return { protocol, creator, lp };
}

/** `FeeSplit::non_lp`: `protocol + creator` — what leaves the LP reserves. */
export function nonLpShare(split: FeeSplit): bigint {
  return split.protocol + split.creator;
}

/** `FeeSplit::total`: the fee the split was computed from. */
export function feeSplitTotal(split: FeeSplit): bigint {
  return split.protocol + split.creator + split.lp;
}
