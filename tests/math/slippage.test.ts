import { applySlippage, applySwapFee, lpBalances, priceImpactHbps } from "../../src/math/slippage";

describe("applySlippage", () => {
  test("0% slippage returns expected", () => {
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
  });

  test("100% slippage returns 0", () => {
    expect(applySlippage(1_000_000n, 1_000_000)).toBe(0n);
  });

  test("1% slippage (10_000 hbps)", () => {
    expect(applySlippage(1_000_000n, 10_000)).toBe(990_000n);
  });

  test("0.001% slippage (10 hbps)", () => {
    expect(applySlippage(1_000_000n, 10)).toBe(999_990n);
  });

  test("throws on out-of-range slippage", () => {
    expect(() => applySlippage(1n, -1)).toThrow();
    expect(() => applySlippage(1n, 1_000_001)).toThrow();
  });
});

describe("applySwapFee", () => {
  test("0 fee returns full amount", () => {
    expect(applySwapFee(1_000_000n, 0)).toBe(1_000_000n);
  });

  test("1% fee (10_000 hbps) removes 1% of amount", () => {
    expect(applySwapFee(1_000_000n, 10_000)).toBe(990_000n);
  });

  test("0.03% fee (300 hbps)", () => {
    expect(applySwapFee(1_000_000n, 300)).toBe(999_700n);
  });

  test("non-zero fractional fee rounds up to one unit", () => {
    expect(applySwapFee(1n, 3000)).toBe(0n);
    expect(applySwapFee(3998n,1000)).toBe(3994n);
  });

  test("throws on negative rate", () => {
    expect(() => applySwapFee(1n, -1)).toThrow();
  });
});

describe("lpBalances", () => {
  test("no pfo: lpActual=actual, lpVirt=virtual", () => {
    const { lpActual, lpVirtual } = lpBalances(1000n, 500n, 0n);
    expect(lpActual).toBe(1000n);
    expect(lpVirtual).toBe(500n);
  });

  test("stored actual excludes fees, so pending fees are not subtracted again", () => {
    // Vault holdings are actual + pending fees.
    const { lpActual, lpVirtual } = lpBalances(1000n, 2000n, 100n);
    expect(lpActual).toBe(1000n);
    expect(lpVirtual).toBe(2000n);
  });

  test("actual=0 returns virtual unchanged (frozen)", () => {
    const { lpActual, lpVirtual } = lpBalances(0n, 500n, 0n);
    expect(lpActual).toBe(0n);
    expect(lpVirtual).toBe(500n);
  });
});

describe("priceImpactHbps", () => {
  test("0 when spot==actual", () => {
    expect(priceImpactHbps(100n, 100n)).toBe(0);
  });

  test("10% impact → 100_000 hbps", () => {
    expect(priceImpactHbps(1_000_000n, 900_000n)).toBe(100_000);
  });

  test("0 when spot=0", () => {
    expect(priceImpactHbps(0n, 0n)).toBe(0);
  });

  test("0 when actual > spot", () => {
    expect(priceImpactHbps(100n, 200n)).toBe(0);
  });
});
