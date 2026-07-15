/**
 * Sliding-window cumulative-sell rate limiter + variable sell-off surge fee.
 *
 * Port of `contracts/programs/cubic-pool/src/math/max_selloff.rs` and
 * `.../surge_fee.rs`. All arithmetic is bigint (matching the Rust u128
 * intermediates); BN is used only at the SDK boundary.
 *
 * The cap for a window is a percentage of the token's `virtual_balance`
 * captured in a per-window snapshot (NOT the live value), which prevents an
 * in-window base-inflation bypass. See the Rust module for the full rationale.
 */

import BN from "bn.js";
import { PERCENT_SCALE } from "../config";
import { ONE } from "./fixedPoint";
import { powFp } from "./logExp";

/** A = SURGE_FEE_CONVEXITY_FP (= 4) in 1e18 fixed point. */
export const SURGE_FEE_CONVEXITY = 4n * ONE;

const SCALE = BigInt(PERCENT_SCALE); // 10_000

export interface SelloffWindowInputs {
  maxSelloffPct: number;
  periodLength: number;
  previousSelloff: BN;
  currentSelloff: BN;
  windowStartTimestamp: BN;
  selloffVbSnapshot: BN;
  /** Current pre-trade virtual balance of the token. */
  virtualBalance: BN;
  /** Unix seconds. */
  now: number;
}

export interface SelloffWindowStatus {
  /** True when the limiter is configured (`maxSelloffPct > 0`). */
  enabled: boolean;
  cap: BN;
  /** Effective decayed usage WITHOUT a hypothetical trade. */
  used: BN;
  /** `max(0, cap - used)`. */
  remaining: BN;
  /** `used/cap` in PERCENT_SCALE units (0..10_000+); 0 when disabled/cap=0. */
  fillPct: number;
  windowStartTimestamp: BN;
  periodLength: number;
  /** Whether the projection at `now` rotated the window vs stored state. */
  rotated: boolean;
  /** Snapshot the cap was resolved against (post-projection). */
  vbSnapshot: BN;
}

/** Result of the pure bigint window projection. */
export interface WindowProjection {
  opened: boolean;
  windowStart: bigint;
  elapsedInWindow: bigint;
  previous: bigint;
  current: bigint;
  vbSnapshot: bigint;
  cap: bigint;
  weightedPrev: bigint;
  /** weightedPrev + current (decayed effective, WITHOUT a hypothetical trade). */
  usedWithoutTrade: bigint;
}

/**
 * Pure bigint projection of the sliding window at `now`. Mirrors
 * `check_and_advance`'s rotation + snapshot logic (read-only, no `amount_in`).
 */
export function projectSelloffWindow(params: {
  maxSelloffPct: number;
  periodLength: number;
  previousSelloff: bigint;
  currentSelloff: bigint;
  windowStartTimestamp: bigint;
  selloffVbSnapshot: bigint;
  virtualBalance: bigint;
  now: number;
}): WindowProjection {
  const period = BigInt(params.periodLength);
  const storedWs = params.windowStartTimestamp;
  const nowBI = BigInt(Math.trunc(params.now));

  const rawElapsed = nowBI - storedWs;
  const elapsed = rawElapsed < 0n ? 0n : rawElapsed;

  let prev: bigint;
  let cur: bigint;
  let ws: bigint;
  let eiw: bigint;
  let opened: boolean;

  if (period > 0n && elapsed >= 2n * period) {
    prev = 0n;
    cur = 0n;
    ws = nowBI;
    eiw = 0n;
    opened = true;
  } else if (period > 0n && elapsed >= period) {
    ws = storedWs + period;
    const e = nowBI - ws;
    eiw = e < 0n ? 0n : e;
    prev = params.currentSelloff;
    cur = 0n;
    opened = true;
  } else if (period <= 0n) {
    // Degenerate config (should be rejected on-chain); treat as a fresh reset.
    prev = 0n;
    cur = 0n;
    ws = nowBI;
    eiw = 0n;
    opened = true;
  } else {
    prev = params.previousSelloff;
    cur = params.currentSelloff;
    ws = storedWs;
    eiw = elapsed;
    opened = false;
  }

  const vbSnapshot =
    opened || params.selloffVbSnapshot === 0n
      ? params.virtualBalance
      : params.selloffVbSnapshot;

  const cap = (BigInt(params.maxSelloffPct) * vbSnapshot) / SCALE;
  const weightedPrev = period > 0n ? (prev * (period - eiw)) / period : 0n;
  const usedWithoutTrade = weightedPrev + cur;

  return {
    opened,
    windowStart: ws,
    elapsedInWindow: eiw,
    previous: prev,
    current: cur,
    vbSnapshot,
    cap,
    weightedPrev,
    usedWithoutTrade,
  };
}

