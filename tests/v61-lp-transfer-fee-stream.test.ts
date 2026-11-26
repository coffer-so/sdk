/**
 * LP transfer fee burn stream (contracts c9f8f1c, X1: true linear vesting
 * with an end timestamp). The SDK mirrors `math/lp_transfer_fee.rs`
 * (`lp_transfer_fee_drip` / `_settle` / `_schedule`) and the collect
 * handler's bookkeeping (`collectLpTransferFeeStep` == the native tests'
 * `model_collect`); every vector below is ported literally from
 * `programs/coffer-pool/src/tests/v61_lp_transfer_fee.rs` (28, 29, 30, 34–38,
 * neg 25) and the proptests 31/32/33/39 run over a fixed-seed generator.
 * The python-verified constants of 34–37 are the cross-check: a mirror that
 * rounds differently anywhere cannot reproduce them.
 */
import {
  collectLpTransferFeeStep, lpBurnStreamOf, lpTransferFeeDrip, lpTransferFeeSchedule, lpTransferFeeSettle, previewLpTransferFeeCollection,
  quoteLpTransferFeeBurnStream, splitLpTransferFee, type LpBurnStream,
} from "../src/math/lpTransferFee";
import { LP_TRANSFER_FEE_BURN_WINDOW_SECS } from "../src/config";
import { bn } from "./helpers/poolFixture";

const W = BigInt(LP_TRANSFER_FEE_BURN_WINDOW_SECS);
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);
const T0 = 1_700_000_000n;

const bs = (pending: bigint, lastTs: bigint, endTs: bigint): LpBurnStream => ({ pending, lastTs, endTs });
const drip = lpTransferFeeDrip;
const schedule = lpTransferFeeSchedule;
const settle = lpTransferFeeSettle;
const triple = (s: LpBurnStream): [bigint, bigint, bigint] => [s.pending, s.lastTs, s.endTs];

/** The pool-side state the collect handler touches, plus the fee account balance (`model_collect`'s `account`). */
interface PoolModel { owed: bigint; stream: LpBurnStream; share: number; account: bigint }
const streamPool = (share: number): PoolModel => ({ owed: 0n, stream: bs(0n, 0n, 0n), share, account: 0n });
/** Steps 3–5 of the collect handler: `account` after the sweeps credited `incoming`; returns `(burned_now, collected)`. */
function modelCollect(p: PoolModel, incoming: bigint, now: bigint): { burned: bigint; collected: bigint } {
  p.account += incoming;
  const step = collectLpTransferFeeStep({ feeAccountAmount: p.account, owedProtocol: p.owed, stream: p.stream, now, shareBps: p.share });
  p.account = step.feeAccountAmountAfter; p.owed = step.owedProtocolAfter; p.stream = step.streamAfter;
  return { burned: step.burnedNow, collected: step.collected };
}
/** A pool whose stream holds `pending` collected at `t0` (share 0). */
function freshStream(pending: bigint, t0: bigint): PoolModel {
  const p = streamPool(0);
  modelCollect(p, pending, t0);
  expect(triple(p.stream)).toEqual(pending === 0n ? [0n, t0, t0] : [pending, t0, t0 + W]);
  return p;
}
/** Collect with no new fees at every instant of `times`; total burned and the number of calls that burned something. */
function collectAt(p: PoolModel, times: bigint[]): { burned: bigint; burning: number } {
  let burned = 0n, burning = 0;
  for (const t of times) { const { burned: b } = modelCollect(p, 0n, t); burned += b; if (b > 0n) burning++; }
  return { burned, burning };
}
const dripAt = (p: PoolModel, now: bigint) => drip(p.stream.pending, p.stream.lastTs, p.stream.endTs, now);
const range = (from: bigint, to: bigint, step = 1n): bigint[] => { const out: bigint[] = []; for (let t = from; t <= to; t += step) out.push(t); return out; };

/** xorshift64* over bigint: a fixed seed makes the "proptests" deterministic. */
function prng(seed: bigint) {
  let s = seed & U64_MAX || 0x9e3779b97f4a7c15n;
  const next = () => { s ^= (s << 13n) & U64_MAX; s ^= s >> 7n; s ^= (s << 17n) & U64_MAX; return s; };
  return {
    u64: next,
    /** inclusive */
    range: (lo: bigint, hi: bigint) => lo + (next() % (hi - lo + 1n)),
    int: (lo: number, hi: number) => Number(lo) + Number(next() % BigInt(hi - lo + 1)),
  };
}

// ── literal vectors ─────────────────────────────────────────────────────────

