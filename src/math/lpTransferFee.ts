/**
 * LP transfer fee math (2026-11-19), mirroring `util/transfer_fee.rs`
 * (`transfer_fee_bps_at`, `scheduled_transfer_fee_bps`) and
 * `math/lp_transfer_fee.rs` (`split_lp_transfer_fee`, `lp_transfer_fee_drip`,
 * `lp_transfer_fee_settle`, `lp_transfer_fee_schedule`).
 *
 * Burn stream (L-1, X1): `collect_lp_transfer_fees` never burns at
 * collection. The burn part is queued in `lp_transfer_fees_pending_burn` and
 * vests linearly over `[lp_transfer_fee_burn_last_ts,
 * lp_transfer_fee_burn_end_ts]`; every collect burns `drip(now)` = the
 * elapsed share of the segment (`lpTransferFeeDrip`), settles the stream
 * (`lpTransferFeeSettle`: `lastTs` moves only when something burned) and
 * schedules the new burn part (`lpTransferFeeSchedule`: the end becomes the
 * amount-weighted average of the old end and `now + 86_400`, the accrued
 * fraction of a unit is carried). A collect at zero elapsed burns 0; however
 * often collect is called the stream completes exactly at `endTs`; `k`
 * collects over the same time burn within `k` units of a single call.
 *
 * Every LP mint created since the feature carries a Token-2022
 * `TransferFeeConfig` whose two authorities are the pool PDA and whose
 * `maximum_fee` is `u64::MAX` (purely proportional). Token-2022 withholds
 * `ceil(amount · bps / 10_000)` (capped at `maximum_fee`) of every
 * holder-to-holder LP transfer in LP units; mint (`add_liquidity`,
 * `seed_liquidity`) and burn (`remove_liquidity`, the collection burn, the
 * protocol redemption) are never charged.
 *
 * The schedule is epoch-aware (Token-2022's two-epoch activation): `newer`
 * applies once the chain epoch reaches `newer.epoch`, `older` before.
 * `set_lp_transfer_fee` writes `newer`, so `scheduledLpTransferFeeBps` is
 * what the pool admin last scheduled and `LpTransferFeeUpdated.old_bps`
 * reports.
 */
import type { TransferFee, TransferFeeConfig } from "@solana/spl-token";
import {
  LP_TRANSFER_FEE_BURN_WINDOW_SECS,
  LP_TRANSFER_FEE_PRECISION,
  MAX_LP_TRANSFER_FEE_BPS,
  MAX_LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS,
} from "../config";
import { MathError, U64_MAX, assertU64 } from "./fixedPoint";
import { grossOfTransferFee, selectEpochFee } from "./transferFee";

const PRECISION = BigInt(LP_TRANSFER_FEE_PRECISION);
const WINDOW = BigInt(LP_TRANSFER_FEE_BURN_WINDOW_SECS);
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export type { TransferFee, TransferFeeConfig };

/** Outcome of one `collect_lp_transfer_fees` split (`protocol + burn == collected`). */
export interface LpFeeSplit {
  /** LP units kept for the protocol (booked to `lp_transfer_fees_owed_protocol`). */
  protocol: bigint;
  /** LP units scheduled for burning (queued in `lp_transfer_fees_pending_burn`, released by `lpTransferFeeDrip`). */
  burn: bigint;
}

function assertI64(value: bigint | number, name: string): bigint {
  const v = typeof value === "number" ? (Number.isSafeInteger(value) ? BigInt(value) : null) : value;
  if (v === null || v < I64_MIN || v > I64_MAX) throw new MathError(`${name}: not an i64`);
  return v;
}

/** `0..=MAX_LP_TRANSFER_FEE_BPS` (10 %), as `initialize_pool` / `set_lp_transfer_fee` check it (`LpTransferFeeMaxExceeded`, 6111). */
export function validateLpTransferFeeBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_LP_TRANSFER_FEE_BPS) {
    throw new Error(`lpTransferFeeBps must be an integer 0..=${MAX_LP_TRANSFER_FEE_BPS} (LpTransferFeeMaxExceeded, 6111)`);
  }
  return bps;
}

