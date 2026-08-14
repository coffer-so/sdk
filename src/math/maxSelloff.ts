/**
 * Sliding-window cumulative-sell rate limiter + variable sell-off surge fee.
 *
 * Port of the v5.1 (post-audit) contracts:
 *   `programs/cubic-pool/src/math/max_selloff.rs` (`check_and_advance`)
 *   `programs/cubic-pool/src/math/surge_fee.rs`  (`calc_surge_fee_pct`)
 *   `programs/cubic-pool/src/instructions/user/swap.rs` (segmented charge)
 *
 * All arithmetic is bigint, mirroring the Rust u128 intermediates INCLUDING
 * integer-division order — do not "simplify" a `a*b/c` into a different
 * association, parity with the on-chain result depends on it. BN appears
 * only at the SDK boundary.
 *
 * v5.1 curve model: the fee RATE is piecewise-LINEAR in the normalized
 * window-fill coordinate `t ∈ [0, 1]` (threshold → 100% fill):
 *   - no kink: low → high over [0, 1]
 *   - kinked:  low → mid over [0, k], mid → high over [k, 1]
 * and a swap is charged the AVERAGE rate over the span it crosses
 * (integral / width), which makes the fee path-independent — splitting a
 * sell into parts cannot cheapen it (audit M-05). The old exponential
 * convexity curve (A^t) is gone.
 */

import BN from "bn.js";
import { PERCENT_SCALE } from "../config";
import { ONE } from "./fixedPoint";

const SCALE = BigInt(PERCENT_SCALE); // 10_000

/** Mirrors cubic-pool::constants::SURGE_FEE_SEGMENTS. */
export const SURGE_FEE_SEGMENTS = 4;

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
  /** Carried-over previous usage, POST v5.1 snapshot rescale. */
  previous: bigint;
  current: bigint;
  vbSnapshot: bigint;
  cap: bigint;
  weightedPrev: bigint;
  /** weightedPrev + current (decayed effective, WITHOUT a hypothetical trade). */
  usedWithoutTrade: bigint;
}

/**
 * Pure bigint projection of the sliding window at `now`. Mirrors v5.1
 * `check_and_advance`'s rotation + snapshot logic (read-only, no
 * `amount_in`), including the audit addition: when the projection OPENS a
 * window against a new vb snapshot, the carried-over `previous` usage is
 * rescaled by `newSnapshot / oldSnapshot` so a liquidity change between
 * windows doesn't distort the carried percentage.
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
    // Degenerate config (rejected on-chain by `require!(period > 0)`);
    // treat as a fresh reset so callers never divide by zero.
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

  const oldSnapshot = params.selloffVbSnapshot;
  const vbSnapshot =
    opened || oldSnapshot === 0n ? params.virtualBalance : oldSnapshot;

  // v5.1: rescale the carried previous when the window opened against a
  // DIFFERENT snapshot (mirrors max_selloff.rs — integer division order!).
  if (opened && oldSnapshot > 0n && vbSnapshot !== oldSnapshot) {
    prev = (prev * vbSnapshot) / oldSnapshot;
  }

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

// ── v5.1 piecewise-linear surge curve ───────────────────────────────────────

/**
 * Kink position in normalized-t space. `kinkPct` is WHOLE percent of window
 * fill (0..=100, u8 on-chain); 0 (or a kink at/outside the [threshold, 100%]
 * band) disables the kink and the curve degenerates to low → high.
 * Port of `surge_fee.rs::kink_t`.
 */
function kinkT(kinkPct: number, thresholdPct: number): bigint {
  const thr = BigInt(thresholdPct);
  if (kinkPct === 0 || thr >= SCALE) return 0n;
  const kinkFill = BigInt(kinkPct) * (SCALE / 100n);
  if (kinkFill <= thr || kinkFill >= SCALE) return 0n;
  return ((kinkFill - thr) * ONE) / (SCALE - thr);
}