describe("lp_transfer_fee_drip (28) — edges, other segment lengths, zeroed triple, collapsed segment, saturation", () => {
  test("[P01] ltf_pos_28_drip_edges", () => {
    const t = T0, e = t + W;
    expect(drip(0n, t, e, t + W)).toBe(0n);
    expect(drip(1_000n, t, e, t)).toBe(0n);
    expect(drip(1_000n, t, e, t - 1n)).toBe(0n); // clock behind: nothing
    expect(drip(1_000n, t, e, I64_MIN)).toBe(0n);
    expect(drip(1_000n, t, e, t + 1n)).toBe(0n); // floor(1000 / 86400)
    expect(drip(86_400n, t, e, t + 1n)).toBe(1n);
    expect(drip(1_000n, t, e, t + W / 2n)).toBe(500n);
    expect(drip(1_000n, t, e, t + W - 1n)).toBe(999n);
    expect(drip(1_000n, t, e, t + W)).toBe(1_000n);
    expect(drip(1_000n, t, e, t + 100n * W)).toBe(1_000n);
    expect(drip(1_000n, t, e, I64_MAX)).toBe(1_000n);
    expect(drip(U64_MAX, t, e, t + W - 1n)).toBe(U64_MAX - U64_MAX / 86_400n - 1n);
    expect(drip(U64_MAX, t, e, t + W)).toBe(U64_MAX);
    // other segment lengths: the slope is pending / (end − last)
    expect(drip(1_000n, t, t + 100n, t + 1n)).toBe(10n);
    expect(drip(1_000n, t, t + 100n, t + 99n)).toBe(990n);
    expect(drip(1_000n, t, t + 2n * W, t + W)).toBe(500n);
    expect(drip(1_000n, t, t + 2n * W, t + 2n * W - 1n)).toBe(999n);
    expect(drip(1_000n, t, t + 2n * W, t + 2n * W)).toBe(1_000n);
    // zeroed (legacy / migrated) triple: nothing, no division
    expect(drip(0n, 0n, 0n, t)).toBe(0n);
    expect(drip(0n, 0n, 0n, 0n)).toBe(0n);
    expect(drip(0n, 0n, 0n, I64_MIN)).toBe(0n);
    // a collapsed segment with something pending (unreachable): all at once, no division
    expect(drip(5n, t, t, t)).toBe(0n);
    expect(drip(5n, t, t, t + 1n)).toBe(5n);
    // pending with a zero end (bytes written before the end existed): burns on the next collect
    expect(drip(5n, 0n, 0n, t)).toBe(5n);
    expect(drip(5n, t, 0n, t + 1n)).toBe(5n);
    // saturating at the clock's edges
    expect(drip(5n, I64_MIN, I64_MAX, I64_MAX)).toBe(5n);
    expect(drip(5n, I64_MAX, I64_MIN, 0n)).toBe(0n);
    expect(drip(5n, I64_MIN, I64_MAX, 0n)).toBeLessThanOrEqual(5n);
    expect(drip(U64_MAX, I64_MIN, I64_MAX, 0n)).toBeLessThanOrEqual(U64_MAX);
    // number timestamps and the i64 / u64 guards
    expect(drip(1_000n, Number(t), Number(e), Number(t + W / 2n))).toBe(500n);
    expect(() => drip(-1n, 0n, 0n, 0n)).toThrow(/u64/);
    expect(() => drip(1n, I64_MAX + 1n, 0n, 0n)).toThrow(/i64/);
    expect(() => drip(1n, 0n, 0n, I64_MIN - 1n)).toThrow(/i64/);
  });
});