/** `0..=MAX_LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS` (100 %), as `set_lp_transfer_fee_protocol_share` checks it (`LpTransferFeeProtocolShareMaxExceeded`, 6113). */
export function validateLpTransferFeeProtocolShareBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS) {
    throw new Error(`lpTransferFeeProtocolShareBps must be an integer 0..=${MAX_LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS} (LpTransferFeeProtocolShareMaxExceeded, 6113)`);
  }
  return bps;
}

/**
 * The schedule in force at `epoch` (`get_epoch_fee`: `newer` once
 * `epoch >= newer.epoch`, else `older`); `null` without the extension.
 */
export function lpTransferFeeAt(config: TransferFeeConfig | null | undefined, epoch: bigint | number): TransferFee | null {
  if (!config) return null;
  const e = BigInt(epoch);
  if (e < 0n) throw new MathError("epoch: negative");
  return selectEpochFee(config, e);
}

/** Basis points charged at `epoch` (`transfer_fee_bps_at`); `0` without the extension. */
export function lpTransferFeeBpsAt(config: TransferFeeConfig | null | undefined, epoch: bigint | number): number {
  return lpTransferFeeAt(config, epoch)?.transferFeeBasisPoints ?? 0;
}

/**
 * The latest rate the pool admin scheduled (`newer_transfer_fee`,
 * `scheduled_transfer_fee_bps`): `set_lp_transfer_fee` reports it as
 * `old_bps`. `0` without the extension.
 */
export function scheduledLpTransferFeeBps(config: TransferFeeConfig | null | undefined): number {
  return config?.newerTransferFee.transferFeeBasisPoints ?? 0;
}

/**
 * Token-2022 `TransferFee::calculate_fee`: `ceil(amount · bps / 10_000)`
 * capped at `maximumFee`; `0` for a zero rate, a zero amount or no schedule.
 * LP units in, LP units out.
 */
export function lpTransferFeeOf(schedule: TransferFee | null | undefined, amount: bigint): bigint {
  assertU64(amount, "amount");
  if (!schedule) return 0n;
  const bps = BigInt(schedule.transferFeeBasisPoints);
  if (bps < 0n || bps > PRECISION) throw new MathError("transferFeeBasisPoints: outside 0..=10_000");
  if (bps === 0n || amount === 0n) return 0n;
  const numerator = amount * bps;
  const raw = numerator / PRECISION + (numerator % PRECISION === 0n ? 0n : 1n);
  const maximumFee = assertU64(schedule.maximumFee, "maximumFee");
  return raw > maximumFee ? maximumFee : raw;
}

/** `amount − lpTransferFeeOf(amount)`: the LP units the destination actually receives. */
export function lpNetOfTransferFee(schedule: TransferFee | null | undefined, amount: bigint): bigint {
  return amount - lpTransferFeeOf(schedule, amount);
}

/**
 * What a holder-to-holder LP transfer of `amount` yields at `epoch`:
 * the schedule used, the withheld fee and the net credit. Mint and burn
 * paths never use this (they are fee-free).
 */
export function lpReceivedAfterTransferFee(
  config: TransferFeeConfig | null | undefined,
  epoch: bigint | number,
  amount: bigint,
): { schedule: TransferFee | null; fee: bigint; net: bigint } {
  const schedule = lpTransferFeeAt(config, epoch);
  const fee = lpTransferFeeOf(schedule, amount);
  return { schedule, fee, net: amount - fee };
}

/**
 * Inverse: the smallest gross LP amount to transfer so the destination nets
 * at least `net` under `schedule` (SPL `calculate_pre_fee_amount` +
 * round-trip check, via `grossOfTransferFee`). A 100 % rate is unreachable
 * for LP mints (cap 10 %) but handled like SPL does.
 */
export function lpGrossForNet(schedule: TransferFee | null | undefined, net: bigint): bigint {
  const gross = grossOfTransferFee(schedule, net);
  if (lpNetOfTransferFee(schedule, gross) < net) throw new MathError("TransferFeeCalculationMismatch");
  return gross;
}

/**
 * `split_lp_transfer_fee`: `protocol = floor(collected · share / 10_000)`,
 * `burn = collected − protocol`. Rounding favours the burn; `protocol == 0`
 * iff `share == 0` or `collected · share < 10_000`; `burn == 0` iff
 * `share == 10_000` or `collected == 0`.
 */
