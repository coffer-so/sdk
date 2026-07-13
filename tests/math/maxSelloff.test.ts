import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  computeSelloffWindow,
  projectSelloffWindow,
  calcSurgeFeePct,
  calcSurgeFeeAmount,
  SelloffWindowInputs,
} from "../../src/math/maxSelloff";
import { CubicPoolClient, getConfig } from "../../src";
import { PoolInfo } from "../../src/types/pool";
import { RawPoolAccount } from "../../src/parsers/poolAccount";

const ONE = 1_000_000_000_000_000_000n;
const VB = 10_000n;
const FULL = 10_000; // pct 100% → cap == snapshot

function inputs(over: Partial<SelloffWindowInputs>): SelloffWindowInputs {
  return {
    maxSelloffPct: FULL,
    periodLength: 60,
    previousSelloff: new BN(0),
    currentSelloff: new BN(0),
    windowStartTimestamp: new BN(0),
    selloffVbSnapshot: new BN(VB.toString()),
    virtualBalance: new BN(VB.toString()),
    now: 0,
    ...over,
  };
}

describe("computeSelloffWindow — rotation", () => {
  test("no rotation accumulates current, cap from snapshot", () => {
    const s = computeSelloffWindow(
      inputs({ currentSelloff: new BN(300), now: 10 })
    );
    expect(s.enabled).toBe(true);
    expect(s.rotated).toBe(false);
    expect(s.cap.toNumber()).toBe(10_000);
    expect(s.used.toNumber()).toBe(300);
    expect(s.remaining.toNumber()).toBe(9_700);
    expect(s.vbSnapshot.toNumber()).toBe(10_000);
    expect(s.windowStartTimestamp.toNumber()).toBe(0);
  });

  test("single-period rotation: window slides one period, prev=old current", () => {
    // period=60, now=70 → elapsed 70 ∈ [60,120): rotate once.
    const s = computeSelloffWindow(
      inputs({
        maxSelloffPct: 1_000, // 10%
        currentSelloff: new BN(1_000),
        windowStartTimestamp: new BN(0),
        selloffVbSnapshot: new BN(0), // force recapture on open
        virtualBalance: new BN(20_000),
        now: 70,
      })
    );
    expect(s.rotated).toBe(true);
    expect(s.windowStartTimestamp.toNumber()).toBe(60); // slid by ONE period
    expect(s.vbSnapshot.toNumber()).toBe(20_000); // recaptured
    expect(s.cap.toNumber()).toBe(2_000); // 10% of 20_000
    // prev = old current 1000, eiw = 70-60 = 10 → weightedPrev = 1000*50/60 = 833
    expect(s.used.toNumber()).toBe(833);
  });

  test("double-period reset clears both buckets", () => {
    const s = computeSelloffWindow(
      inputs({
        previousSelloff: new BN(5_000),
        currentSelloff: new BN(4_000),
        windowStartTimestamp: new BN(0),
        now: 200, // >= 2*60
      })
    );
    expect(s.rotated).toBe(true);
    expect(s.windowStartTimestamp.toNumber()).toBe(200);
    expect(s.used.toNumber()).toBe(0);
  });

  test("linear decay of previous is exact floor", () => {
    // No rotation (elapsed 10 < 60). prev=1000 → 1000*(60-10)/60 = 833.
    const p = projectSelloffWindow({
      maxSelloffPct: FULL,
      periodLength: 60,
      previousSelloff: 1_000n,
      currentSelloff: 0n,
      windowStartTimestamp: 0n,
      selloffVbSnapshot: VB,
      virtualBalance: VB,
      now: 10,
    });
    expect(p.opened).toBe(false);
    expect(p.weightedPrev).toBe(833n);
    expect(p.usedWithoutTrade).toBe(833n);
  });

  test("snapshot recaptured when stored snapshot is 0 (no rotation)", () => {
    const s = computeSelloffWindow(
      inputs({
        selloffVbSnapshot: new BN(0),
        virtualBalance: new BN(5_000),
        now: 10,
      })
    );
    expect(s.rotated).toBe(false);
    expect(s.vbSnapshot.toNumber()).toBe(5_000);
    expect(s.cap.toNumber()).toBe(5_000);
  });

  test("cap floors down", () => {
    const s = computeSelloffWindow(
      inputs({ maxSelloffPct: 1, selloffVbSnapshot: new BN(9_999), virtualBalance: new BN(9_999) })
    );
    // 1 * 9999 / 10000 = 0
    expect(s.cap.toNumber()).toBe(0);
    expect(s.fillPct).toBe(0);
  });

  test("disabled when maxSelloffPct == 0", () => {
    const s = computeSelloffWindow(inputs({ maxSelloffPct: 0, currentSelloff: new BN(500) }));
    expect(s.enabled).toBe(false);
    expect(s.cap.toNumber()).toBe(0);
    expect(s.used.toNumber()).toBe(0);
    expect(s.fillPct).toBe(0);
  });

  test("inclusive cap boundary via projection: effective==cap ok, cap+1 over", () => {
    const p = projectSelloffWindow({
      maxSelloffPct: FULL,
      periodLength: 60,
      previousSelloff: 0n,
      currentSelloff: 9_000n,
      windowStartTimestamp: 0n,
      selloffVbSnapshot: VB,
      virtualBalance: VB,
      now: 0,
    });
    expect(p.cap).toBe(10_000n);
    expect(p.usedWithoutTrade + 1_000n <= p.cap).toBe(true); // effective == cap
    expect(p.usedWithoutTrade + 1_001n > p.cap).toBe(true); // cap + 1 over
  });
});