describe("lp_transfer_fee_schedule / _settle (37, 38, neg 25) — weighted re-base, settle rules, guards", () => {
  test("[P02] ltf_pos_37_weighted_rebase_examples (python-verified)", () => {
    const t0 = T0;
    // P = 1000 with half a window left + A = 1000: D = (1000·W/2 + 1000·W)/2000 = 3W/4
    expect(schedule(bs(1_000n, t0, t0 + W / 2n), 1_000n, t0)).toEqual(bs(2_000n, t0, t0 + 64_800n));
    // P = 900 accrued 50 s of a window (0.5208 of a unit) + A = 900 at t0 + 50: D = W − 25, shift 25
    const s = schedule(bs(900n, t0, t0 + W), 900n, t0 + 50n);
    expect(s).toEqual(bs(1_800n, t0 + 25n, t0 + 50n + 86_375n));
    expect(1_800n * 25n * 86_400n).toBe(900n * 50n * (86_375n + 25n));
    expect(drip(s.pending, s.lastTs, s.endTs, t0 + 50n)).toBe(0n);
    expect(drip(s.pending, s.lastTs, s.endTs, t0 + 50n + 22n)).toBe(0n);
    expect(drip(s.pending, s.lastTs, s.endTs, t0 + 50n + 23n)).toBe(1n);
    // 1 unit onto 1e9 with 10 s left: floor((1e10 + W) / (1e9 + 1)) = 10 → end unchanged
    expect(schedule(bs(1_000_000_000n, t0, t0 + W), 1n, t0 + W - 10n)).toEqual(bs(1_000_000_001n, t0 + W - 10n, t0 + W));
    // 1e9 onto a 1-unit stream that accrued 80 000 s: end = now + W − 1, nothing now
    const big = schedule(bs(1n, t0, t0 + W), 1_000_000_000n, t0 + 80_000n);
    expect(big).toEqual(bs(1_000_000_001n, t0 + 80_000n, t0 + 80_000n + W - 1n));
    expect(drip(big.pending, big.lastTs, big.endTs, t0 + 80_000n)).toBe(0n);
    expect(drip(big.pending, big.lastTs, big.endTs, t0 + 80_001n)).toBe(11_574n);
    // a fresh stream always gets a whole window; the amount adds up
    expect(schedule(bs(0n, t0 - 5n, t0 - 5n), 7n, t0)).toEqual(bs(7n, t0, t0 + W));
    expect(schedule(bs(0n, 0n, 0n), U64_MAX, t0)).toEqual(bs(U64_MAX, t0, t0 + W));
    // zero changes nothing, whatever the state
    for (const z of [bs(0n, 0n, 0n), bs(5n, t0, t0 + 3n), bs(5n, t0, t0 + W)]) {
      expect(schedule(z, 0n, t0 + 100n)).toEqual(z);
      expect(schedule(z, 0n, t0 + 100n)).not.toBe(z); // a copy, never the caller's object
    }
    expect(schedule(bs(1_000n, t0, t0 + W / 2n), 1_000n, Number(t0))).toEqual(bs(2_000n, t0, t0 + 64_800n));
  });
  test("[P03] ltf_pos_38_settle_rules", () => {
    const t0 = T0;
    const s = bs(1_000n, t0, t0 + W);
    expect(settle(s, 0n, t0 + 5n)).toEqual(s);
    expect(settle(s, 1n, t0 + 5n)).toEqual(bs(999n, t0 + 5n, t0 + W));
    expect(settle(s, 1_000n, t0 + 5n)).toEqual(bs(0n, t0 + 5n, t0 + 5n));
    expect(settle(bs(0n, t0, t0), 0n, t0 + 9n)).toEqual(bs(0n, t0 + 9n, t0 + 9n));
    expect(() => settle(s, 1_001n, t0 + 5n)).toThrow(/MathUnderflow/);
    // the pool-side sequence
    let p = schedule(bs(0n, 0n, 0n), 1_000n, t0);
    expect(() => settle(p, 1_001n, t0 + 1n)).toThrow(/MathUnderflow/);
    expect(triple(p)).toEqual([1_000n, t0, t0 + W]); // nothing written on failure (pure)
    p = settle(p, 0n, t0 + 1n);
    expect(triple(p)).toEqual([1_000n, t0, t0 + W]);
    p = settle(p, 10n, t0 + 1n);
    expect(triple(p)).toEqual([990n, t0 + 1n, t0 + W]);
    p = settle(p, 990n, t0 + 2n);
    expect(triple(p)).toEqual([0n, t0 + 2n, t0 + 2n]);
    expect(() => settle(s, -1n, t0)).toThrow(/u64/);
  });
  test("[N01] ltf_neg_25_stream_guards — corrupt / extreme states never divide by zero; overflows are errors", () => {
    const t0 = T0;
    // collapsed segment with something pending: schedule and drip still work
    let s = schedule(bs(5n, t0, t0), 1n, t0);
    expect(s).toEqual(bs(6n, t0, t0 + 14_400n)); // rem 0: D = floor(W / 6)
    expect(drip(6n, t0, t0 + 14_400n, t0)).toBe(0n);
    // clock behind `last`: no accrual carried, a positive duration
    s = schedule(bs(5n, t0 + 100n, t0 + W), 1n, t0);
    expect(s.pending).toBe(6n); expect(s.lastTs).toBe(t0);
    expect(s.endTs > t0 && s.endTs <= t0 + W).toBe(true);
    // end before `last` (corrupt): drip 0 before `last`, everything after
    expect(drip(5n, t0 + 10n, t0, t0 + 5n)).toBe(0n);
    expect(drip(5n, t0 + 10n, t0, t0 + 11n)).toBe(5n);
    s = schedule(bs(5n, t0 + 10n, t0), 1n, t0 + 20n);
    expect(s.pending).toBe(6n);
    expect(s.endTs > t0 + 20n && s.endTs <= t0 + 20n + W && s.lastTs <= t0 + 20n).toBe(true);
    // a settle that skipped the drip and left a full unit accrued: clamped
    s = schedule(bs(86_400n, t0, t0 + W), 1n, t0 + 3n);
    expect(drip(s.pending, s.lastTs, s.endTs, t0 + 3n)).toBe(0n);
    expect(s.endTs - s.lastTs < 2n * W).toBe(true);
    // pending at the limit
    s = schedule(bs(U64_MAX - 1n, t0, t0 + W), 1n, t0 + 1n);
    expect(s.pending).toBe(U64_MAX);
    expect(drip(U64_MAX, s.lastTs, s.endTs, t0 + 1n)).toBe(0n);
    expect(drip(U64_MAX, s.lastTs, s.endTs, s.endTs)).toBe(U64_MAX);
    expect(() => schedule(bs(U64_MAX, t0, t0 + W), 1n, t0 + 1n)).toThrow(/MathOverflow/);
    expect(() => schedule(bs(0n, 0n, 0n), 1n, I64_MAX)).toThrow(/MathOverflow/);
    expect(() => schedule(bs(1n, I64_MAX - W, I64_MAX), 1n, I64_MAX - 1n)).toThrow(/MathOverflow/);
    // the pool method rejects the same and writes nothing on failure
    const p = schedule(bs(0n, 0n, 0n), U64_MAX, t0);
    expect(() => schedule(p, 1n, t0 + 1n)).toThrow(/MathOverflow/);
    expect(triple(p)).toEqual([U64_MAX, t0, t0 + W]);
    expect(drip(p.pending, p.lastTs, p.endTs, t0 + W / 2n)).toBe(U64_MAX / 2n);
    // drip at the clock's edges on absurd segments
    for (const [pending, last, end, now] of [
      [5n, I64_MIN, I64_MAX, 0n], [U64_MAX, I64_MIN, I64_MAX, I64_MAX - 1n], [U64_MAX, I64_MIN + 1n, I64_MIN + 2n, I64_MIN + 1n], [U64_MAX, 0n, I64_MAX, I64_MAX / 2n],
    ] as const) {
      expect(drip(pending, last, end, now)).toBeLessThanOrEqual(pending);
    }
    // the mirror's own guards: u64 / i64 domains
    expect(() => schedule(bs(-1n, 0n, 0n), 1n, t0)).toThrow(/u64/);
    expect(() => schedule(bs(1n, 0n, 0n), -1n, t0)).toThrow(/u64/);
    expect(() => schedule(bs(1n, 0n, I64_MAX + 1n), 1n, t0)).toThrow(/i64/);
  });
});