export function splitLpTransferFee(collected: bigint, shareBps: number): LpFeeSplit {
  assertU64(collected, "collected");
  validateLpTransferFeeProtocolShareBps(shareBps);
  const protocol = (collected * BigInt(shareBps)) / PRECISION;
  return { protocol, burn: collected - protocol };
}

// ─── Burn stream (L-1 / X1: linear vesting with an end) ─────────────────────

const U128_MAX = (1n << 128n) - 1n;

/** The stream triple `CofferPool` keeps @2134 / @2142 / @2160 (`math::LpBurnStream`). */
export interface LpBurnStream {
  /** `lp_transfer_fees_pending_burn`: LP units still to burn. */
  pending: bigint;
  /** `lp_transfer_fee_burn_last_ts`: start of the current linear segment (the last settle that burned). */
  lastTs: bigint;
  /** `lp_transfer_fee_burn_end_ts`: Unix time at which `pending` is fully burnable. */
  endTs: bigint;
}

/** `i64::saturating_sub`. */
function satSubI64(a: bigint, b: bigint): bigint {
  const d = a - b;
  return d > I64_MAX ? I64_MAX : d < I64_MIN ? I64_MIN : d;
}

function checkedI64(value: bigint): bigint {
  if (value < I64_MIN || value > I64_MAX) throw new MathError("MathOverflow");
  return value;
}

/** The stream triple as bigints (BN / number / bigint in; `0n` for a missing field, as a migrated pool reads it). */
export function lpBurnStreamOf(source: {
  lpTransferFeesPendingBurn?: { toString(): string } | bigint | number | null;
  lpTransferFeeBurnLastTs?: { toString(): string } | bigint | number | null;
  lpTransferFeeBurnEndTs?: { toString(): string } | bigint | number | null;
}): LpBurnStream {
  const big = (v: { toString(): string } | bigint | number | null | undefined): bigint => (v === undefined || v === null ? 0n : BigInt(v.toString()));
  return {
    pending: assertU64(big(source.lpTransferFeesPendingBurn), "pending"),
    lastTs: assertI64(big(source.lpTransferFeeBurnLastTs), "lastTs"),
    endTs: assertI64(big(source.lpTransferFeeBurnEndTs), "endTs"),
  };
}

function normalizeStream(s: LpBurnStream): LpBurnStream {
  return { pending: assertU64(s.pending, "pending"), lastTs: assertI64(s.lastTs, "lastTs"), endTs: assertI64(s.endTs, "endTs") };
}

/**
 * `lp_transfer_fee_drip(pending, last_ts, end_ts, now)`: LP the stream
 * releases at `now` out of `pending` vesting linearly over `[lastTs, endTs]`:
 *
 * ```text
 * drip = 0                                              if pending == 0 or now <= lastTs
 *      = pending                                        if now >= endTs
 *      = floor(pending · (now − lastTs) / (endTs − lastTs))   otherwise
 * ```
 *
 * A clock that did not move (same slot) or went backwards burns 0; a zeroed
 * (legacy / migrated) triple burns 0 and never divides; `endTs == lastTs`
 * with something pending (unreachable) releases everything one second
 * after `lastTs`. The two differences are `i64::saturating_sub` (only absurd
 * timestamps saturate). Monotone in both `pending` and `now`; `drip ≤ pending`.
 */
export function lpTransferFeeDrip(pending: bigint, lastTs: bigint | number, endTs: bigint | number, now: bigint | number): bigint {
  assertU64(pending, "pending");
  const last = assertI64(lastTs, "lastTs");
  const end = assertI64(endTs, "endTs");
  const n = assertI64(now, "now");
  if (pending === 0n || n <= last) return 0n;
  if (n >= end) return pending;
  // last < now < end ⇒ both positive, elapsed < duration, quotient < pending.
  const elapsed = satSubI64(n, last);
  const duration = satSubI64(end, last);
  return (pending * elapsed) / duration;
}

/**
 * `CofferPool::priced_lp_supply(mint_supply, now)`: the LP supply every
 * join, exit, protocol redemption, route join and sidelined-slot funding is
 * priced on — the mint supply net of the part of the burn stream that has
 * vested at `now` (`lpTransferFeeDrip`), which no holder owns any more.
 * Hooks and events still see the mint supply. Throws
 * `MathError("MathUnderflow")` when the drip exceeds the mint supply
 * (inconsistent state; 6012 on chain).
 */