describe("calcSurgeFeePct — convex curve", () => {
  test("disabled: cap 0, slopeHigh 0, threshold>=scale", () => {
    expect(calcSurgeFeePct(100n, 0n, 8000, 200, 3000)).toBe(0);
    expect(calcSurgeFeePct(100n, 100n, 8000, 0, 0)).toBe(0);
    expect(calcSurgeFeePct(100n, 100n, 10_000, 200, 3000)).toBe(0);
  });

  test("fee 0 at fill == threshold, fires strictly above", () => {
    expect(calcSurgeFeePct(8_000n, 10_000n, 8000, 200, 3000)).toBe(0);
    const above = calcSurgeFeePct(8_001n, 10_000n, 8000, 200, 3000);
    expect(above).toBeGreaterThanOrEqual(200);
    expect(above).toBeLessThan(210);
  });

  test("exact convex vector: fill 9000 → surge 400", () => {
    // thr=8000, low=100, high=1000 → t=0.5e18, aPowT=2e18, factor=1/3, add=300.
    expect(calcSurgeFeePct(9_000n, 10_000n, 8000, 100, 1000)).toBe(400);
  });

  test("exact midpoint vector: fill 9000, span 10000 → 3334", () => {
    expect(calcSurgeFeePct(9_000n, 10_000n, 8000, 0, 10_000)).toBe(3334);
  });

  test("full fill reaches slope_high", () => {
    expect(calcSurgeFeePct(10_000n, 10_000n, 8000, 200, 3000)).toBe(3000);
  });

  test("saturates above full fill", () => {
    expect(calcSurgeFeePct(99_999n, 10_000n, 8000, 200, 3000)).toBe(3000);
  });

  test("monotonic increasing in fill", () => {
    let last = 0;
    for (const fill of [8001n, 8500n, 9000n, 9500n, 9900n, 10_000n]) {
      const f = calcSurgeFeePct(fill, 10_000n, 8000, 200, 3000);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
    expect(last).toBe(3000);
  });
});

describe("calcSurgeFeeAmount — CEIL + clamp", () => {
  test("exact division", () => {
    expect(calcSurgeFeeAmount(900n, 400)).toBe(36n); // 900*400/10000 = 36
  });
  test("rounds up on remainder", () => {
    expect(calcSurgeFeeAmount(901n, 400)).toBe(37n); // 360400/10000 = 36.04 → 37
  });
  test("clamps to amountOut", () => {
    expect(calcSurgeFeeAmount(500n, 10_000)).toBe(500n);
  });
  test("zero when surgePct 0", () => {
    expect(calcSurgeFeeAmount(1_000n, 0)).toBe(0n);
  });
});

// ---------- quoteSwap integration ----------

const pk = (): PublicKey => Keypair.generate().publicKey;

function mockPool(over?: {
  isActive?: boolean;
  maxSelloffPct?: number;
}): PoolInfo {
  const tokens = [0, 1].map((index) => ({
    index,
    mint: pk(),
    tokenProgram: TOKEN_PROGRAM_ID,
    decimals: 9,
    weightBps: 5000,
    virtualBalance: new BN(1_000_000_000),
    actualBalance: new BN(1_000_000_000),
    protocolFeesOwed: new BN(0),
    vault: pk(),
    concentration: 1,
    isActive: index === 0 ? over?.isActive ?? true : true,
    maxSelloffPct: index === 0 ? over?.maxSelloffPct ?? 0 : 0,
  }));
  return {
    address: pk(),
    config: pk(),
    bump: 255,
    poolId: new BN(1),
    tokenCount: 2,
    tokens,
    bptMint: pk(),
    bptTotalSupply: new BN(1_000_000_000),
    swapFeeRate: 0,
    protocolFeeRate: 0,
    poolEnabled: true,
    swapsEnabled: true,
    createdAt: 0,
    lookupTable: pk(),
    bannedExtensions: new BN(0),
    syncedAt: Date.now(),
  } as PoolInfo;
}

function mockRaw(over?: {
  maxSelloffPct?: number;
  currentSelloff?: number;
  snapshot?: number;
  threshold?: number;
  slopeLow?: number;
  slopeHigh?: number;
}): RawPoolAccount {
  const arr = <T>(a: T, b: T): T[] => [a, b];
  return {
    maxSelloffPct: arr(over?.maxSelloffPct ?? 0, 0),
    maxSelloffPeriodLength: arr(60, 60),
    variableFeeThresholdPct: arr(over?.threshold ?? 8000, 0),
    variableFeeSlopeLowPct: arr(over?.slopeLow ?? 200, 0),
    variableFeeSlopeHighPct: arr(over?.slopeHigh ?? 3000, 0),
    previousSelloff: arr(new BN(0), new BN(0)),
    currentSelloff: arr(new BN(over?.currentSelloff ?? 0), new BN(0)),
    windowStartTimestamp: arr(new BN(1000), new BN(1000)),
    selloffVbSnapshot: arr(new BN(over?.snapshot ?? 0), new BN(0)),
  } as unknown as RawPoolAccount;
}

function client(pool: PoolInfo, raw?: RawPoolAccount): CubicPoolClient {
  const c = new CubicPoolClient({ config: getConfig("devnet"), poolAddress: pool.address });
  (c as unknown as { cache: PoolInfo }).cache = pool;
  if (raw) (c as unknown as { rawAccount: RawPoolAccount }).rawAccount = raw;
  return c;
}

describe("quoteSwap — window + surge", () => {
  test("input token inactive → token_swaps_disabled", () => {
    const c = client(mockPool({ isActive: false }));
    const res = c.quoteSwap(0, 1, new BN(1000));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("token_swaps_disabled");
  });

  test("disabled pool (pct=0) → legacy behavior unchanged, new fields zero", () => {
    const c = client(mockPool({ maxSelloffPct: 0 }));
    const res = c.quoteSwap(0, 1, new BN(1000));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.surgeFeeAmount.toNumber()).toBe(0);
    expect(res.data.windowFillPct).toBe(0);
    expect(res.data.effectiveFeePct).toBe(0);
    // amountOut identical to a plain calcOutGivenIn quote.
    expect(res.data.amountOut.toNumber()).toBeGreaterThan(0);
  });

  test("window overflow → selloff_window_full", () => {
    // pct=100%, snapshot=2000 → cap=2000; current=1000; amountIn=1001 → 2001 > cap.
    const pool = mockPool({ maxSelloffPct: 10_000 });
    const raw = mockRaw({ maxSelloffPct: 10_000, currentSelloff: 1000, snapshot: 2000 });
    const res = client(pool, raw).quoteSwap(0, 1, new BN(1001), 0, 1000);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("selloff_window_full");
  });

  test("inclusive boundary: effective==cap passes and applies surge", () => {
    // cap=2000, current=1000, amountIn=1000 → effective=2000 (100% fill) → surge 3000 (30%).
    const pool = mockPool({ maxSelloffPct: 10_000 });
    const raw = mockRaw({ maxSelloffPct: 10_000, currentSelloff: 1000, snapshot: 2000 });
    const res = client(pool, raw).quoteSwap(0, 1, new BN(1000), 0, 1000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.windowFillPct).toBe(10_000);
    // gross curve out then 30% surge carved off.
    expect(res.data.surgeFeeAmount.toNumber()).toBeGreaterThan(0);
    expect(res.data.effectiveFeePct).toBeCloseTo(3000, 5); // swapFee 0 + 3000
  });

  test("below threshold → no surge, full amount out", () => {
    // cap large, low fill → below 80% threshold.
    const pool = mockPool({ maxSelloffPct: 10_000 });
    const raw = mockRaw({ maxSelloffPct: 10_000, currentSelloff: 0, snapshot: 1_000_000 });
    const res = client(pool, raw).quoteSwap(0, 1, new BN(1000), 0, 1000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.surgeFeeAmount.toNumber()).toBe(0);
    expect(res.data.windowFillPct).toBeLessThan(8000);
  });
});