describe("collect-step mirror (29, 30, 34, 35, 36) — python-verified constants", () => {
  test("[P04] ltf_pos_29: a collection joining a live stream moves the end by exactly floor(A · (now + W − end) / (P + A)); the merged stream drains at its end", () => {
    const t0 = T0;
    const batches: Array<[bigint, bigint]> = [[0n, 1_000_000_000n], [W / 2n, 3_000_000_000n], [W / 2n + 1n, 1n], [W, 50_000n], [(5n * W) / 4n, 777_777_777n], [(5n * W) / 4n + 3n, 1n]];
    const p = streamPool(0);
    let burned = 0n;
    for (const [at, amount] of batches) {
      const now = t0 + at;
      const b = dripAt(p, now);
      const q = settle(p.stream, b, now);
      const expectedEnd = q.pending === 0n ? now + W : q.endTs + (amount * (now + W - q.endTs)) / (q.pending + amount);
      const { burned: bb } = modelCollect(p, amount, now);
      expect(bb).toBe(b);
      burned += bb;
      expect(p.stream.pending).toBe(q.pending + amount);
      expect(p.stream.endTs).toBe(expectedEnd);
      expect(p.stream.endTs >= q.endTs && p.stream.endTs <= now + W).toBe(true);
      expect(dripAt(p, now)).toBe(0n); // nothing at zero elapsed
    }
    const { pending, endTs } = p.stream;
    expect(dripAt(p, endTs - 1n)).toBeLessThan(pending);
    expect(dripAt(p, endTs)).toBe(pending);
    const { burned: last } = modelCollect(p, 0n, endTs);
    expect(burned + last).toBe(batches.reduce((a, [, x]) => a + x, 0n));
    expect(triple(p.stream)).toEqual([0n, endTs, endTs]);
    expect(p.account).toBe(0n);
  });
  test("[P05] ltf_pos_30: a position entering after a collect and leaving t later is released exactly floor(P · t / W)", () => {
    const pending = 4_000_000_000n, t0 = T0;
    for (const t of [1n, 600n, W / 4n, W / 2n, W]) {
      const p = streamPool(0);
      modelCollect(p, pending, t0);
      expect(modelCollect(p, 0n, t0 + t).burned).toBe((pending * t) / W);
    }
  });
  test("[P06] ltf_pos_34 (X1 repro): frequent collects do not stall a small pending; the end never moves", () => {
    const t0 = T0;
    const single = drip(9_000n, t0, t0 + W, t0 + 20n);
    expect(single).toBe(2n);
    for (const [times, expected, burning] of [
      [[20n], 2n, 1], [[2n, 4n, 6n, 8n, 10n, 12n, 14n, 16n, 18n, 20n], 2n, 2], [range(1n, 20n), 2n, 2], [[2n, 4n, 7n, 9n, 11n, 13n, 16n, 18n, 20n], 1n, 1],
    ] as Array<[bigint[], bigint, number]>) {
      const p = freshStream(9_000n, t0);
      const r = collectAt(p, times.map((t) => t0 + t));
      expect([r.burned, r.burning]).toEqual([expected, burning]);
      expect(r.burned >= 1n && r.burned + BigInt(r.burning) >= single && r.burned <= single).toBe(true);
      expect([p.stream.pending, p.stream.endTs]).toEqual([9_000n - r.burned, t0 + W]);
      expect(p.stream.lastTs > t0 && p.stream.lastTs <= t0 + 20n).toBe(true);
      expect(p.account).toBe(p.stream.pending);
    }
    // the off-phase grid: the first unit at 11 s (floor(9000·11/86400) = 1), the next needs 9.6 s more over the remaining 8 999 / 86 389 s
    const p = freshStream(9_000n, t0);
    collectAt(p, [t0 + 2n, t0 + 4n, t0 + 7n, t0 + 9n]);
    expect(triple(p.stream)).toEqual([9_000n, t0, t0 + W]); // nothing burned, nothing re-based
    collectAt(p, [t0 + 11n]);
    expect(triple(p.stream)).toEqual([8_999n, t0 + 11n, t0 + W]);
    expect(dripAt(p, t0 + 20n)).toBe(0n);
    expect(dripAt(p, t0 + 21n)).toBe(1n);
  });
  test("[P07] ltf_pos_35: hourly collects follow the line within k units and complete at the end — no exponential tail", () => {
    const t0 = T0;
    for (const [pending, maxDeficit] of [[1_000_000_000n, 5n], [9_000n, 0n], [U64_MAX / 2n, 23n]] as Array<[bigint, bigint]>) {
      const p = freshStream(pending, t0);
      let burned = 0n, worst = 0n;
      for (let k = 1n; k <= 24n; k++) {
        burned += modelCollect(p, 0n, t0 + k * 3_600n).burned;
        const ideal = (pending * k) / 24n;
        expect(burned <= ideal).toBe(true);
        expect(burned + k >= ideal).toBe(true);
        if (ideal - burned > worst) worst = ideal - burned;
        if (k < 24n) expect(triple(p.stream)).toEqual([pending - burned, t0 + k * 3_600n, t0 + W]);
      }
      expect(worst <= maxDeficit).toBe(true);
      expect(burned).toBe(pending);
      expect(triple(p.stream)).toEqual([0n, t0 + W, t0 + W]);
      expect(p.account).toBe(0n);
    }
  });
  test("[P08] ltf_pos_36: dust griefing is bounded — (i) 1 unit / minute for a day, (ii) 1 unit / s and / 2 s for an hour, (iii) tiny streams, (iv) same-instant dust", () => {
    const t0 = T0;
    // (i) 1 unit / minute on 1e6 for a day
    let p = freshStream(1_000_000n, t0);
    let burned = 0n, sumBound = 0n;
    for (let k = 1n; k <= 1_440n; k++) {
      const now = t0 + 60n * k;
      const b = dripAt(p, now);
      const q = settle(p.stream, b, now);
      const { burned: bb } = modelCollect(p, 1n, now);
      expect(bb).toBe(b);
      burned += bb;
      const ext = p.stream.endTs - q.endTs;
      const exact = (now + W - q.endTs) / (q.pending + 1n);
      expect(ext).toBe(exact);
      expect(ext <= W / (q.pending + 1n)).toBe(true);
      sumBound += exact;
      expect(p.stream.endTs <= now + W).toBe(true);
    }
    expect(burned).toBe(998_439n);
    expect(triple(p.stream)).toEqual([3_001n, t0 + W, t0 + W + 408n]);
    expect(sumBound).toBe(408n);
    const flush = modelCollect(p, 0n, t0 + W + 408n);
    expect([flush.burned, p.stream.pending, p.account]).toEqual([3_001n, 0n, 0n]);
    // (ii) 1 unit per second / per two seconds on 9 000 for an hour: no stall
    for (const [step, expected, pendingAfter, ext] of [[1n, 425n, 12_175n, 0n], [2n, 364n, 10_436n, 0n]] as Array<[bigint, bigint, bigint, bigint]>) {
      p = freshStream(9_000n, t0);
      burned = 0n;
      for (let k = 1n; k <= 3_600n / step; k++) burned += modelCollect(p, 1n, t0 + step * k).burned;
      expect(burned).toBe(expected);
      expect([p.stream.pending, p.stream.endTs]).toEqual([pendingAfter, t0 + W + ext]);
      expect(p.stream.lastTs > t0 + 3_600n - 2n * step && p.stream.lastTs <= t0 + 3_600n).toBe(true);
      expect(burned + 3_600n / step / 2n >= 375n).toBe(true); // a dust-free hour burns 375; one dust unit per call costs at most one second of accrual
    }
    // (iii) the same for a tiny stream: 1 unit of dust per second on 100 / on 1
    p = freshStream(100n, t0); burned = 0n;
    for (let k = 1n; k <= 3_600n; k++) burned += modelCollect(p, 1n, t0 + k).burned;
    expect([burned, p.stream.pending, p.stream.endTs]).toEqual([80n, 3_620n, t0 + W]);
    expect(p.stream.lastTs > t0 + 3_500n && p.stream.lastTs <= t0 + 3_600n).toBe(true);
    p = freshStream(1n, t0); burned = 0n;
    for (let k = 1n; k <= 3_600n; k++) burned += modelCollect(p, 1n, t0 + k).burned;
    expect([burned, p.stream.pending, p.stream.endTs]).toEqual([76n, 3_525n, t0 + W + 76n]);
    expect(p.stream.lastTs > t0 + 3_500n && p.stream.lastTs <= t0 + 3_600n).toBe(true);
    // (iv) many same-instant dust additions on an accrual of 0.9375 of a unit keep it below one unit at zero elapsed and release the unit a second later
    p = freshStream(9_000n, t0);
    collectAt(p, [t0 + 9n]);
    expect(triple(p.stream)).toEqual([9_000n, t0, t0 + W]);
    for (let i = 0; i < 50; i++) p.stream = schedule(p.stream, 1n, t0 + 9n);
    expect(triple(p.stream)).toEqual([9_050n, t0, t0 + W]);
    expect(dripAt(p, t0 + 9n)).toBe(0n);
    expect(dripAt(p, t0 + 10n)).toBe(1n);
  });
});