export function pricedLpSupply(mintSupply: bigint, stream: LpBurnStream, now: bigint | number): bigint {
  assertU64(mintSupply, "mintSupply");
  const drip = lpTransferFeeDrip(stream.pending, stream.lastTs, stream.endTs, now);
  if (drip > mintSupply) throw new MathError("MathUnderflow");
  return mintSupply - drip;
}

/**
 * {@link pricedLpSupply} of a pool snapshot: `lpTotalSupply` (the mint
 * supply) net of the vested burn stream at `now` (defaults to the synced
 * `chainTimestamp`). Without any timestamp a pool with a pending burn
 * stream cannot be priced and this throws; a pool without a stream prices
 * on the mint supply.
 */
export function pricedLpSupplyOf(pool: {
  lpTotalSupply: { toString(): string } | bigint;
  chainTimestamp?: number;
  lpTransferFeesPendingBurn?: { toString(): string } | bigint | number | null;
  lpTransferFeeBurnLastTs?: { toString(): string } | bigint | number | null;
  lpTransferFeeBurnEndTs?: { toString(): string } | bigint | number | null;
}, nowSeconds?: bigint | number): bigint {
  const mintSupply = BigInt(pool.lpTotalSupply.toString());
  const stream = lpBurnStreamOf(pool);
  if (stream.pending === 0n) return assertU64(mintSupply, "mintSupply");
  const now = nowSeconds ?? pool.chainTimestamp;
  if (now === undefined) throw new MathError("Chain timestamp missing: sync or supply nowSeconds to price the LP burn stream");
  return pricedLpSupply(mintSupply, stream, now);
}

/**
 * `lp_transfer_fee_settle(s, burned, now)`: the stream after burning
 * `burned` (≤ `drip(now)`) at `now` — the remainder keeps its end, the
 * segment start moves to `now` only when something burned (a collect whose
 * drip floored to 0 keeps accruing), an emptied stream collapses to
 * `lastTs == endTs == now`. Throws `MathError("MathUnderflow")` when
 * `burned > pending` (6012 on chain).
 */
export function lpTransferFeeSettle(s: LpBurnStream, burned: bigint, now: bigint | number): LpBurnStream {
  const { pending: before, lastTs, endTs } = normalizeStream(s);
  assertU64(burned, "burned");
  const n = assertI64(now, "now");
  const pending = before - burned;
  if (pending < 0n) throw new MathError("MathUnderflow");
  if (pending === 0n) return { pending: 0n, lastTs: n, endTs: n };
  return { pending, lastTs: burned > 0n ? n : lastTs, endTs };
}

/**
 * `lp_transfer_fee_schedule(s, amount, now)`: the stream after queueing
 * `amount` at `now`, right after `lpTransferFeeSettle(_, _, now)`:
 *
 * ```text
 * A == 0                → unchanged
 * P == 0                → (A, now, now + W)
 * else, with rem = min(max(E − now, 0), W), el = max(now − L, 0), d = max(E − L, 1), T = P + A:
 *   D = max(floor((P · rem + A · W) / T), 1)          amount-weighted duration (≥ rem, ≤ W)
 *   g = min(P · el, d − 1)                             accrued fraction of a unit, g / d < 1
 *   δ = 0 if g == 0 else min(ceil(g · D / (d · T − g)), floor((D − 1) / (T − 1)))
 *   (T, now − δ, now + D)
 * ```
 *
 * `W = LP_TRANSFER_FEE_BURN_WINDOW_SECS`. The end becomes the amount-weighted
 * average of the old end and `now + W` (floor: dust cannot push it), the old
 * accrual is carried as `δ` seconds of the new rate (ceil, capped strictly
 * below one unit: dust cannot hold it back, nothing of `A` is burnable at
 * zero elapsed). Throws `MathError("MathOverflow")` where the program does
 * (6011): `P + A > u64::MAX`, an end past `i64::MAX`, a u128 product overflow.
 */