// ---------- quoteSingleTokenDeposit integration ----------

function mockPool3(over?: { isActive?: boolean; maxSelloffPct?: number }): PoolInfo {
  const tokens = [0, 1, 2].map((index) => ({
    index,
    mint: pk(),
    tokenProgram: TOKEN_PROGRAM_ID,
    decimals: 9,
    weightBps: index === 0 ? 3334 : 3333,
    virtualBalance: new BN(1_000_000_000),
    actualBalance: new BN(1_000_000_000),
    protocolFeesOwed: new BN(0),
    vault: pk(),
    concentration: 1,
    isActive: index === 0 ? over?.isActive ?? true : true,
    maxSelloffPct: index === 0 ? over?.maxSelloffPct ?? 0 : 0,
  }));
  return {
    address: pk(),
    config: pk(),
    bump: 255,
    poolId: new BN(1),
    tokenCount: 3,
    tokens,
    bptMint: pk(),
    bptTotalSupply: new BN(3_000_000_000),
    swapFeeRate: 0,
    protocolFeeRate: 0,
    poolEnabled: true,
    swapsEnabled: true,
    createdAt: 0,
    lookupTable: pk(),
    bannedExtensions: new BN(0),
    syncedAt: Date.now(),
  } as PoolInfo;
}

function mockRaw3(over?: {
  maxSelloffPct?: number;
  snapshot?: number;
  threshold?: number;
  slopeLow?: number;
  slopeHigh?: number;
}): RawPoolAccount {
  const trip = <T>(a: T, rest: T): T[] => [a, rest, rest];
  return {
    maxSelloffPct: trip(over?.maxSelloffPct ?? 0, 0),
    maxSelloffPeriodLength: trip(60, 60),
    variableFeeThresholdPct: trip(over?.threshold ?? 2000, 0),
    variableFeeSlopeLowPct: trip(over?.slopeLow ?? 100, 0),
    variableFeeSlopeHighPct: trip(over?.slopeHigh ?? 5000, 0),
    previousSelloff: trip(new BN(0), new BN(0)),
    currentSelloff: trip(new BN(0), new BN(0)),
    windowStartTimestamp: trip(new BN(1000), new BN(1000)),
    selloffVbSnapshot: trip(new BN(over?.snapshot ?? 0), new BN(0)),
  } as unknown as RawPoolAccount;
}