// ── proptests (fixed seeds) ─────────────────────────────────────────────────

describe("properties over a fixed-seed generator (31, 32, 33, 39)", () => {
  const CASES = 256;
  test("[P09] ltf_pos_31: drip bounds over any segment, the exact floor in between, monotone in pending and elapsed", () => {
    const r = prng(0x31n);
    for (let c = 0; c < CASES; c++) {
      const pending = r.u64(), other = r.u64();
      const last = r.range(-5_000_000_000n, 5_000_000_000n - 1n);
      const d = r.range(1n, 2n * W);
      const e1 = r.range(-10n, 3n * W - 1n), e2 = r.range(-10n, 3n * W - 1n);
      const end = last + d;
      const d1 = drip(pending, last, end, last + e1);
      expect(d1 <= pending).toBe(true);
      if (e1 <= 0n) expect(d1).toBe(0n);
      else if (e1 >= d) expect(d1).toBe(pending);
      else expect(d1).toBe((pending * e1) / d);
      const d2 = drip(pending, last, end, last + e2);
      expect(e1 <= e2 ? d1 <= d2 : d1 >= d2).toBe(true);
      const lo = pending < other ? pending : other, hi = pending < other ? other : pending;
      expect(drip(lo, last, end, last + e1) <= drip(hi, last, end, last + e1)).toBe(true);
    }
  });
  test("[P10] ltf_pos_32: conservation and the fee-account invariant over random collects; state invariants after every call", () => {
    const r = prng(0x32n);
    for (let c = 0; c < CASES; c++) {
      const share = r.int(0, 10_000);
      const rounds = r.int(1, 23);
      const p = streamPool(share);
      let now = T0, totalIn = 0n, totalBurned = 0n;
      for (let i = 0; i < rounds; i++) {
        const amount = r.range(0n, 1_000_000_000_000n), gap = r.range(0n, 2n * W);
        now += gap;
        const before = p.stream;
        const expectedDrip = drip(before.pending, before.lastTs, before.endTs, now);
        const { burned, collected } = modelCollect(p, amount, now);
        expect(burned).toBe(expectedDrip);
        expect(burned <= before.pending).toBe(true);
        expect(collected).toBe(amount);
        totalIn += amount; totalBurned += burned;
        expect(p.account).toBe(p.owed + p.stream.pending);
        expect(totalIn).toBe(p.owed + totalBurned + p.stream.pending);
        // the split of this collection landed in the two buckets untouched
        const split = splitLpTransferFee(amount, share);
        expect(p.stream.pending >= split.burn).toBe(true);
        // state invariants
        const { pending, lastTs, endTs } = p.stream;
        expect(lastTs <= now && endTs <= now + W).toBe(true);
        expect(endTs - lastTs < 2n * W).toBe(true);
        expect(pending === 0n).toBe(lastTs === endTs);
        expect(dripAt(p, now)).toBe(0n); // (b) zero elapsed
        expect(dripAt(p, endTs)).toBe(pending); // (e) all at the end
        if (pending > 0n) expect(dripAt(p, endTs - 1n)).toBeLessThan(pending);
        // same-timestamp repeat: zero burn, zero change
        const snapshot = [p.owed, ...triple(p.stream), p.account];
        const again = modelCollect(p, 0n, now);
        expect([again.burned, again.collected]).toEqual([0n, 0n]);
        expect([p.owed, ...triple(p.stream), p.account]).toEqual(snapshot);
      }
      // a full idle window flushes the stream completely (end ≤ now + W)
      const last = modelCollect(p, 0n, now + W).burned;
      expect(last).toBe(totalIn - p.owed - totalBurned);
      expect(triple(p.stream)).toEqual([0n, now + W, now + W]);
      expect(p.account).toBe(p.owed);
    }
  });
  test("[P11] ltf_pos_33: any partition of an elapsed E burns within one unit per burning call of the single-call drip; the end never moves without new fees", () => {
    const r = prng(0x33n);
    for (let c = 0; c < CASES; c++) {
      const pending = r.u64();
      const gaps = Array.from({ length: r.int(1, 15) }, () => r.range(0n, W));
      const t0 = T0;
      const p = freshStream(pending, t0);
      const times: bigint[] = [];
      let now = t0;
      for (const g of gaps) { now += g; times.push(now); }
      const { burned, burning } = collectAt(p, times);
      const single = drip(pending, t0, t0 + W, now);
      expect(burned <= single).toBe(true);
      expect(burned + BigInt(burning) >= single).toBe(true);
      expect(burning <= gaps.length).toBe(true);
      const { pending: left, lastTs, endTs } = p.stream;
      expect(left).toBe(pending - burned);
      if (left > 0n) { expect(endTs).toBe(t0 + W); expect(lastTs <= now).toBe(true); }
      else expect([lastTs, endTs]).toEqual([now, now]); // every collect on an empty stream collapses it to `now`
    }
  });
  test("[P12] ltf_pos_39: an addition onto ANY reachable state — nothing at zero elapsed, the end moves by exactly the weighted amount, the accrual is carried, drains at its end", () => {
    const r = prng(0x39n);
    for (let c = 0; c < CASES; c++) {
      const p = streamPool(0);
      let now = T0;
      for (let i = r.int(0, 7); i > 0; i--) { const amount = r.range(0n, 1_000_000_000n), g = r.range(0n, W); now += g; modelCollect(p, amount, now); }
      const x = r.range(1n, 1_000_000_000_000n);
      now += r.range(0n, W);
      // settle first (as the handler does), then look at what schedule does
      const b = dripAt(p, now);
      p.stream = settle(p.stream, b, now);
      const before = p.stream;
      const after = schedule(before, x, now);
      expect(after.pending).toBe(before.pending + x);
      // (b)
      expect(drip(after.pending, after.lastTs, after.endTs, now)).toBe(0n);
      // (d)
      const expectedEnd = before.pending === 0n ? now + W : before.endTs + (x * (now + W - before.endTs)) / (before.pending + x);
      expect(after.endTs).toBe(expectedEnd);
      const floorEnd = before.endTs < now + W ? before.endTs : now + W;
      expect(after.endTs <= now + W && after.endTs >= floorEnd).toBe(true);
      expect(after.lastTs <= now && after.endTs - after.lastTs < 2n * W).toBe(true);
      // carried accrual: f' = T·δ / (D + δ) vs f = P·(now − L) / (E − L), both < 1
      const t_ = after.pending, delta = now - after.lastTs, dd = after.endTs - now;
      expect(t_ * delta < dd + delta).toBe(true); // never a full unit at zero elapsed
      if (before.pending > 0n && now > before.lastTs) {
        const pp = before.pending, el = now - before.lastTs, d = before.endTs - before.lastTs;
        expect(pp * el < d).toBe(true); // the settle left less than a unit
        const cap = (dd - 1n) / (t_ - 1n);
        expect(t_ * delta * d >= pp * el * (dd + delta) || delta === cap).toBe(true); // f' ≥ f unless the cap bound it
      } else {
        expect(after.lastTs).toBe(now);
      }
      // (e)
      expect(drip(after.pending, after.lastTs, after.endTs, after.endTs)).toBe(after.pending);
      expect(drip(after.pending, after.lastTs, after.endTs, after.endTs - 1n)).toBeLessThan(after.pending);
    }
  });
});

