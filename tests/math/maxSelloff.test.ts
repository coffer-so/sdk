/**
 * v5.1 max-selloff window + piecewise-linear surge curve.
 *
 * Curve vectors mirror `programs/cubic-pool/src/math/surge_fee.rs` unit
 * tests; window vectors mirror `max_selloff.rs::check_and_advance`
 * (including the v5.1 previous-rescale on window open). Exact expected
 * numbers are hand-derived from the contract formulas — if a port drifts
 * from the integer math (division order, CEILs), these fail.
 */
import BN from "bn.js";
import {
  calcSegmentedSurgeFeeAmount,
  calcSurgeFeeAmount,
  calcSurgeFeePct,
  computeSelloffWindow,
  projectSelloffWindow,
} from "../../src/math/maxSelloff";

const SCALE = 10_000;

describe("projectSelloffWindow (v5.1 check_and_advance mirror)", () => {
  const base = {
    maxSelloffPct: 1_000, // 10%
    periodLength: 100,
    previousSelloff: 0n,
    currentSelloff: 0n,
    windowStartTimestamp: 1_000n,
    selloffVbSnapshot: 0n,
    virtualBalance: 1_000_000n,
  };

  test("inside the window: state carried, snapshot resolved from vb when unset", () => {
    const p = projectSelloffWindow({ ...base, currentSelloff: 5_000n, now: 1_050 });
    expect(p.opened).toBe(false);
    expect(p.windowStart).toBe(1_000n);
    expect(p.elapsedInWindow).toBe(50n);
    expect(p.vbSnapshot).toBe(1_000_000n);
    expect(p.cap).toBe(100_000n); // 10% of vb
    expect(p.usedWithoutTrade).toBe(5_000n);
  });

  test("one period elapsed: rotation — current becomes previous, decays linearly", () => {
    const p = projectSelloffWindow({
      ...base,
      previousSelloff: 9_999n,
      currentSelloff: 8_000n,
      selloffVbSnapshot: 1_000_000n,
      now: 1_150, // elapsed 150 ∈ [period, 2*period)
    });
    expect(p.opened).toBe(true);
    expect(p.windowStart).toBe(1_100n);
    expect(p.elapsedInWindow).toBe(50n);
    expect(p.previous).toBe(8_000n); // old current
    expect(p.current).toBe(0n);
    // weightedPrev = 8000 * (100 - 50) / 100
    expect(p.weightedPrev).toBe(4_000n);
    expect(p.usedWithoutTrade).toBe(4_000n);
  });

  test("two periods elapsed: full reset", () => {
    const p = projectSelloffWindow({
      ...base,
      previousSelloff: 9_999n,
      currentSelloff: 8_000n,
      selloffVbSnapshot: 500n,
      now: 1_500,
    });
    expect(p.opened).toBe(true);
    expect(p.windowStart).toBe(1_500n);
    expect(p.usedWithoutTrade).toBe(0n);
    expect(p.vbSnapshot).toBe(1_000_000n); // re-snapshotted from live vb
  });

  test("v5.1: carried previous is rescaled to the fresh vb snapshot on open", () => {
    const p = projectSelloffWindow({
      ...base,
      currentSelloff: 1_000n,
      selloffVbSnapshot: 1_000_000n,
      virtualBalance: 500_000n, // vb halved between windows
      now: 1_100, // exactly one period → rotation opens a window
    });
    expect(p.opened).toBe(true);
    // previous = old current 1000, rescaled 1000 * 500k / 1000k = 500
    expect(p.previous).toBe(500n);
    expect(p.cap).toBe(50_000n); // 10% of the NEW snapshot
  });

  test("computeSelloffWindow: disabled when maxSelloffPct = 0", () => {
    const s = computeSelloffWindow({
      maxSelloffPct: 0,
      periodLength: 100,
      previousSelloff: new BN(1),
      currentSelloff: new BN(1),
      windowStartTimestamp: new BN(0),
      selloffVbSnapshot: new BN(0),
      virtualBalance: new BN(100),
      now: 50,
    });
    expect(s.enabled).toBe(false);
    expect(s.cap.isZero()).toBe(true);
  });
});

