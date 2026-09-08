import { predictLpLoss } from "../../src/math/lpLoss";

/**
 * Golden vector: 2-token 50/50 pool, 0.3% fee, deposit = 10% of the input
 * token's virtual balance. Leg outputs come from this SDK's own
 * computeAllocations + calcOutGivenIn + capDepositAmountsToLpRatio +
 * calcBptOutGivenExactTokensIn on this exact pool state; the reference loss
 * (2.633%) comes from a full profit-maximizing arbitrage simulation of the
 * contract math.
 */
const SCALE = 10n ** 9n;
const BALANCE = 1_000_000n * SCALE;

const golden = {
  weightsBps: [5000, 5000],
  virtualBalances: [BALANCE, BALANCE],
  lpActualBalances: [BALANCE, BALANCE],
  decimals: [9, 9],
  bptTotalSupply: 1_000_000n * SCALE,
  swapFeeRate: 3000,
  protocolFeeRate: 2000,
  tokenInIndex: 0,
  amountIn: 100_000_000_000_000n,
  allocations: [50_000_000_000_000n, 50_000_000_000_000n],
  expectedOuts: [0n, 47_482_973_758_155n],
  depositedAmounts: [49_999_999_999_999n, 45_360_545_661_744n],
  refundAmounts: [1n, 2_122_428_096_411n],
  estimatedBpt: 47_620_408_202_138n,
};

describe("predictLpLoss", () => {
  it("matches the arb-simulation reference on the golden vector", () => {
    const loss = predictLpLoss(golden);
    expect(loss).not.toBeNull();
    expect(loss!).toBeGreaterThan(2.58);
    expect(loss!).toBeLessThan(2.69);
  });

  it("gives the same result with explicit equal external prices", () => {
    const loss = predictLpLoss({ ...golden, prices: [1, 1] });
    expect(loss!).toBeGreaterThan(2.58);
    expect(loss!).toBeLessThan(2.69);
  });

  it("falls back to spot prices when external prices are incomplete", () => {
    const loss = predictLpLoss({ ...golden, prices: [1, null] });
    expect(loss!).toBeGreaterThan(2.58);
    expect(loss!).toBeLessThan(2.69);
  });

  it("returns null on an empty pool", () => {
    expect(predictLpLoss({ ...golden, bptTotalSupply: 0n })).toBeNull();
  });

  it("throws on mismatched array lengths", () => {
    expect(() =>
      predictLpLoss({ ...golden, decimals: [9] })
    ).toThrow("length mismatch");
  });
});