/** Read-only status of a token's max-selloff window at `now`. */
export function computeSelloffWindow(inputs: SelloffWindowInputs): SelloffWindowStatus {
  const enabled = inputs.maxSelloffPct > 0;
  if (!enabled) {
    return {
      enabled: false,
      cap: new BN(0),
      used: new BN(0),
      remaining: new BN(0),
      fillPct: 0,
      windowStartTimestamp: inputs.windowStartTimestamp,
      periodLength: inputs.periodLength,
      rotated: false,
      vbSnapshot: new BN(0),
    };
  }

  const proj = projectSelloffWindow({
    maxSelloffPct: inputs.maxSelloffPct,
    periodLength: inputs.periodLength,
    previousSelloff: BigInt(inputs.previousSelloff.toString()),
    currentSelloff: BigInt(inputs.currentSelloff.toString()),
    windowStartTimestamp: BigInt(inputs.windowStartTimestamp.toString()),
    selloffVbSnapshot: BigInt(inputs.selloffVbSnapshot.toString()),
    virtualBalance: BigInt(inputs.virtualBalance.toString()),
    now: inputs.now,
  });

  const used = proj.usedWithoutTrade;
  const remaining = proj.cap > used ? proj.cap - used : 0n;
  const fillPct = proj.cap === 0n ? 0 : Number((used * SCALE) / proj.cap);

  return {
    enabled: true,
    cap: new BN(proj.cap.toString()),
    used: new BN(used.toString()),
    remaining: new BN(remaining.toString()),
    fillPct,
    windowStartTimestamp: new BN(proj.windowStart.toString()),
    periodLength: inputs.periodLength,
    rotated: proj.opened,
    vbSnapshot: new BN(proj.vbSnapshot.toString()),
  };
}

/**
 * Surge-fee percentage (PERCENT_SCALE units, 0..=10_000) for a swap that
 * pushed the input token's window to `effectiveSelloff` against `cap`.
 * Port of `calc_surge_fee_pct`. Returns 0 when disabled or below threshold.
 */
export function calcSurgeFeePct(
  effectiveSelloff: bigint,
  cap: bigint,
  thresholdPct: number,
  slopeLowPct: number,
  slopeHighPct: number,
): number {
  if (cap === 0n || slopeHighPct === 0) return 0;
  const thr = BigInt(thresholdPct);
  if (thr >= SCALE) return 0;

  const fillRaw = (effectiveSelloff * SCALE) / cap;
  const fill = fillRaw < SCALE ? fillRaw : SCALE;
  if (fill <= thr) return 0;

  const t = ((fill - thr) * ONE) / (SCALE - thr);
  const aPowT = powFp(SURGE_FEE_CONVEXITY, t);
  const factorRaw = ((aPowT - ONE) * ONE) / (SURGE_FEE_CONVEXITY - ONE);
  const factor = factorRaw < ONE ? factorRaw : ONE;

  const span = slopeHighPct > slopeLowPct ? BigInt(slopeHighPct - slopeLowPct) : 0n;
  const prod = span * factor;
  const add = prod / ONE + (prod % ONE !== 0n ? 1n : 0n);
  const surge = BigInt(slopeLowPct) + add;
  return Number(surge < SCALE ? surge : SCALE);
}

/**
 * CEIL surge fee on `amountOut`, clamped to `amountOut`.
 * `num = amountOut * surgePct; fee = ceil(num / PERCENT_SCALE)`.
 */
export function calcSurgeFeeAmount(amountOut: bigint, surgePct: number): bigint {
  if (surgePct <= 0 || amountOut <= 0n) return 0n;
  const num = amountOut * BigInt(surgePct);
  const fee = num / SCALE + (num % SCALE !== 0n ? 1n : 0n);
  return fee < amountOut ? fee : amountOut;
}
