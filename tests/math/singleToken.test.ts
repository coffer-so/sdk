import { computeAllocations } from "../../src/math/singleToken";

describe("computeAllocations", () => {
  test("balanced pool splits 50/50", () => {
    const r = computeAllocations({
      actualBalances: [1_000_000n, 1_000_000n],
      virtualBalances: [1_000_000n, 1_000_000n],
      weightsBps: [5000, 5000],
      amountIn: 1000n,
      tokenInIndex: 0,
    });
    expect(r.allocations).toEqual([500n, 500n]);
  });

  test("sum(allocations) == amountIn after truncation redirect", () => {
    const r = computeAllocations({
      actualBalances: [3n, 7n, 11n, 13n],
      virtualBalances: [10n, 10n, 10n, 10n],
      weightsBps: [2500, 2500, 2500, 2500],
      amountIn: 1_000_000_007n,
      tokenInIndex: 1,
    });
    const sum = r.allocations.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(1_000_000_007n);
  });

  test("sidelined (actBal=0) tokens get 0 allocation", () => {
    const r = computeAllocations({
      actualBalances: [1_000_000n, 0n, 1_000_000n],
      virtualBalances: [1_000_000n, 1_000_000n, 1_000_000n],
      weightsBps: [3333, 3334, 3333],
      amountIn: 900n,
      tokenInIndex: 0,
    });
    expect(r.allocations[1]).toBe(0n);
    expect(r.allocations[0] + r.allocations[2]).toBe(900n);
  });

  test("skewed concentrations shift allocations", () => {
    // Token 0 under-concentrated (0.5x), token 1 over-concentrated (2x).
    // Under-weighted → smaller W → smaller allocation.
    const r = computeAllocations({
      actualBalances: [500_000n, 2_000_000n],
      virtualBalances: [1_000_000n, 1_000_000n],
      weightsBps: [5000, 5000],
      amountIn: 1000n,
      tokenInIndex: 0,
    });
    expect(r.allocations[0]).toBeLessThan(r.allocations[1]);
  });

  test("throws when pool not seeded (ΣW=0)", () => {
    expect(() =>
      computeAllocations({
        actualBalances: [0n, 0n],
        virtualBalances: [1_000_000n, 1_000_000n],
        weightsBps: [5000, 5000],
        amountIn: 1000n,
        tokenInIndex: 0,
      })
    ).toThrow(/PoolNotSeeded/);
  });

  test("throws on zero virtual balance", () => {
    expect(() =>
      computeAllocations({
        actualBalances: [1n, 1n],
        virtualBalances: [0n, 1n],
        weightsBps: [5000, 5000],
        amountIn: 1000n,
        tokenInIndex: 0,
      })
    ).toThrow(/InvalidVirtualBalance/);
  });

  test("length mismatch throws", () => {
    expect(() =>
      computeAllocations({
        actualBalances: [1n, 1n],
        virtualBalances: [1n],
        weightsBps: [5000, 5000],
        amountIn: 1n,
        tokenInIndex: 0,
      })
    ).toThrow(/InvalidTokenCount/);
  });

  test("tokenInIndex out of range throws", () => {
    expect(() =>
      computeAllocations({
        actualBalances: [1n, 1n],
        virtualBalances: [1n, 1n],
        weightsBps: [5000, 5000],
        amountIn: 1n,
        tokenInIndex: 5,
      })
    ).toThrow(/InvalidTokenIndex/);
  });

  test("virtual ceiling clamps allocation weights",()=>{
    expect(computeAllocations({actualBalances:[1000000n,500000000n],virtualBalances:[1000000n,1000000n],weightsBps:[5000,5000],amountIn:1000000n,tokenInIndex:0}).allocations).toEqual([500000n,500000n]);
  });
});