describe("calcSurgeFeePct (v5.1 piecewise-linear, integral-averaged)", () => {
  test("disabled when cap is zero", () => {
    expect(calcSurgeFeePct(0n, 100n, 0n, 8_000, 200, 200, 3_000, 0)).toBe(0);
  });

  test("disabled when slope_high is zero", () => {
    expect(calcSurgeFeePct(0n, 100n, 100n, 8_000, 0, 0, 0, 0)).toBe(0);
  });

  test("zero at/below threshold", () => {
    // f1 = 50*SCALE/100 = 5000 <= thr 8000
    expect(calcSurgeFeePct(0n, 50n, 100n, 8_000, 200, 200, 3_000, 0)).toBe(0);
  });

  test("full sweep pays the curve AVERAGE, not the endpoint", () => {
    // thr=8000, low=0, high=3000, no kink; span [0, cap] ⇒ t ∈ [0, 1]:
    // ∫(0→1) 3000·t dt = 1500 exactly (integer path leaves no remainder).
    const avg = calcSurgeFeePct(0n, 10_000n, 10_000n, 8_000, 0, 0, 3_000, 0);
    expect(avg).toBe(1_500);
    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThan(3_000);
  });

  test("empty span falls back to the point rate (endpoint)", () => {
    // f0 = f1 = SCALE ⇒ t1 = 1 ⇒ rate = low + (high-low) = 3000.
    expect(calcSurgeFeePct(1_000n, 1_000n, 1_000n, 8_000, 0, 0, 3_000, 0)).toBe(3_000);
  });

  test("kinked curve hits exactly `mid` at the kink position", () => {
    // thr=2000, kink=50% ⇒ kink_fill=5000 ⇒ point f=5000 sits ON the kink.
    expect(calcSurgeFeePct(5_000n, 5_000n, 10_000n, 2_000, 100, 700, 3_000, 50)).toBe(700);
  });

  test("kink at/outside the (threshold, 100%) band degenerates to low→high", () => {
    // kink 10% => kink_fill 1000 <= thr 2000 ⇒ ignored: rate(t=1) = high.
    expect(calcSurgeFeePct(10_000n, 10_000n, 10_000n, 2_000, 100, 700, 3_000, 10)).toBe(3_000);
  });

  test("integral averaging is path-independent (audit M-05)", () => {
    // Width-weighted sum of split averages equals the whole-span charge,
    // modulo the per-call CEIL (≤ 1 unit each).
    const cap = 10_000n;
    const args = [8_000, 0, 0, 3_000, 0] as const;
    const whole = calcSurgeFeePct(8_000n, 10_000n, cap, ...args) * 2_000;
    const partA = calcSurgeFeePct(8_000n, 9_000n, cap, ...args) * 1_000;
    const partB = calcSurgeFeePct(9_000n, 10_000n, cap, ...args) * 1_000;
    expect(Math.abs(whole - (partA + partB))).toBeLessThanOrEqual(2 * 1_000);
  });
});

describe("calcSegmentedSurgeFeeAmount (v5.1 swap.rs charge)", () => {
  // Identity curve: output == input slice. Makes expected values exact and
  // isolates the segmentation logic from AMM concavity.
  const identity = (x: bigint) => x;

  const curveArgs = {
    cap: 1_000n,
    thresholdPct: 8_000,
    slopeLowPct: 0,
    slopeMidPct: 0,
    slopeHighPct: 3_000,
    kinkPct: 0,
  };

  test("zero when the whole trade stays below the threshold", () => {
    const fee = calcSegmentedSurgeFeeAmount({
      ...curveArgs,
      effectiveSelloffBefore: 0n,
      effectiveSelloffAfter: 700n, // thr_units = 800
      amountInAfterFee: 700n,
      amountOut: 700n,
      curveOut: identity,
    });
    expect(fee).toBe(0n);
  });

  test("taxes only the above-threshold remainder of the output", () => {
    const fee = calcSegmentedSurgeFeeAmount({
      ...curveArgs,
      effectiveSelloffBefore: 0n,
      effectiveSelloffAfter: 1_000n,
      amountInAfterFee: 1_000n,
      amountOut: 1_000n,
      curveOut: identity,
    });
    // Taxed span [800, 1000] in 4 segments of 50; identity output = 50 each.
    // Segment-average rates of 3000·t over quarters of t∈[0,1]:
    // 375, 1125, 1875, 2625 ⇒ per-segment CEIL(50·avg/10000) = 2+6+10+14.
    expect(fee).toBe(32n);
    expect(fee).toBeLessThan(1_000n);
  });

  test("splitting the sell does not materially reduce the fee", () => {
    const whole = calcSegmentedSurgeFeeAmount({
      ...curveArgs,
      effectiveSelloffBefore: 0n,
      effectiveSelloffAfter: 1_000n,
      amountInAfterFee: 1_000n,
      amountOut: 1_000n,
      curveOut: identity,
    });
    const parts =
      calcSegmentedSurgeFeeAmount({
        ...curveArgs,
        effectiveSelloffBefore: 0n,
        effectiveSelloffAfter: 800n,
        amountInAfterFee: 800n,
        amountOut: 800n,
        curveOut: identity,
      }) +
      calcSegmentedSurgeFeeAmount({
        ...curveArgs,
        effectiveSelloffBefore: 800n,
        effectiveSelloffAfter: 900n,
        amountInAfterFee: 100n,
        amountOut: 100n,
        curveOut: identity,
      }) +
      calcSegmentedSurgeFeeAmount({
        ...curveArgs,
        effectiveSelloffBefore: 900n,
        effectiveSelloffAfter: 1_000n,
        amountInAfterFee: 100n,
        amountOut: 100n,
        curveOut: identity,
      });
    expect(parts).toBeGreaterThan(0n);
    const spread = Number(whole > parts ? whole - parts : parts - whole);
    expect(spread).toBeLessThanOrEqual(Number(whole) * 0.15 + 8);
  });

  test("fee is clamped to amountOut", () => {
    const fee = calcSegmentedSurgeFeeAmount({
      ...curveArgs,
      slopeLowPct: SCALE,
      slopeMidPct: SCALE,
      slopeHighPct: SCALE,
      effectiveSelloffBefore: 800n,
      effectiveSelloffAfter: 1_000n,
      amountInAfterFee: 200n,
      amountOut: 200n,
      curveOut: identity,
    });
    expect(fee).toBe(200n);
  });
});

describe("calcSurgeFeeAmount (flat helper)", () => {
  test("CEIL and clamp", () => {
    expect(calcSurgeFeeAmount(0n, 3_000)).toBe(0n);
    expect(calcSurgeFeeAmount(1_000n, 0)).toBe(0n);
    expect(calcSurgeFeeAmount(1_000n, 1)).toBe(1n); // ceil(0.1)
    expect(calcSurgeFeeAmount(10n, SCALE)).toBe(10n);
  });
});