/** Point rate at `t` (CEIL on the ramp, clamped to SCALE). Port of `rate_at`. */
function rateAt(
  tFp: bigint,
  slopeLowPct: number,
  slopeMidPct: number,
  slopeHighPct: number,
  kFp: bigint,
): bigint {
  const t = tFp < ONE ? tFp : ONE;
  const low = BigInt(slopeLowPct);
  const mid = BigInt(slopeMidPct);
  const high = BigInt(slopeHighPct);

  let base: bigint;
  let span: bigint;
  let num: bigint;
  let den: bigint;
  if (kFp === 0n) {
    base = low;
    span = high > low ? high - low : 0n;
    num = t;
    den = ONE;
  } else if (t <= kFp) {
    base = low;
    span = mid > low ? mid - low : 0n;
    num = t;
    den = kFp;
  } else {
    base = mid;
    span = high > mid ? high - mid : 0n;
    num = t - kFp;
    den = ONE - kFp;
  }

  const prod = span * num;
  const add = prod / den + (prod % den !== 0n ? 1n : 0n);
  const rate = base + add;
  return rate < SCALE ? rate : SCALE;
}

/**
 * ∫ rate over [0, t] (1e18-scaled area). Port of `integral_to` — keep the
 * `x*x/(2*den)` before the span multiply, exactly like the contract.
 */
function integralTo(
  tFp: bigint,
  slopeLowPct: number,
  slopeMidPct: number,
  slopeHighPct: number,
  kFp: bigint,
): bigint {
  const t = tFp < ONE ? tFp : ONE;
  const low = BigInt(slopeLowPct);
  const mid = BigInt(slopeMidPct);
  const high = BigInt(slopeHighPct);

  const ramp = (x: bigint, span: bigint, den: bigint): bigint => {
    if (den === 0n || span === 0n || x === 0n) return 0n;
    const halfSq = (x * x) / (2n * den);
    return span * halfSq;
  };

  if (kFp === 0n) {
    const span = high > low ? high - low : 0n;
    return low * t + ramp(t, span, ONE);
  }

  if (t <= kFp) {
    const span = mid > low ? mid - low : 0n;
    return low * t + ramp(t, span, kFp);
  }

  const first = (kFp * (low + mid)) / 2n;
  const rest = t - kFp;
  const span = high > mid ? high - mid : 0n;
  return first + mid * rest + ramp(rest, span, ONE - kFp);
}

/**
 * Average surge-fee percentage (PERCENT_SCALE units, 0..=10_000) charged for
 * moving the window fill from `effectiveSelloffBefore` to
 * `effectiveSelloffAfter` against `cap`. Port of v5.1 `calc_surge_fee_pct`:
 * the rate is INTEGRATED over the crossed span (CEIL), so the charge is
 * path-independent. When the span is empty (`after <= before`) the point
 * rate at `after` is returned.
 */
export function calcSurgeFeePct(
  effectiveSelloffBefore: bigint,
  effectiveSelloffAfter: bigint,
  cap: bigint,
  thresholdPct: number,
  slopeLowPct: number,
  slopeMidPct: number,
  slopeHighPct: number,
  kinkPct: number,
): number {
  if (cap === 0n || slopeHighPct === 0) return 0;
  const thr = BigInt(thresholdPct);
  if (thr >= SCALE) return 0;

  const kFp = kinkT(kinkPct, thresholdPct);

  const fill = (x: bigint): bigint => {
    const raw = (x * SCALE) / cap;
    return raw < SCALE ? raw : SCALE;
  };
  const f0 = fill(effectiveSelloffBefore);
  const f1 = fill(effectiveSelloffAfter);

  if (f1 <= thr) return 0;

  const denom = SCALE - thr;
  const t1 = ((f1 - thr) * ONE) / denom;

  if (f1 <= f0) {
    return Number(rateAt(t1, slopeLowPct, slopeMidPct, slopeHighPct, kFp));
  }

  const f0Clamped = f0 > thr ? f0 : thr;
  const t0 = ((f0Clamped - thr) * ONE) / denom;

  const integral =
    integralTo(t1, slopeLowPct, slopeMidPct, slopeHighPct, kFp) -
    integralTo(t0, slopeLowPct, slopeMidPct, slopeHighPct, kFp);
  const integralClamped = integral > 0n ? integral : 0n;

  const numerator = denom * integralClamped;
  const width = f1 - f0Clamped;
  const scaledDen = width * ONE;
  const avg = numerator / scaledDen + (numerator % scaledDen !== 0n ? 1n : 0n);

  return Number(avg < SCALE ? avg : SCALE);
}

/**
 * CEIL fee application of a known percentage on `amount`, clamped to
 * `amount`. NOTE: the contract does NOT charge the whole output at one
 * rate — use {@link calcSegmentedSurgeFeeAmount} to mirror an actual swap.
 * This helper remains for coarse display math only.
 */
