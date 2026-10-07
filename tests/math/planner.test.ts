/**
 * Ports of `planner.rs` unit tests (contracts `v6`): the TypeScript planner
 * must reproduce the Rust search's exact integers.
 */
import type { TransferFee } from "@solana/spl-token";
import { quoteZap, replay, swapInPool, validatePlanBudget, QuotePool, SimError, isSimFailure } from "../../src/math/planner";
import { SwapLeg } from "../../src/math/swapSim";
import { MathError } from "../../src/math/fixedPoint";

const fee = (bps: number, cap: bigint): TransferFee => ({ epoch: 0n, maximumFee: cap, transferFeeBasisPoints: bps });
const noWindow = { previousSelloff: 0n, currentSelloff: 0n, windowStartTimestamp: 0n, selloffVbSnapshot: 0n };
const noCurve = { thresholdPct: 0, slopeLowPct: 0, slopeMidPct: 0, slopeHighPct: 0, kinkPct: 0 };
function slot(weightBps: bigint, balance = 1_000_000_000n): SwapLeg {
  return { virtualBalance: balance, actualBalance: balance, protocolFeesOwed: 0n, weightBps, isActive: true, maxSelloffPct: 0, maxSelloffPeriodLength: 0, curve: { ...noCurve }, window: { ...noWindow }, transferFee: null };
}
/** `planner.rs::tests::pool(n)`: equal weights, 1e9 balances, 1e9 supply, no fees, now = 100. */
function pool(n: number): QuotePool {
  return { tokens: Array.from({ length: n }, () => slot(BigInt(Math.floor(10_000 / n)))), bptSupply: 1_000_000_000n, swapFeeRate: 0, protocolFeeRate: 0, now: 100n };
}
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const withFee = (p: QuotePool, i: number, f: TransferFee | null): QuotePool => ({ ...p, tokens: p.tokens.map((t, j) => (j === i ? { ...t, transferFee: f } : t)) });