describe("quoteSingleTokenDeposit — window + surge across legs", () => {
  const AMOUNT = new BN(90_000_000);
  const NOW = 1000;

  test("window disabled (pct=0) → identical to surge-disabled quote", () => {
    const plain = client(mockPool3()).quoteSingleTokenDeposit(0, AMOUNT, 0, NOW);
    // Window enabled but surge curve flat (slopes 0) and cap huge: the
    // netting must be a byte-identical no-op.
    const noop = client(
      mockPool3({ maxSelloffPct: 10_000 }),
      mockRaw3({ maxSelloffPct: 10_000, snapshot: 2_000_000_000, slopeLow: 0, slopeHigh: 0 })
    ).quoteSingleTokenDeposit(0, AMOUNT, 0, NOW);
    expect(plain.ok).toBe(true);
    expect(noop.ok).toBe(true);
    if (!plain.ok || !noop.ok) return;
    expect(noop.data.expectedOuts.map((b) => b.toString())).toEqual(
      plain.data.expectedOuts.map((b) => b.toString())
    );
    expect(noop.data.minOuts.map((b) => b.toString())).toEqual(
      plain.data.minOuts.map((b) => b.toString())
    );
    expect(noop.data.depositedAmounts.map((b) => b.toString())).toEqual(
      plain.data.depositedAmounts.map((b) => b.toString())
    );
    expect(noop.data.estimatedBpt.toString()).toBe(plain.data.estimatedBpt.toString());
  });

  test("surge active → later legs pay progressively higher surge, lower BPT", () => {
    // cap = 100% of snapshot 100e6 = 100_000_000. Swapped legs ≈ 30e6 each →
    // leg1 fill ≈ 3000, leg2 fill ≈ 6000, both above threshold 2000.
    const pool = mockPool3({ maxSelloffPct: 10_000 });
    const surged = client(
      pool,
      mockRaw3({ maxSelloffPct: 10_000, snapshot: 100_000_000 })
    ).quoteSingleTokenDeposit(0, AMOUNT, 0, NOW);
    // Gross baseline: same window, surge curve disabled (slopes 0). Gross
    // leg outs are identical because sim reserves move by GROSS in both.
    const gross = client(
      pool,
      mockRaw3({ maxSelloffPct: 10_000, snapshot: 100_000_000, slopeLow: 0, slopeHigh: 0 })
    ).quoteSingleTokenDeposit(0, AMOUNT, 0, NOW);
    expect(surged.ok).toBe(true);
    expect(gross.ok).toBe(true);
    if (!surged.ok || !gross.ok) return;

    const ratios = [1, 2].map((i) => {
      const g = BigInt(gross.data.expectedOuts[i].toString());
      const n = BigInt(surged.data.expectedOuts[i].toString());
      expect(n < g).toBe(true);
      return Number(((g - n) * 1_000_000n) / g); // surge share in ppm
    });
    expect(ratios[0]).toBeGreaterThan(0);
    expect(ratios[1]).toBeGreaterThan(ratios[0]); // monotonic across legs
    expect(
      BigInt(surged.data.estimatedBpt.toString()) <
        BigInt(gross.data.estimatedBpt.toString())
    ).toBe(true);
  });

  test("window overflow on a later leg → selloff_window_full", () => {
    // cap = 40e6: leg1 (~30e6) passes, leg1+leg2 (~60e6) exceeds.
    const res = client(
      mockPool3({ maxSelloffPct: 10_000 }),
      mockRaw3({ maxSelloffPct: 10_000, snapshot: 40_000_000 })
    ).quoteSingleTokenDeposit(0, AMOUNT, 0, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("selloff_window_full");
  });

  test("input token inactive → token_swaps_disabled", () => {
    const res = client(
      mockPool3({ isActive: false, maxSelloffPct: 10_000 }),
      mockRaw3({ maxSelloffPct: 10_000, snapshot: 2_000_000_000 })
    ).quoteSingleTokenDeposit(0, AMOUNT, 0, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("token_swaps_disabled");
  });
});

describe("getSelloffWindowStatus", () => {
  test("requires sync", () => {
    const c = new CubicPoolClient({ config: getConfig("devnet"), poolAddress: pk() });
    const res = c.getSelloffWindowStatus(0);
    expect(res.ok).toBe(false);
  });

  test("returns projected status", () => {
    const pool = mockPool({ maxSelloffPct: 10_000 });
    const raw = mockRaw({ maxSelloffPct: 10_000, currentSelloff: 300, snapshot: 10_000 });
    const res = client(pool, raw).getSelloffWindowStatus(0, 1000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.enabled).toBe(true);
    expect(res.data.cap.toNumber()).toBe(10_000);
    expect(res.data.used.toNumber()).toBe(300);
  });
});