export function calcSurgeFeeAmount(amountOut: bigint, surgePct: number): bigint {
  if (surgePct <= 0 || amountOut <= 0n) return 0n;
  const num = amountOut * BigInt(surgePct);
  const fee = num / SCALE + (num % SCALE !== 0n ? 1n : 0n);
  return fee < amountOut ? fee : amountOut;
}

export interface SegmentedSurgeFeeParams {
  /** Window fill before the trade (`usedWithoutTrade`). */
  effectiveSelloffBefore: bigint;
  /** Window fill after the trade (`before + amountInNet`). */
  effectiveSelloffAfter: bigint;
  cap: bigint;
  thresholdPct: number;
  slopeLowPct: number;
  slopeMidPct: number;
  slopeHighPct: number;
  kinkPct: number;
  /** Post-swap-fee input driving the AMM curve (`amount_in_after_fee`). */
  amountInAfterFee: bigint;
  /** Full curve output of the trade (gross, pre-surge). */
  amountOut: bigint;
  /**
   * Cumulative AMM output for an input slice `x ∈ [0, amountInAfterFee]`
   * against the PRE-TRADE balances (i.e. `calc_out_given_in` with the same
   * arguments that produced `amountOut`).
   */
  curveOut: (amountInSlice: bigint) => bigint;
  /** Defaults to the contract's SURGE_FEE_SEGMENTS (= 4). */
  segments?: number;
}

/**
 * Surge fee in OUTPUT-token units for one swap — the exact v5.1 on-chain
 * charge (swap.rs): only the output produced ABOVE the threshold is taxed,
 * segment by segment across the taxed span, each segment's REAL curve
 * output at that segment's average rate (CEIL per segment), total clamped
 * to `amountOut`. Charging one average rate on the whole output would
 * re-open the audit M-05 split dodge on asymmetric pools.
 */
export function calcSegmentedSurgeFeeAmount(p: SegmentedSurgeFeeParams): bigint {
  const {
    effectiveSelloffBefore: before,
    effectiveSelloffAfter: after,
    cap,
    thresholdPct,
    slopeLowPct,
    slopeMidPct,
    slopeHighPct,
    kinkPct,
    amountInAfterFee,
    amountOut,
  } = p;

  // Same precheck as swap.rs: whole-span average of 0 ⇒ nothing to charge.
  const wholeSpanPct = calcSurgeFeePct(
    before,
    after,
    cap,
    thresholdPct,
    slopeLowPct,
    slopeMidPct,
    slopeHighPct,
    kinkPct,
  );
  if (wholeSpanPct === 0) return 0n;

  const thrUnits = (cap * BigInt(thresholdPct)) / SCALE;
  const span = after > before ? after - before : 0n;
  const taxedLo = before > thrUnits ? before : thrUnits;
  if (span === 0n || after <= taxedLo) return 0n;

  const segments = BigInt(p.segments ?? SURGE_FEE_SEGMENTS);

  // Flooring the input slice understates the output, which overstates the
  // taxed remainder — the safe (conservative) direction, as on-chain.
  const cumulativeOut = (u: bigint): bigint => {
    if (u <= before) return 0n;
    if (u >= after) return amountOut;
    const x = (amountInAfterFee * (u - before)) / span;
    return p.curveOut(x);
  };

  const taxedWidth = after - taxedLo;
  let feeAcc = 0n;
  let prevU = taxedLo;
  let prevY = cumulativeOut(taxedLo);
  for (let k = 1n; k <= segments; k++) {
    const u = k === segments ? after : taxedLo + (taxedWidth * k) / segments;
    const y = cumulativeOut(u);
    const segOut = y > prevY ? y - prevY : 0n;
    if (segOut > 0n && u > prevU) {
      const segPct = BigInt(
        calcSurgeFeePct(
          prevU,
          u,
          cap,
          thresholdPct,
          slopeLowPct,
          slopeMidPct,
          slopeHighPct,
          kinkPct,
        ),
      );
      const num = segOut * segPct;
      feeAcc += num / SCALE + (num % SCALE !== 0n ? 1n : 0n);
    }
    prevU = u;
    prevY = y;
  }

  return feeAcc < amountOut ? feeAcc : amountOut;
}