export function lpTransferFeeSchedule(s: LpBurnStream, amount: bigint, now: bigint | number): LpBurnStream {
  const { pending, lastTs, endTs } = normalizeStream(s);
  assertU64(amount, "amount");
  const n = assertI64(now, "now");
  if (amount === 0n) return { pending, lastTs, endTs };
  const total = pending + amount;
  if (total > U64_MAX) throw new MathError("MathOverflow");
  if (pending === 0n) return { pending: total, lastTs: n, endTs: checkedI64(n + WINDOW) };
  const remRaw = satSubI64(endTs, n);
  const remPos = remRaw < 0n ? 0n : remRaw;
  const rem = remPos < WINDOW ? remPos : WINDOW;
  const elapsedRaw = satSubI64(n, lastTs);
  const elapsed = elapsedRaw < 0n ? 0n : elapsedRaw;
  const dRaw = satSubI64(endTs, lastTs);
  const d = dRaw < 1n ? 1n : dRaw;
  const weighted = pending * rem + amount * WINDOW;
  if (weighted > U128_MAX) throw new MathError("MathOverflow");
  let duration = weighted / total;
  if (duration < 1n) duration = 1n;
  const accrued = pending * elapsed;
  if (accrued > U128_MAX) throw new MathError("MathOverflow");
  const g = accrued < d - 1n ? accrued : d - 1n;
  let shift = 0n;
  if (g > 0n) {
    const dt = d * total;
    if (dt > U128_MAX) throw new MathError("MathOverflow");
    const denom = dt - g;
    const num = g * duration;
    if (num > U128_MAX) throw new MathError("MathOverflow");
    const carried = num / denom + (num % denom === 0n ? 0n : 1n);
    const cap = (duration - 1n) / (total - 1n);
    shift = carried < cap ? carried : cap;
  }
  checkedI64(duration);
  checkedI64(shift);
  return { pending: total, lastTs: checkedI64(n - shift), endTs: checkedI64(n + duration) };
}

/** Steps 3–5 of one `collect_lp_transfer_fees` over the pool's bookkeeping (`collectLpTransferFeeStep`). */
export interface LpTransferFeeCollectStep {
  /** `lpTransferFeeDrip(stream, now)`: LP burned from the fee account in this call (from EARLIER collections). */
  burnedNow: bigint;
  /** The stream after the settle, before the new collection joined it. */
  streamSettled: LpBurnStream;
  /** `feeAccountAmount − burnedNow − (owedProtocol + streamSettled.pending)`: this call's collection. */
  collected: bigint;
  /** `splitLpTransferFee(collected, shareBps)`. */
  split: LpFeeSplit;
  /** `lp_transfer_fees_owed_protocol` after the call. */
  owedProtocolAfter: bigint;
  /** The stream after `lpTransferFeeSchedule(streamSettled, split.burn, now)`. */
  streamAfter: LpBurnStream;
  /** LP fee account balance after the call (`== owedProtocolAfter + streamAfter.pending`). */
  feeAccountAmountAfter: bigint;
}

/**
 * Exact mirror of the handler's bookkeeping once the sweeps credited the fee
 * account (`model_collect` of the native tests): `burnedNow = drip(now)` is
 * burned from the account (`LpFeeAccountUnderfunded` when it holds less —
 * Token-2022 refuses the burn), the stream is settled, `collected` is what
 * sits above `owed + pending` (`LpFeeAccountUnderfunded` 6115 when
 * negative), split, the protocol part booked (`MathOverflow` past
 * `u64::MAX`) and the burn part scheduled at `now`.
 */
export function collectLpTransferFeeStep(params: {
  /** LP fee account balance AFTER the sweeps (`feeAccountAmount + withheld`). */
  feeAccountAmount: bigint;
  owedProtocol: bigint;
  stream: LpBurnStream;
  now: bigint | number;
  shareBps: number;
}): LpTransferFeeCollectStep {
  const account = assertU64(params.feeAccountAmount, "feeAccountAmount");
  const owed = assertU64(params.owedProtocol, "owedProtocol");
  const stream = normalizeStream(params.stream);
  const now = assertI64(params.now, "now");
  const burnedNow = lpTransferFeeDrip(stream.pending, stream.lastTs, stream.endTs, now);
  if (account < burnedNow) throw new MathError("LpFeeAccountUnderfunded");
  const afterBurn = account - burnedNow;
  const streamSettled = lpTransferFeeSettle(stream, burnedNow, now);
  const reserved = owed + streamSettled.pending;
  if (reserved > U64_MAX) throw new MathError("MathOverflow"); // `lp_fee_account_reserved` (6011)
  const collected = afterBurn - reserved;
  if (collected < 0n) throw new MathError("LpFeeAccountUnderfunded");
  const split = splitLpTransferFee(collected, params.shareBps);
  const owedProtocolAfter = owed + split.protocol;
  if (owedProtocolAfter > U64_MAX) throw new MathError("MathOverflow");
  const streamAfter = lpTransferFeeSchedule(streamSettled, split.burn, now);
  return { burnedNow, streamSettled, collected, split, owedProtocolAfter, streamAfter, feeAccountAmountAfter: afterBurn };
}

