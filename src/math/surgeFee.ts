/**
 * Port of v6 `math/surge_fee.rs` (contracts `v6`): the per-token variable
 * sell-off surge fee.
 *
 * Shape: three points, two straight segments over the window fill —
 * `0` through `threshold`, `low → mid` up to the `kink`, `mid → high` to
 * 100 %. `kink = 0` (or a kink outside `(threshold, 100 %)`) degenerates to
 * one line `low → high`. The rate a swap pays is the AVERAGE over the
 * fill interval it traverses (trapezoids, exact for a piecewise-linear
 * rate), and the swap handler charges each of four output segments at
 * that segment's own average rate, rounding the raw-token fee up once.
 *
 * All intermediates are 1e18-scaled bigints exactly like the Rust u128
 * code; `fill_ratio` rounds UP so fixed-point truncation can never place a
 * trade below its real rate.
 */
import { ONE, MathError, assertInteger, assertU64, ceilDiv } from "./fixedPoint";

/** `PERCENT_SCALE`: curve points and the threshold are basis points of window fill. */
const SCALE = 10_000n;

export interface SurgeCurve {
  /** Window fill (bps) through which the rate is zero. */
  thresholdPct: number;
  /** Rate (bps) immediately above the threshold. */
  slopeLowPct: number;
  /** Rate (bps) at the kink. */
  slopeMidPct: number;
  /** Rate (bps) at 100 % fill. */
  slopeHighPct: number;
  /** Kink position in WHOLE PERCENT of window fill (0..=100); 0 = no kink. */
  kinkPct: number;
}

function validateCurve(c: SurgeCurve): void {
  assertInteger(c.thresholdPct, 0, 65535, "surge threshold");
  assertInteger(c.slopeLowPct, 0, 65535, "surge low");
  assertInteger(c.slopeMidPct, 0, 65535, "surge mid");
  assertInteger(c.slopeHighPct, 0, 65535, "surge high");
  assertInteger(c.kinkPct, 0, 255, "surge kink");
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** Window fill at 1e18 precision, capped at one, rounded UP. `cap > 0`. */
function fillRatio(effectiveSelloff: bigint, cap: bigint): bigint {
  return ceilDiv(min(effectiveSelloff, cap) * ONE, cap);
}

/**
 * Average surge rate over the TAXED part of `[before, after]` as a fraction
 * scaled by `ONE` (port of `calc_surge_fee_rate`). `0` when the curve is
 * disabled (`cap == 0`, `slopeHighPct == 0`, threshold at or above 100 %) or
 * the interval ends at or below the threshold. An empty interval returns
 * the point rate at `after`.
 */
export function calcSurgeFeeRate(before: bigint, after: bigint, cap: bigint, curve: SurgeCurve): bigint {
  validateCurve(curve);
  assertU64(before);
  assertU64(after);
  assertU64(cap);
  if (cap === 0n || curve.slopeHighPct === 0 || BigInt(curve.thresholdPct) >= SCALE) return 0n;
  const threshold = (BigInt(curve.thresholdPct) * ONE) / SCALE;
  const lo = max(fillRatio(before, cap), threshold);
  const hi = fillRatio(after, cap);
  if (hi <= threshold) return 0n;
  const kink = (BigInt(curve.kinkPct) * ONE) / 100n;
  const hasKink = kink > threshold && kink < ONE;
  // Invalid historical curves flatten rather than underflow: clamp each
  // point to 100 % and keep them ordered.
  const lowBps = min(BigInt(curve.slopeLowPct), SCALE);
  const midBps = max(min(BigInt(curve.slopeMidPct), SCALE), lowBps);
  const highBps = max(min(BigInt(curve.slopeHighPct), SCALE), hasKink ? midBps : lowBps);
  const low = (lowBps * ONE) / SCALE;
  const mid = (midBps * ONE) / SCALE;
  const high = (highBps * ONE) / SCALE;
  const rate = (position: bigint): bigint => {
    const [start, end, base, peak] = !hasKink
      ? [threshold, ONE, low, high]
      : position <= kink
        ? [threshold, kink, low, mid]
        : [kink, ONE, mid, high];
    return base + ceilDiv((peak - base) * (position - start), end - start);
  };
  if (hi <= lo) return rate(hi);
  const twiceArea =
    hasKink && lo < kink && hi > kink
      ? (rate(lo) + mid) * (kink - lo) + (mid + rate(hi)) * (hi - kink)
      : (rate(lo) + rate(hi)) * (hi - lo);
  return min(ceilDiv(twiceArea, 2n * (hi - lo)), ONE);
}

/** Whole-basis-point accessor for display (`calc_surge_fee_pct`); settlement uses the rate directly. */
export function calcSurgeFeePct(before: bigint, after: bigint, cap: bigint, curve: SurgeCurve): number {
  return Number(ceilDiv(calcSurgeFeeRate(before, after, cap, curve) * SCALE, ONE));
}

export interface SurgeFeeAmountParams {
  /** Window fill before the trade (`effective_selloff_before`). */
  before: bigint;
  /** Window fill after the trade (`effective_selloff`). */
  after: bigint;
  /** Resolved window cap (`max_selloff_cap`). */
  cap: bigint;
  curve: SurgeCurve;
  /** Full curve output of the trade (gross, pre-surge). */
  amountOut: bigint;
  /**
   * Curve output accumulated from this swap's start to window position `u`
   * (`before < u < after`): the handler feeds `amount_in_after_fee ·
   * (u − before) / (after − before)` into `calc_out_given_in` against the
   * pre-trade balances. Invoked at most `SURGE_FEE_SEGMENTS` times.
   */
  cumulativeOut: (u: bigint) => bigint;
}

/** `SURGE_FEE_SEGMENTS` from `constants.rs`. */
export const SURGE_FEE_SEGMENTS = 4n;

/**
 * Surge fee in OUTPUT-token units for one swap (port of
 * `calc_surge_fee_amount`): only the output produced above the threshold is
 * taxed, each of four segments at its own average rate, summed at 1e18
 * precision and rounded up once, clamped to `amountOut`.
 */
export function calcSurgeFeeAmount(p: SurgeFeeAmountParams): bigint {
  const { before, after, cap, curve, amountOut } = p;
  assertU64(amountOut);
  if (calcSurgeFeeRate(before, after, cap, curve) === 0n) return 0n;
  // Floor the threshold in raw window units: a sub-unit remainder is taxed.
  const thresholdUnits = (cap * BigInt(curve.thresholdPct)) / SCALE;
  const taxedLo = max(before, thresholdUnits);
  if (after <= taxedLo) return 0n;
  const width = after - taxedLo;
  let previousU = taxedLo;
  let previousY = taxedLo <= before ? 0n : p.cumulativeOut(taxedLo);
  let feeNumerator = 0n;
  for (let k = 1n; k <= SURGE_FEE_SEGMENTS; k++) {
    const u = taxedLo + (width * k) / SURGE_FEE_SEGMENTS;
    // Repeated raw boundaries carry no output and no fee.
    if (u === previousU) continue;
    const y = k === SURGE_FEE_SEGMENTS ? amountOut : p.cumulativeOut(u);
    if (y < previousY) throw new MathError("MathUnderflow");
    const segmentOut = y - previousY;
    if (segmentOut > 0n) {
      feeNumerator += segmentOut * calcSurgeFeeRate(previousU, u, cap, curve);
    }
    previousU = u;
    previousY = y;
  }
  return min(ceilDiv(feeNumerator, ONE), amountOut);
}
