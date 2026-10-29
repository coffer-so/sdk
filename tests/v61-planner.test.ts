/**
 * v6.1 planner (`math/planner.ts`): creator share on every leg, the join on
 * NAV with the bucket buy-in, the deposit fee on the final join, the hook
 * fee override, and the infeasible candidates (bucket-only output slot).
 */
import { quoteZap, replay, swapInPool, QuotePool } from "../src/math/planner";
import { splitFee } from "../src/math/feeSplit";
import { applyDepositFee } from "../src/math/liquidityFee";
import { splitDepositCredit } from "../src/math/surgeBucket";
import { calcJoinRatioAndLp } from "../src/math/poolMath";
import { SwapLeg } from "../src/math/swapSim";

const leg = (actual: bigint, virtual: bigint, weight: number, extra: Partial<SwapLeg> = {}): SwapLeg => ({
  virtualBalance: virtual, actualBalance: actual, protocolFeesOwed: 0n, weightBps: BigInt(weight), isActive: true, maxSelloffPct: 0, maxSelloffPeriodLength: 0,
  curve: { thresholdPct: 0, slopeLowPct: 0, slopeMidPct: 0, slopeHighPct: 0, kinkPct: 0 },
  window: { previousSelloff: 0n, currentSelloff: 0n, windowStartTimestamp: 0n, selloffVbSnapshot: 0n }, transferFee: null, ...extra,
});
// v6.1 (T22): every leg is strictly levered (`virtual > actual`).
const pool = (o: Partial<QuotePool> = {}): QuotePool => ({
  tokens: [leg(1_000_000_000n, 2_000_000_000n, 5000), leg(1_000_000_000n, 2_000_000_000n, 3000), leg(500_000_000n, 600_000_000n, 2000)],
  lpSupply: 3_000_000_000n, swapFeeRate: 3000, protocolFeeRate: 1000, now: 1_700_000_000n, ...o,
});

