import {
  calcBptOutGivenExactTokensIn,
  calcOutGivenIn,
  calcSpotOut,
  calcTokensOutGivenBptIn,
} from "../../src/math/cubicMath";

const BN_BILLION = 1_000_000_000n;

describe("cubicMath.calcOutGivenIn", () => {
  test("balanced 50/50 pool, 10% swap returns < balance", () => {
    const out = calcOutGivenIn({
      virtualBalanceIn: BN_BILLION,
      weightInBps: 5000n,
      virtualBalanceOut: BN_BILLION,
      weightOutBps: 5000n,
      amountIn: BN_BILLION / 10n,
      actualBalanceOut: BN_BILLION,
    });
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(BN_BILLION);
    // With equal weights, small trade output is ≈ amount_in * (bO / (bI + aI))
    // so for 10 % trade we expect ~9.09 % out
    expect(Number(out) / Number(BN_BILLION)).toBeCloseTo(0.0909, 2);
  });

  test("80/20 weight ratio amplifies price impact", () => {
    const balanced = calcOutGivenIn({
      virtualBalanceIn: BN_BILLION,
      weightInBps: 5000n,
      virtualBalanceOut: BN_BILLION,
      weightOutBps: 5000n,
      amountIn: BN_BILLION / 10n,
      actualBalanceOut: BN_BILLION,
    });
    const asym = calcOutGivenIn({
      virtualBalanceIn: BN_BILLION,
      weightInBps: 8000n,
      virtualBalanceOut: BN_BILLION,
      weightOutBps: 2000n,
      amountIn: BN_BILLION / 10n,
      actualBalanceOut: BN_BILLION,
    });
    // Higher wI/wO ratio means the out-token appreciates faster → more out
    expect(asym).toBeGreaterThan(balanced);
  });

  test("amountOut exceeding actualBalanceOut is rejected", () => {
    expect(() => calcOutGivenIn({
      virtualBalanceIn: BN_BILLION,
      weightInBps: 5000n,
      virtualBalanceOut: BN_BILLION,
      weightOutBps: 5000n,
      amountIn: BN_BILLION * 100n,
      actualBalanceOut: BN_BILLION / 2n, // ceiling
    })).toThrow("AmountOutExceedsBalance");
  });
});

describe("cubicMath.calcSpotOut", () => {
  test("upper-bound: spot ≥ actual calcOutGivenIn", () => {
    const inputs = {
      virtualBalanceIn: BN_BILLION,
      weightInBps: 5000n,
      virtualBalanceOut: BN_BILLION,
      weightOutBps: 5000n,
      amountIn: BN_BILLION / 10n,
    };
    const spot = calcSpotOut(inputs);
    const actual = calcOutGivenIn({ ...inputs, actualBalanceOut: BN_BILLION });
    expect(spot).toBeGreaterThanOrEqual(actual);
  });

  test("linear in amountIn", () => {
    const params = {
      virtualBalanceIn: BN_BILLION,
      weightInBps: 5000n,
      virtualBalanceOut: BN_BILLION,
      weightOutBps: 5000n,
    };
    const s1 = calcSpotOut({ ...params, amountIn: 1_000_000n });
    const s2 = calcSpotOut({ ...params, amountIn: 2_000_000n });
    expect(s2).toBe(2n * s1);
  });
});

describe("cubicMath.calcBptOutGivenExactTokensIn", () => {
  test("proportional add returns exact ratio", () => {
    // Pool has 1B of each, supply = 1M BPT. User adds 100M of each (10%).
    // BPT out should be 100k (10% of supply).
    const out = calcBptOutGivenExactTokensIn(
      [BN_BILLION, BN_BILLION],
      [BN_BILLION / 10n, BN_BILLION / 10n],
      1_000_000n
    );
    expect(out).toBe(100_000n);
  });

  test("min-ratio wins across uneven deposit", () => {
    // Adding 10% to token 0 but 20% to token 1 — BPT follows token 0's ratio
    const out = calcBptOutGivenExactTokensIn(
      [BN_BILLION, BN_BILLION],
      [BN_BILLION / 10n, BN_BILLION / 5n],
      1_000_000n
    );
    expect(out).toBe(100_000n);
  });

  test("skips zero-actual tokens (sidelined)", () => {
    // Token 1 is sidelined; ratio is determined by token 0 only.
    const out = calcBptOutGivenExactTokensIn(
      [BN_BILLION, 0n],
      [BN_BILLION / 10n, 0n],
      1_000_000n
    );
    expect(out).toBe(100_000n);
  });
});

describe("cubicMath.calcTokensOutGivenBptIn", () => {
  test("proportional burn returns matching slice", () => {
    const outs = calcTokensOutGivenBptIn([BN_BILLION, BN_BILLION], 100_000n, 1_000_000n);
    expect(outs[0]).toBe(BN_BILLION / 10n);
    expect(outs[1]).toBe(BN_BILLION / 10n);
  });

  test("burn of 0 returns all zeros", () => {
    const outs = calcTokensOutGivenBptIn([BN_BILLION, BN_BILLION], 0n, 1_000_000n);
    expect(outs).toEqual([0n, 0n]);
  });
});
