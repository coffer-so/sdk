/**
 * v6 surge curve: `calc_surge_fee_rate` (1e18 trapezoid average, fill ratio
 * rounded UP) and the swap handler's `calc_surge_fee_amount` (four output
 * segments, one final ceil). Vectors mirror `surge_fee.rs` unit tests;
 * exact numbers are hand-derived from the contract formulas.
 */
import { calcSurgeFeeAmount, calcSurgeFeePct, calcSurgeFeeRate, SurgeCurve, SURGE_FEE_SEGMENTS } from "../../src/math/surgeFee";
import { ONE } from "../../src/math/fixedPoint";

const SCALE = 10_000;
const curve = (thresholdPct: number, slopeLowPct: number, slopeMidPct: number, slopeHighPct: number, kinkPct: number): SurgeCurve => ({ thresholdPct, slopeLowPct, slopeMidPct, slopeHighPct, kinkPct });
/** Point rate at `fill` in bps: an empty interval returns the rate at its endpoint. */
const rateAt = (fill: bigint, cap: bigint, c: SurgeCurve) => calcSurgeFeePct(fill, fill, cap, c);

describe("calcSurgeFeePct (surge_fee.rs unit vectors)", () => {
  test("disabled_when_cap_zero", () => {
    expect(calcSurgeFeePct(0n, 100n, 0n, curve(8_000, 200, 200, 3_000, 0))).toBe(0);
  });

  test("disabled_when_slope_high_zero", () => {
    expect(calcSurgeFeePct(0n, 100n, 100n, curve(8_000, 0, 0, 0, 0))).toBe(0);
  });

  test("disabled when the threshold is at or above 100 %", () => {
    expect(calcSurgeFeeRate(0n, 100n, 100n, curve(10_000, 0, 0, 3_000, 0))).toBe(0n);
  });

  test("zero_below_threshold", () => {
    expect(calcSurgeFeePct(0n, 50n, 100n, curve(8_000, 200, 200, 3_000, 0))).toBe(0);
  });

  test("full_sweep_is_the_curve_average_not_the_endpoint", () => {
    // thr 80 %, 0 → 3000 over the taxed band: trapezoid average = 1500.
    const avg = calcSurgeFeePct(0n, 10_000n, 10_000n, curve(8_000, 0, 0, 3_000, 0));
    expect(avg).toBe(1_500);
  });

  test("degenerate_interval_uses_point_rate", () => {
    expect(calcSurgeFeePct(1_000n, 1_000n, 1_000n, curve(8_000, 0, 0, 3_000, 0))).toBe(3_000);
  });

  test("pos_curve_hits_its_three_points", () => {
    const c = curve(2_000, 100, 500, 5_000, 60);
    expect(rateAt(2_001n, 10_000n, c)).toBe(101);
    expect(rateAt(6_000n, 10_000n, c)).toBe(500);
    expect(rateAt(10_000n, 10_000n, c)).toBe(5_000);
  });

  test("pos_threshold_is_a_step", () => {
    const c = curve(3_000, 250, 800, 4_000, 70);
    expect(rateAt(3_000n, 10_000n, c)).toBe(0);
    expect(rateAt(3_001n, 10_000n, c)).toBe(251);
  });

  test("pos_each_segment_is_linear", () => {
    const c = curve(0, 0, 400, 2_000, 50);
    expect(rateAt(2_500n, 10_000n, c)).toBe(200);
    expect(rateAt(7_500n, 10_000n, c)).toBe(1_200);
  });

  test("kink at/outside the (threshold, 100 %) band degenerates to low → high", () => {
    expect(rateAt(10_000n, 10_000n, curve(2_000, 100, 700, 3_000, 10))).toBe(3_000);
    expect(rateAt(10_000n, 10_000n, curve(2_000, 100, 700, 3_000, 100))).toBe(3_000);
  });

  test("invalid historical curves flatten: points clamp to 100 % and stay ordered", () => {
    expect(rateAt(10_000n, 10_000n, curve(0, 20_000, 30_000, 65_535, 70))).toBe(SCALE);
    // mid below low is lifted to low; high below mid is lifted to mid.
    expect(rateAt(5_000n, 10_000n, curve(0, 700, 100, 50, 50))).toBe(700);
  });

  test("monotonic_in_end_fill", () => {
    let last = 0;
    for (const fill of [8_001n, 8_500n, 9_000n, 9_500n, 9_900n, 10_000n]) {
      const f = calcSurgeFeePct(8_000n, fill, 10_000n, curve(8_000, 200, 200, 3_000, 0));
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
  });

  test("fill ratio rounds UP so fixed-point truncation never under-rates a trade", () => {
    // cap 3, identity curve 0 → 100 %: the point rate at one raw unit is
    // ceil(ONE / 3), not floor.
    expect(calcSurgeFeeRate(1n, 1n, 3n, curve(0, 0, 0, SCALE, 0))).toBe(333_333_333_333_333_334n);
  });
});

describe("calcSurgeFeeRate is a 1e18 fraction", () => {
  test("whole-bps accessor is the ceiling of the fraction", () => {
    const c = curve(2_000, 100, 500, 5_000, 60);
    const rate = calcSurgeFeeRate(2_001n, 2_001n, 10_000n, c);
    expect(rate).toBe(10_010_000_000_000_000n); // 0.01001 · ONE
    expect(calcSurgeFeePct(2_001n, 2_001n, 10_000n, c)).toBe(101);
    expect(rate).toBeLessThanOrEqual(ONE);
  });
});

describe("calcSurgeFeeAmount (swap handler charge)", () => {
  // Identity curve: output == input slice. Makes expected values exact and
  // isolates the segmentation logic from AMM concavity.
  const identity = (u: bigint) => u;
  const flat = curve(8_000, 0, 0, 3_000, 0);

  test("zero when the whole trade stays below the threshold", () => {
    expect(calcSurgeFeeAmount({ before: 0n, after: 700n, cap: 1_000n, curve: flat, amountOut: 700n, cumulativeOut: identity })).toBe(0n);
  });

  test("taxes only the above-threshold output, four segments, ONE final ceil", () => {
    // Taxed span [800, 1000] in 4 segments of 50; identity output = 50 each.
    // Segment-average rates of 3000·t over quarters of t∈[0,1] are
    // 375, 1125, 1875, 2625 bps ⇒ 1.875 + 5.625 + 9.375 + 13.125 = 30.
    const calls: bigint[] = [];
    const fee = calcSurgeFeeAmount({ before: 0n, after: 1_000n, cap: 1_000n, curve: flat, amountOut: 1_000n, cumulativeOut: (u) => { calls.push(u); return u; } });
    expect(fee).toBe(30n); // v5 charged 32 (a ceil per segment)
    // threshold inside the swap: the untaxed output below it is measured once,
    // then three interior boundaries; the last boundary reuses amountOut.
    expect(calls).toEqual([800n, 850n, 900n, 950n]);
  });

  test("a trade that starts above the threshold does not measure the threshold", () => {
    const calls: bigint[] = [];
    calcSurgeFeeAmount({ before: 900n, after: 1_000n, cap: 1_000n, curve: flat, amountOut: 100n, cumulativeOut: (u) => { calls.push(u); return u - 900n; } });
    expect(calls).toEqual([925n, 950n, 975n]);
  });

  test("a span narrower than four units skips repeated boundaries", () => {
    const calls: bigint[] = [];
    const fee = calcSurgeFeeAmount({ before: 998n, after: 1_000n, cap: 1_000n, curve: curve(0, 10_000, 10_000, 10_000, 0), amountOut: 2n, cumulativeOut: (u) => { calls.push(u); return u - 998n; } });
    expect(calls).toEqual([999n]);
    expect(fee).toBe(2n);
  });

  test("threshold floors in raw units: a sub-unit remainder is taxed", () => {
    // cap 1001, thr 80 % → threshold_units = floor(800.8) = 800.
    const calls: bigint[] = [];
    calcSurgeFeeAmount({ before: 0n, after: 1_001n, cap: 1_001n, curve: flat, amountOut: 1_001n, cumulativeOut: (u) => { calls.push(u); return u; } });
    expect(calls[0]).toBe(800n);
  });

  test("fee is clamped to amountOut", () => {
    const fee = calcSurgeFeeAmount({ before: 800n, after: 1_000n, cap: 1_000n, curve: curve(8_000, SCALE, SCALE, SCALE, 0), amountOut: 200n, cumulativeOut: (u) => u - 800n });
    expect(fee).toBe(200n);
  });

  test("zero rate short-circuits without touching the curve", () => {
    const spy = jest.fn(identity);
    expect(calcSurgeFeeAmount({ before: 0n, after: 100n, cap: 0n, curve: flat, amountOut: 100n, cumulativeOut: spy })).toBe(0n);
    expect(spy).not.toHaveBeenCalled();
  });

  test("splitting a sell does not materially change the fee (audit M-05)", () => {
    const whole = calcSurgeFeeAmount({ before: 0n, after: 1_000n, cap: 1_000n, curve: flat, amountOut: 1_000n, cumulativeOut: identity });
    const parts =
      calcSurgeFeeAmount({ before: 0n, after: 800n, cap: 1_000n, curve: flat, amountOut: 800n, cumulativeOut: identity }) +
      calcSurgeFeeAmount({ before: 800n, after: 900n, cap: 1_000n, curve: flat, amountOut: 100n, cumulativeOut: (u) => u - 800n }) +
      calcSurgeFeeAmount({ before: 900n, after: 1_000n, cap: 1_000n, curve: flat, amountOut: 100n, cumulativeOut: (u) => u - 900n });
    expect(parts).toBeGreaterThan(0n);
    expect(Number(whole > parts ? whole - parts : parts - whole)).toBeLessThanOrEqual(Number(whole) * 0.1 + Number(SURGE_FEE_SEGMENTS));
  });
});