/** What the burn stream would release at `now` and the state it leaves behind. */
export interface LpTransferFeeBurnStreamQuote {
  /** `max(0, now − lastTs)`: seconds into the current segment (uncapped). */
  elapsedSecs: bigint;
  /** LP `collect_lp_transfer_fees` would burn at `now` (`lpTransferFeeDrip`). */
  burnNow: bigint;
  /** `lp_transfer_fees_pending_burn` after that collect (before any new collection joins it). */
  pendingBurnAfter: bigint;
  /** The stream after the settle (`lpTransferFeeSettle`): `lastTs` moves to `now` only when `burnNow > 0`; collapses to `now` when emptied. */
  streamAfter: LpBurnStream;
  /** LP mint supply after the burn; `undefined` when `lpSupply` was not given. */
  lpSupplyAfter?: bigint;
  /** Share of `pendingBurn` released, in bps of 10_000 (`floor`): 0 at zero elapsed, 10_000 from `endTs` on. */
  releasedBps: number;
  /** `endTs`: Unix seconds at which a collect releases the whole `pendingBurn`; `undefined` when nothing is pending. */
  fullyReleasedAt?: bigint;
}

/**
 * "Effective pending burn / LP supply at time `now`": what one
 * `collect_lp_transfer_fees` with no new fees at the chain time `now` would
 * burn out of the stream and the supply it leaves. `now` is the Clock sysvar
 * (never `Date.now()`); pass the snapshot's `lpTransferFeesPendingBurn` /
 * `lpTransferFeeBurnLastTs` / `lpTransferFeeBurnEndTs` / `lpTotalSupply`
 * (`lpBurnStreamOf(pool)` builds the triple).
 */
export function quoteLpTransferFeeBurnStream(params: {
  pendingBurn: bigint;
  burnLastTs: bigint | number;
  burnEndTs: bigint | number;
  now: bigint | number;
  lpSupply?: bigint;
}): LpTransferFeeBurnStreamQuote {
  const stream = normalizeStream({ pending: params.pendingBurn, lastTs: BigInt(params.burnLastTs), endTs: BigInt(params.burnEndTs) });
  const n = assertI64(params.now, "now");
  const burnNow = lpTransferFeeDrip(stream.pending, stream.lastTs, stream.endTs, n);
  const streamAfter = lpTransferFeeSettle(stream, burnNow, n);
  const rawElapsed = n - stream.lastTs;
  const elapsedSecs = rawElapsed < 0n ? 0n : rawElapsed;
  const releasedBps = stream.pending === 0n ? 0 : Number((burnNow * PRECISION) / stream.pending);
  const quote: LpTransferFeeBurnStreamQuote = { elapsedSecs, burnNow, pendingBurnAfter: streamAfter.pending, streamAfter, releasedBps };
  if (params.lpSupply !== undefined) {
    assertU64(params.lpSupply, "lpSupply");
    if (burnNow > params.lpSupply) throw new MathError("pendingBurn exceeds lpSupply");
    quote.lpSupplyAfter = params.lpSupply - burnNow;
  }
  if (stream.pending > 0n) quote.fullyReleasedAt = stream.endTs;
  return quote;
}