describe("planner (planner.rs ports)", () => {
  test("nonlinear_m07_case_improves_bpt_and_preserves_budget", () => {
    const p = pool(2);
    const old = replay(p, 0, 500_000_000n, [250_000_000n, 250_000_000n]);
    const q = quoteZap(p, 0, 500_000_000n);
    expect(old.bpt).toBe(200_000_000n);
    expect(q.bpt >= 224_744_868n && q.bpt <= 224_744_872n).toBe(true);
    expect(q.bpt > old.bpt + old.bpt / 10n).toBe(true);
    expect(sum(q.allocations)).toBe(500_000_000n);
    expect(q.dust.every((d) => d <= 4n)).toBe(true);
  });

  test("raw_unit_rounding_budgets_return_positive_bpt_with_ceiling_swap_fees", () => {
    const p = { ...pool(2), swapFeeRate: 3000, protocolFeeRate: 2000 };
    for (const amount of [10n, 21n, 101n]) {
      const q = quoteZap(p, 0, amount);
      expect(q.bpt > 1n).toBe(true);
      expect(q.creditedNet.every((c) => c > 0n)).toBe(true);
    }
  });

  test("fee_aware_n2_to_n10_all_inputs_replay_exactly", () => {
    for (let n = 2; n <= 10; n++) {
      let p = { ...pool(n), swapFeeRate: 3000, protocolFeeRate: 2000 };
      for (let i = 0; i < n; i++) p = withFee(p, i, fee(i % 2 === 0 ? 100 : 0, 10_000n));
      for (let input = 0; input < n; input++) {
        const q = quoteZap(p, input, 20_000_000n);
        const replayed = replay(p, input, 20_000_000n, q.allocations);
        expect(q.bpt).toBe(replayed.bpt);
        expect(q.dust).toEqual(replayed.dust);
        for (let i = 0; i < n; i++) {
          expect(q.depositedGross[i] <= q.available[i]).toBe(true);
          const schedule = p.tokens[i].transferFee;
          const net = schedule ? q.depositedGross[i] - (q.depositedGross[i] * BigInt(schedule.transferFeeBasisPoints) + 9_999n) / 10_000n : q.depositedGross[i];
          const capped = schedule && q.depositedGross[i] - net > schedule.maximumFee ? q.depositedGross[i] - schedule.maximumFee : net;
          expect(capped).toBe(q.creditedNet[i]);
        }
      }
    }
  });

  test("full_fee_finite_cap_and_surge_are_modeled_without_helper_hops", () => {
    let p = pool(3);
    p = withFee(p, 0, fee(10_000, 100n));
    p = withFee(p, 1, fee(100, 10_000n));
    p.tokens[0] = { ...p.tokens[0], maxSelloffPct: 5000, maxSelloffPeriodLength: 86_400, curve: { ...noCurve, slopeHighPct: 1000 } };
    const q = quoteZap(p, 0, 20_000_000n);
    expect(q.swaps.every((s) => s.grossInput - s.netInput === 100n && s.surgeFee > 0n)).toBe(true);
    expect(sum(q.allocations)).toBe(20_000_000n);
    expect(q.bpt > 0n).toBe(true);
    expect(() => quoteZap(withFee(p, 0, fee(10_000, (1n << 64n) - 1n)), 0, 20_000_000n)).toThrow(SimError);
  });

  test("sidelined_slots_stay_zero_and_one_live_token_needs_no_swap", () => {
    const p = pool(3);
    p.tokens[1] = { ...p.tokens[1], actualBalance: 0n };
    const q = quoteZap(p, 0, 20_000_000n);
    expect(q.allocations[1]).toBe(0n);
    expect(q.creditedNet[1]).toBe(0n);
    expect(q.stateAfter.tokens[1].virtualBalance > p.tokens[1].virtualBalance).toBe(true);
    expect(() => quoteZap(p, 1, 20_000_000n)).toThrow(SimError);
    p.tokens[2] = { ...p.tokens[2], actualBalance: 0n };
    const single = quoteZap(p, 0, 20_000_000n);
    expect(single.allocations).toEqual([20_000_000n, 0n, 0n]);
    expect(single.swaps).toEqual([]);
  });

  test("small_two_token_plans_match_exhaustive_integer_bpt_search", () => {
    const cases: Array<[number, number, bigint, [bigint, bigint]]> = [
      [0, 0, 0n, [5000n, 5000n]], [100, 250, 100n, [5000n, 5000n]], [10_000, 100, 3n, [3000n, 7000n]], [9999, 10_000, 2n, [7000n, 3000n]],
    ];
    for (const [inputBps, outputBps, cap, weights] of cases) {
      let p = pool(2);
      p.tokens = p.tokens.map((t, i) => ({ ...t, actualBalance: 1000n, virtualBalance: 1000n, weightBps: weights[i] }));
      p = withFee(withFee(p, 0, fee(inputBps, cap)), 1, fee(outputBps, cap));
      for (const input of [0, 1]) {
        const amount = 201n;
        let exhaustive = -1n;
        for (let x = 1n; x < amount; x++) {
          const a = input === 0 ? [amount - x, x] : [x, amount - x];
          try { const r = replay(p, input, amount, a); if (r.bpt > exhaustive) exhaustive = r.bpt; } catch (e) { if (!isSimFailure(e)) throw e; }
        }
        const q = quoteZap(p, input, amount);
        expect(q.bpt).toBe(exhaustive);
      }
    }
  });

  test("plan budget validation (plan.rs::budget_rejects_length_zero_live_sidelined_and_overflow)", () => {
    expect(() => validatePlanBudget([40n, 60n], 100n, 0, [1000n, 1000n])).not.toThrow();
    for (const alloc of [[100n], [0n, 100n], [40n, 59n], [40n, 61n], [(1n << 64n) - 1n, 1n]]) {
      expect(() => validatePlanBudget(alloc, 100n, 0, [1000n, 1000n])).toThrow(SimError);
    }
    expect(() => validatePlanBudget([40n, 0n, 60n], 100n, 0, [1000n, 0n, 1000n])).not.toThrow();
    expect(() => validatePlanBudget([40n, 1n, 59n], 100n, 0, [1000n, 0n, 1000n])).toThrow(SimError);
    expect(() => validatePlanBudget([40n, 0n, 60n], 100n, 1, [1000n, 0n, 1000n])).toThrow(SimError);
  });

  test("swapInPool is copy-on-write and reports both fee legs", () => {
    const p = withFee(withFee(pool(2), 0, fee(100, 1_000_000n)), 1, fee(200, 50n));
    const before = JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const r = swapInPool(p, 0, 1, 1_000_000n);
    expect(JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
    expect(r.leg.netInput).toBe(990_000n);
    expect(r.leg.grossOutput - r.leg.netOutput).toBe(50n);
    expect(r.pool.tokens[0].virtualBalance).toBe(1_000_990_000n);
    expect(r.pool.tokens[1].actualBalance).toBe(1_000_000_000n - r.leg.rawOutput);
    expect(() => swapInPool(p, 0, 0, 1n)).toThrow(SimError);
    expect(() => swapInPool(p, 0, 1, 0n)).toThrow(SimError);
  });

  test("program-equivalent failures are MathError/SimError; config errors propagate", () => {
    const p = pool(2);
    expect(() => replay(p, 0, 10n, [5n, 5n, 0n])).toThrow(SimError);
    expect(() => quoteZap({ ...p, bptSupply: 0n }, 0, 10n)).toThrow(SimError);
    expect(() => quoteZap(p, 0, 0n)).toThrow(SimError);
    expect(isSimFailure(new MathError("x"))).toBe(true);
    expect(isSimFailure(new Error("x"))).toBe(false);
  });

  test("planned-accounting fixture: 300 in, 100 swapped → BPT 95 (plain) / 94 (1 % fees), dust 3 / 2", () => {
    // tests/offline/v6-planned-accounting.test.ts, replayed through the planner.
    for (const withFees of [false, true]) {
      let p: QuotePool = { tokens: [slot(5000n, 2000n), slot(5000n, 1000n)], bptSupply: 1000n, swapFeeRate: 0, protocolFeeRate: 0, now: 100n };
      p.tokens[0] = { ...p.tokens[0], virtualBalance: 1000n };
      if (withFees) p = withFee(withFee(p, 0, fee(100, 1_000_000n)), 1, fee(100, 1_000_000n));
      const q = replay(p, 0, 300n, [200n, 100n]);
      expect(q.bpt).toBe(withFees ? 94n : 95n);
      expect(q.creditedNet[1]).toBe(withFees ? 86n : 87n);
      expect(q.dust).toEqual([0n, withFees ? 2n : 3n]);
      expect(q.depositedGross).toEqual([200n, withFees ? 87n : 87n]);
    }
  });

  test("benchmark: N=10, unequal weights, active window and fee mints stays under budget", () => {
    let p = pool(10);
    p.tokens = p.tokens.map((t, i) => ({
      ...t, weightBps: BigInt([1500, 500, 1000, 1200, 800, 700, 1300, 900, 1100, 1000][i]),
      maxSelloffPct: i % 3 === 0 ? 3000 : 0, maxSelloffPeriodLength: 3600,
      curve: i % 3 === 0 ? { thresholdPct: 5000, slopeLowPct: 100, slopeMidPct: 700, slopeHighPct: 3000, kinkPct: 80 } : { ...noCurve },
      window: i % 3 === 0 ? { previousSelloff: 50_000_000n, currentSelloff: 100_000_000n, windowStartTimestamp: 50n, selloffVbSnapshot: 1_000_000_000n } : { ...noWindow },
      transferFee: i % 2 === 0 ? fee(100, 10_000n) : null,
    }));
    p = { ...p, swapFeeRate: 3000, protocolFeeRate: 2000 };
    const started = Date.now();
    const q = quoteZap(p, 0, 50_000_000n);
    const elapsed = Date.now() - started;
    expect(q.bpt > 0n).toBe(true);
    expect(sum(q.allocations)).toBe(50_000_000n);
    // Reported in docs/PLANNED_ZAP.md; generous bound so CI noise cannot fail it.
    expect(elapsed).toBeLessThan(60_000);
    // eslint-disable-next-line no-console
    console.info(`planner benchmark N=10: ${elapsed} ms, bpt=${q.bpt}`);
  });
});