describe("planner v6.1", () => {
  test("[P01] a plan quotes with the creator share on every leg", () => {
    const q = quoteZap(pool({ creatorFeeBps: 2500 }), 0, 100_000_000n);
    for (const s of q.swaps) {
      const split = splitFee(s.baseFee, 1000, 2500);
      expect(s.protocolFee).toBe(split.protocol); expect(s.creatorFee).toBe(split.creator);
      expect(s.effectiveFeeRate).toBe(3000);
    }
    expect(q.stateAfter.tokens[0].creatorFeesOwed).toBe(q.swaps.reduce((a, s) => a + s.creatorFee, 0n));
  });
  test("[P02] the creator share never changes the trader's output on a leg", () => {
    const a = swapInPool(pool({ creatorFeeBps: 0 }), 0, 1, 40_000_000n), b = swapInPool(pool({ creatorFeeBps: 10_000 }), 0, 1, 40_000_000n);
    for (const k of ["netOutput", "grossOutput", "rawOutput", "baseFee", "protocolFee"] as const) expect(b.leg[k]).toBe(a.leg[k]);
    expect(a.leg.creatorFee).toBe(0n); expect(b.leg.creatorFee).toBe(b.leg.baseFee - b.leg.protocolFee);
    // the creator share leaves the reserves like the protocol share does
    expect(a.pool.tokens[0].actualBalance - b.pool.tokens[0].actualBalance).toBe(b.leg.creatorFee);
    expect(b.pool.tokens[0].creatorFeesOwed).toBe(b.leg.creatorFee);
    // in a multi-leg plan only the FIRST leg is state-identical; later legs see the thinner input reserve
    const alloc = [40_000_000n, 35_000_000n, 25_000_000n];
    const ra = replay(pool({ creatorFeeBps: 0 }), 0, 100_000_000n, alloc), rb = replay(pool({ creatorFeeBps: 10_000 }), 0, 100_000_000n, alloc);
    expect(rb.swaps[0].netOutput).toBe(ra.swaps[0].netOutput);
    expect(rb.swaps[1].netOutput >= ra.swaps[1].netOutput).toBe(true);
  });
  test("[P03] the deposit fee haircuts the LP of the final join; lpGross is the pre-fee mint", () => {
    const a = quoteZap(pool(), 0, 100_000_000n), b = quoteZap(pool({ depositFeeBps: 100 }), 0, 100_000_000n);
    expect(b.allocations).toEqual(a.allocations);
    expect(b.lpGross).toBe(a.lp);
    const { net, fee } = applyDepositFee(a.lp, 100);
    expect(b.lp).toBe(net); expect(b.depositFeeLp).toBe(fee);
    expect(b.stateAfter.lpSupply).toBe(3_000_000_000n + net);
  });
  test("[P04] the join is priced on NAV and buys into the bucket", () => {
    const p = pool({ tokens: [leg(1_000_000_000n, 2_000_000_000n, 5000, { surgeFeesOwed: 50_000_000n }), leg(1_000_000_000n, 2_000_000_000n, 3000), leg(500_000_000n, 600_000_000n, 2000)] });
    const q = quoteZap(p, 1, 100_000_000n);
    expect(q.surgeBuyIn[0] > 0n).toBe(true);
    expect(q.stateAfter.tokens[0].surgeFeesOwed).toBe(50_000_000n + q.surgeBuyIn[0]);
    // slot 0 is a swap output here, so its reserve moves by (join actual − swap output); the bucket only by the buy-in
    const swapOut = q.swaps.filter((s) => s.output === 0).reduce((acc, s) => acc + s.grossOutput, 0n);
    const actualIn = q.stateAfter.tokens[0].actualBalance - (1_000_000_000n - swapOut);
    expect(q.creditedNet[0]).toBe(actualIn + q.surgeBuyIn[0]);
    expect(q.surgeBuyIn[0]).toBe((50_000_000n * q.ratio) / 10n ** 18n);
  });
  test("[P05] replay on NAV agrees with the join math", () => {
    const p = pool({ tokens: [leg(900n * 10n ** 6n, 10n ** 9n, 5000, { surgeFeesOwed: 100n * 10n ** 6n }), leg(10n ** 9n, 2n * 10n ** 9n, 5000)], lpSupply: 10n ** 9n });
    const r = replay(p, 0, 10n ** 8n, [5n * 10n ** 7n, 5n * 10n ** 7n]);
    const after = swapInPool(p, 0, 1, 5n * 10n ** 7n);
    const navs = [after.pool.tokens[0].actualBalance + 100n * 10n ** 6n, after.pool.tokens[1].actualBalance];
    const { lp, ratio } = calcJoinRatioAndLp(navs, [5n * 10n ** 7n, after.leg.netOutput], 10n ** 9n);
    expect(r.lpGross).toBe(lp); expect(r.ratio).toBe(ratio);
    const legSplit = splitDepositCredit(after.pool.tokens[0].actualBalance, 100n * 10n ** 6n, ratio);
    expect(r.surgeBuyIn[0]).toBe(legSplit.bucketIn); expect(r.creditedNet[0]).toBe(legSplit.totalCredit);
  });
  test("[P06] a surge-bearing swap books the LP share into the bucket, never the reserves", () => {
    const windowed = leg(1_000_000_000n, 2_000_000_000n, 5000, {
      maxSelloffPct: 1000, maxSelloffPeriodLength: 3600, curve: { thresholdPct: 1000, slopeLowPct: 100, slopeMidPct: 1800, slopeHighPct: 8000, kinkPct: 75 },
      window: { previousSelloff: 0n, currentSelloff: 50_000_000n, windowStartTimestamp: 1_699_999_000n, selloffVbSnapshot: 1_000_000_000n },
    });
    const p = pool({ tokens: [windowed, leg(1_000_000_000n, 2_000_000_000n, 3000), leg(500_000_000n, 600_000_000n, 2000)], creatorFeeBps: 2500 });
    const r = swapInPool(p, 0, 1, 40_000_000n);
    expect(r.leg.surgeFee > 0n).toBe(true);
    const s = splitFee(r.leg.surgeFee, 1000, 2500);
    expect(r.leg.surgeProtocolFee).toBe(s.protocol); expect(r.leg.surgeCreatorFee).toBe(s.creator); expect(r.leg.surgeLpFee).toBe(s.lp);
    expect(r.pool.tokens[1].surgeFeesOwed).toBe(s.lp);
    expect(r.pool.tokens[1].actualBalance).toBe(1_000_000_000n - r.leg.rawOutput);
  });
  test("[P07] a hook fee override is clamped and applied to every leg", () => {
    const q = quoteZap(pool({ hookFeeOverride: 999_999, hookFeeMin: 100, hookFeeMax: 20_000 }), 0, 100_000_000n);
    for (const s of q.swaps) { expect(s.effectiveFeeRate).toBe(20_000); expect(s.baseFee).toBe((s.netInput * 20_000n + 999_999n) / 1_000_000n); }
    const plain = quoteZap(pool({ swapFeeRate: 20_000 }), 0, 100_000_000n);
    expect(q.lp).toBe(plain.lp); expect(q.allocations).toEqual(plain.allocations);
  });
  test("[P08] without an override the base rate applies", () => {
    const q = quoteZap(pool({ hookFeeMin: 100, hookFeeMax: 20_000 }), 0, 100_000_000n);
    for (const s of q.swaps) expect(s.effectiveFeeRate).toBe(3000);
  });
  test("[P09] v6 behaviour is unchanged when every v6.1 field is absent / zero", () => {
    const a = quoteZap(pool(), 2, 12_345_678n);
    const b = quoteZap(pool({ creatorFeeBps: 0, depositFeeBps: 0, tokens: pool().tokens.map((t) => ({ ...t, creatorFeesOwed: 0n, surgeFeesOwed: 0n })) }), 2, 12_345_678n);
    expect(b.lp).toBe(a.lp); expect(b.allocations).toEqual(a.allocations); expect(b.depositFeeLp).toBe(0n); expect(b.surgeBuyIn.every((x) => x === 0n)).toBe(true);
  });
  test("[P10] the bucket-only slot (actual 0, surge > 0) is live for the join but never a swap output", () => {
    const p = pool({ tokens: [leg(1_000_000_000n, 2_000_000_000n, 5000), leg(0n, 1_000_000_000n, 3000, { surgeFeesOwed: 1_000n }), leg(500_000_000n, 600_000_000n, 2000)] });
    expect(() => swapInPool(p, 0, 1, 1_000n)).toThrow(/InsufficientLiquidity/);
    // The planner cannot route INTO that slot, and the join needs a positive leg for it: the zap is infeasible.
    expect(() => quoteZap(p, 0, 100_000_000n)).toThrow();
  });
  test("[P11] the net LP of a planned zap is never 0 (min_lp must be positive)", () => {
    const q = quoteZap(pool({ depositFeeBps: 9_999 }), 0, 100_000_000n);
    expect(q.lp > 0n).toBe(true);
  });
  test("[N01] a 100 % deposit fee makes every candidate infeasible (DepositFeeConsumesAll)", () => {
    expect(() => quoteZap(pool({ depositFeeBps: 10_000 }), 0, 100_000_000n)).toThrow();
    expect(() => replay(pool({ depositFeeBps: 10_000 }), 0, 100_000_000n, [40_000_000n, 30_000_000n, 30_000_000n])).toThrow(/DepositFeeConsumesAll/);
  });
  test("[N02] a creator share above 100 % fails closed", () => {
    expect(() => swapInPool(pool({ creatorFeeBps: 10_001 }), 0, 1, 1_000n)).toThrow(/CreatorFeeBpsMaxExceeded/);
  });
  test("[N03] an override outside the clamp bounds with feeMin > feeMax is an invalid hook config", () => {
    expect(() => swapInPool(pool({ hookFeeOverride: 5, hookFeeMin: 10, hookFeeMax: 1 }), 0, 1, 1_000n)).toThrow(/InvalidHookConfig/);
  });
  test("[N04] a sidelined input slot is refused", () => {
    const p = pool({ tokens: [leg(0n, 1_000_000_000n, 5000), leg(1_000_000_000n, 2_000_000_000n, 3000), leg(500_000_000n, 600_000_000n, 2000)] });
    expect(() => quoteZap(p, 0, 1_000n)).toThrow(/InvalidTokenIndex/);
  });
  test("[N05] a plan whose allocations do not sum to the input is rejected", () => {
    expect(() => replay(pool(), 0, 100n, [50n, 20n, 20n])).toThrow(/allocations must sum to the input/);
  });
});