/** Result of `previewLpTransferFeeCollection` — the `LpTransferFeesCollected` event the call would emit, plus the stream it leaves. */
export interface LpTransferFeeCollectionPreview {
  /** LP units above `owedProtocol + pendingBurn` after the sweep and the drip burn (withheld fees + donations). */
  collected: bigint;
  /** `floor(collected · shareBps / 10_000)`, booked to the protocol. */
  protocolPart: bigint;
  /** `collected − protocolPart`, queued for the stream (burns nothing in this call). */
  scheduledBurn: bigint;
  /** `lpTransferFeeDrip(pendingBurn, burnLastTs, burnEndTs, now)` — from EARLIER collections. */
  burnedNow: bigint;
  protocolOwedAfter: bigint;
  /** `pendingBurn − burnedNow + scheduledBurn`. */
  pendingBurnAfter: bigint;
  /** `lpSupply − burnedNow`; `undefined` when `lpSupply` was not given. */
  lpSupplyAfter?: bigint;
  /** LP fee account balance after the call (`== protocolOwedAfter + pendingBurnAfter`). */
  feeAccountAmountAfter: bigint;
  /** `lp_transfer_fee_burn_last_ts` after the call (`now − δ` when a collection joined a live stream, `now` after a burn or on an empty stream, else unchanged). */
  burnLastTsAfter: bigint;
  /** `lp_transfer_fee_burn_end_ts` after the call (the event's `burn_end_ts`; `== burnLastTsAfter` when nothing is pending). */
  burnEndTsAfter: bigint;
}

/**
 * What one `collect_lp_transfer_fees` at the chain time `now` would do, in
 * the program's order: (1) sweep `withheld` into the fee account, (2) burn
 * `burnedNow = lpTransferFeeDrip(pendingBurn, burnLastTs, burnEndTs, now)`
 * from it and settle the stream (`lpTransferFeeSettle`), (3) `collected =
 * feeAccountAmount + withheld − burnedNow − (owedProtocol + pendingBurn −
 * burnedNow)` — everything above the two buckets (`LpFeeAccountUnderfunded`
 * 6115 when negative), (4) split: the protocol part is booked, the rest is
 * scheduled (`lpTransferFeeSchedule`: amount-weighted end, carried accrual)
 * and burns nothing in this call. `collectLpTransferFeeStep` does the
 * bookkeeping.
 */
export function previewLpTransferFeeCollection(params: {
  feeAccountAmount: bigint;
  owedProtocol: bigint;
  /** `lp_transfer_fees_pending_burn` (`0` on a pool that never collected). */
  pendingBurn: bigint;
  /** `lp_transfer_fee_burn_last_ts` (`0` before the first collect). */
  burnLastTs: bigint | number;
  /** `lp_transfer_fee_burn_end_ts` (`0` before the first collect / on a migrated pool). */
  burnEndTs: bigint | number;
  /** Chain clock of the collect (Clock sysvar seconds). */
  now: bigint | number;
  shareBps: number;
  /** `withheld_amount` of the sources to sweep (summed) plus the mint's `withheldAmount`. */
  withheld?: bigint;
  /** LP mint supply before the call; enables `lpSupplyAfter`. */
  lpSupply?: bigint;
}): LpTransferFeeCollectionPreview {
  const withheld = params.withheld ?? 0n;
  assertU64(params.feeAccountAmount, "feeAccountAmount");
  assertU64(withheld, "withheld");
  const swept = assertU64(params.feeAccountAmount + withheld, "feeAccountAmount + withheld");
  const step = collectLpTransferFeeStep({
    feeAccountAmount: swept,
    owedProtocol: params.owedProtocol,
    stream: { pending: params.pendingBurn, lastTs: BigInt(params.burnLastTs), endTs: BigInt(params.burnEndTs) },
    now: params.now,
    shareBps: params.shareBps,
  });
  const preview: LpTransferFeeCollectionPreview = {
    collected: step.collected, protocolPart: step.split.protocol, scheduledBurn: step.split.burn, burnedNow: step.burnedNow,
    protocolOwedAfter: step.owedProtocolAfter, pendingBurnAfter: step.streamAfter.pending,
    feeAccountAmountAfter: step.feeAccountAmountAfter, burnLastTsAfter: step.streamAfter.lastTs, burnEndTsAfter: step.streamAfter.endTs,
  };
  if (params.lpSupply !== undefined) {
    assertU64(params.lpSupply, "lpSupply");
    if (step.burnedNow > params.lpSupply) throw new MathError("pendingBurn exceeds lpSupply");
    preview.lpSupplyAfter = params.lpSupply - step.burnedNow;
  }
  return preview;
}