// ── the SDK surface over the mirror ─────────────────────────────────────────

describe("collectLpTransferFeeStep / preview / quote are the same bookkeeping", () => {
  test("[P13] lpBurnStreamOf reads BN / number / bigint snapshots and zero-fills missing fields (migrated pool)", () => {
    expect(lpBurnStreamOf({ lpTransferFeesPendingBurn: bn(5), lpTransferFeeBurnLastTs: bn(T0), lpTransferFeeBurnEndTs: bn(T0 + W) })).toEqual(bs(5n, T0, T0 + W));
    expect(lpBurnStreamOf({ lpTransferFeesPendingBurn: 5n, lpTransferFeeBurnLastTs: Number(T0), lpTransferFeeBurnEndTs: T0 + 1n })).toEqual(bs(5n, T0, T0 + 1n));
    expect(lpBurnStreamOf({})).toEqual(bs(0n, 0n, 0n));
    expect(lpBurnStreamOf({ lpTransferFeesPendingBurn: bn(7), lpTransferFeeBurnLastTs: null })).toEqual(bs(7n, 0n, 0n));
    expect(() => lpBurnStreamOf({ lpTransferFeesPendingBurn: -1n })).toThrow(/u64/);
    expect(() => lpBurnStreamOf({ lpTransferFeeBurnEndTs: I64_MAX + 1n })).toThrow(/i64/);
  });
  test("[P14] the step is sweep → drip → settle → split → schedule; the preview and the quote are views of it", () => {
    const t0 = T0;
    const step = collectLpTransferFeeStep({ feeAccountAmount: 250n + 1_800n + 1_000n, owedProtocol: 250n, stream: bs(1_800n, t0 - 21_600n, t0 + 64_800n), now: t0, shareBps: 1_000 });
    expect(step.burnedNow).toBe(450n);
    expect(step.streamSettled).toEqual(bs(1_350n, t0, t0 + 64_800n));
    expect(step.collected).toBe(1_000n); expect(step.split).toEqual({ protocol: 100n, burn: 900n });
    expect(step.owedProtocolAfter).toBe(350n);
    expect(step.streamAfter).toEqual(schedule(step.streamSettled, 900n, t0));
    expect(step.streamAfter).toEqual(bs(2_250n, t0, t0 + 73_440n)); // (1350·64800 + 900·86400) / 2250
    expect(step.feeAccountAmountAfter).toBe(step.owedProtocolAfter + step.streamAfter.pending);
    const preview = previewLpTransferFeeCollection({ feeAccountAmount: 250n + 1_800n, owedProtocol: 250n, pendingBurn: 1_800n, burnLastTs: t0 - 21_600n, burnEndTs: t0 + 64_800n, now: t0, shareBps: 1_000, withheld: 1_000n });
    expect(preview).toEqual({
      collected: 1_000n, protocolPart: 100n, scheduledBurn: 900n, burnedNow: 450n, protocolOwedAfter: 350n, pendingBurnAfter: 2_250n,
      feeAccountAmountAfter: 2_600n, burnLastTsAfter: t0, burnEndTsAfter: t0 + 73_440n,
    });
    const quote = quoteLpTransferFeeBurnStream({ pendingBurn: 1_800n, burnLastTs: t0 - 21_600n, burnEndTs: t0 + 64_800n, now: t0 });
    expect(quote.burnNow).toBe(step.burnedNow); expect(quote.streamAfter).toEqual(step.streamSettled);
    // a no-fee collect is the quote: step with nothing above the buckets
    const idle = collectLpTransferFeeStep({ feeAccountAmount: 250n + 1_800n, owedProtocol: 250n, stream: bs(1_800n, t0 - 21_600n, t0 + 64_800n), now: t0, shareBps: 1_000 });
    expect(idle.collected).toBe(0n); expect(idle.streamAfter).toEqual(quote.streamAfter); expect(idle.burnedNow).toBe(quote.burnNow);
  });
  test("[N02] the step's refusals: the burn exceeds the balance, the buckets exceed the balance, the bucket at u64::MAX, bad share", () => {
    const t0 = T0;
    expect(() => collectLpTransferFeeStep({ feeAccountAmount: 100n, owedProtocol: 0n, stream: bs(900n, t0, t0 + W), now: t0 + W, shareBps: 0 })).toThrow(/LpFeeAccountUnderfunded/);
    expect(() => collectLpTransferFeeStep({ feeAccountAmount: 1_599n, owedProtocol: 700n, stream: bs(900n, t0, t0 + W), now: t0, shareBps: 0 })).toThrow(/LpFeeAccountUnderfunded/);
    // owed + protocol ≤ owed + collected ≤ the u64 balance: the protocol bucket cannot overflow; at the top of the range it simply fills up
    expect(collectLpTransferFeeStep({ feeAccountAmount: U64_MAX, owedProtocol: U64_MAX - 1n, stream: bs(0n, 0n, 0n), now: t0, shareBps: 10_000 })).toMatchObject({ collected: 1n, owedProtocolAfter: U64_MAX, streamAfter: bs(0n, t0, t0) });
    // `lp_fee_account_reserved` = owed + pending past u64::MAX is the program's MathOverflow (6011), checked before the balance
    expect(() => collectLpTransferFeeStep({ feeAccountAmount: U64_MAX, owedProtocol: U64_MAX, stream: bs(1n, t0, t0 + W), now: t0, shareBps: 0 })).toThrow(/MathOverflow/);
    expect(() => collectLpTransferFeeStep({ feeAccountAmount: 10n, owedProtocol: 0n, stream: bs(0n, 0n, 0n), now: t0, shareBps: 10_001 })).toThrow(/6113/);
    expect(() => collectLpTransferFeeStep({ feeAccountAmount: -1n, owedProtocol: 0n, stream: bs(0n, 0n, 0n), now: t0, shareBps: 0 })).toThrow(/u64/);
    // exactly enough for the burn and the buckets: a zero collection
    expect(collectLpTransferFeeStep({ feeAccountAmount: 1_600n, owedProtocol: 700n, stream: bs(900n, t0, t0 + W), now: t0, shareBps: 0 }).collected).toBe(0n);
  });
});
