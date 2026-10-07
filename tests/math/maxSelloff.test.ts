/**
 * v6 max-selloff window: the read-only projection used by the UI and the
 * contract-exact state machine used by the quote engine. Window vectors
 * mirror `max_selloff.rs` unit tests and `tests/v6_windows.rs`; exact
 * expected numbers are hand-derived from the contract formulas — if a port
 * drifts from the integer math (division order, CEILs), these fail.
 */
import BN from "bn.js";
import {
  checkAndAdvanceSelloff,
  computeSelloffWindow,
  projectSelloffWindow,
  rebaseSnapshot,
  rescaleWindowOnVbChange,
  SelloffState,
} from "../../src/math/maxSelloff";
import { MathError } from "../../src/math/fixedPoint";

const U64_MAX = (1n << 64n) - 1n;

describe("projectSelloffWindow (check_and_advance mirror, read-only)", () => {
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

  test("carried previous is rescaled to the fresh vb snapshot on open", () => {
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

  test("v6: the carryover rounds UP, a raw unit of pressure is never erased", () => {
    const p = projectSelloffWindow({
      ...base,
      currentSelloff: 1n,
      selloffVbSnapshot: 3n,
      virtualBalance: 1n,
      now: 1_100,
    });
    expect(p.previous).toBe(1n); // ceil(1 · 1 / 3), v5 floored this to 0
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

describe("checkAndAdvanceSelloff (max_selloff.rs unit vectors)", () => {
  const VB = 10_000n;
  const FULL = 10_000;
  const fresh = (windowStart: bigint): SelloffState => ({ previousSelloff: 0n, currentSelloff: 0n, windowStartTimestamp: windowStart, selloffVbSnapshot: 0n });
  const advance = (state: SelloffState, pct: number, period: number, amountIn: bigint, vb: bigint, now: bigint) => {
    const r = checkAndAdvanceSelloff({ state, maxSelloffPct: pct, period, amountIn, virtualBalance: vb, now })!;
    return { r, state: { previousSelloff: r.previousSelloff, currentSelloff: r.currentSelloff, windowStartTimestamp: r.windowStartTimestamp, selloffVbSnapshot: r.vbSnapshot } };
  };

  test("disabled_returns_none", () => {
    expect(checkAndAdvanceSelloff({ state: fresh(0n), maxSelloffPct: 0, period: 0, amountIn: 1_000n, virtualBalance: VB, now: 0n })).toBeNull();
  });

  test("within_first_window_accumulates", () => {
    const { r } = advance(fresh(0n), FULL, 60, 300n, VB, 10n);
    expect([r.effectiveSelloff, r.maxSelloffCap, r.vbSnapshot, r.currentSelloff, r.previousSelloff]).toEqual([300n, VB, VB, 300n, 0n]);
  });

  test("cap_is_percent_of_snapshot and cap_floors_down", () => {
    const { r, state } = advance(fresh(0n), 1_000, 60, 1_000n, VB, 0n);
    expect(r.maxSelloffCap).toBe(1_000n);
    expect(() => advance(state, 1_000, 60, 1n, VB, 1n)).toThrow("MaxSelloffExceeded");
    expect(() => advance(fresh(0n), 1, 60, 1n, 9_999n, 0n)).toThrow("MaxSelloffExceeded");
  });

  test("snapshot_not_inflated_by_growing_vb_within_window", () => {
    const a = advance(fresh(0n), 1_000, 600, 600n, VB, 0n);
    const b = advance(a.state, 1_000, 600, 400n, 1_000_000n, 100n);
    expect(b.r.maxSelloffCap).toBe(1_000n);
    expect(b.r.vbSnapshot).toBe(VB);
    expect(() => advance(b.state, 1_000, 600, 1n, 1_000_000n, 200n)).toThrow("MaxSelloffExceeded");
  });

  test("single_boundary_rotation", () => {
    const a = advance(fresh(0n), FULL, 60, 500n, VB, 0n);
    const { r, state } = advance(a.state, FULL, 60, 100n, VB, 70n);
    expect([state.previousSelloff, state.currentSelloff, state.windowStartTimestamp]).toEqual([500n, 100n, 60n]);
    // weighted_prev = 500 * (60 - 10) / 60 = 416, effective = 416 + 100
    expect(r.effectiveSelloff).toBe(516n);
  });

  test("double_boundary_clears", () => {
    const a = advance(fresh(0n), FULL, 60, 500n, VB, 0n);
    const { r, state } = advance({ ...a.state, previousSelloff: 700n }, FULL, 60, 100n, VB, 200n);
    expect([state.previousSelloff, state.currentSelloff, state.windowStartTimestamp, r.effectiveSelloff]).toEqual([0n, 100n, 200n, 100n]);
  });

  test("clock_skew_clamps_to_zero", () => {
    const { r, state } = advance(fresh(100n), FULL, 60, 50n, VB, 80n);
    expect([state.windowStartTimestamp, state.currentSelloff, r.effectiveSelloff]).toEqual([100n, 50n, 50n]);
  });

  test("l11: rotation rounds the carryover UP and does not erase a raw unit", () => {
    // tests/v6_windows.rs::l11_rotation_rounds_carryover_up_and_does_not_erase_a_raw_unit
    const d: SelloffState = { previousSelloff: 0n, currentSelloff: 1n, windowStartTimestamp: 100n, selloffVbSnapshot: 3n };
    const a = advance(d, FULL, 60, 0n, 1n, 160n);
    expect([a.r.vbSnapshot, a.r.previousSelloff, a.r.effectiveSelloff]).toEqual([1n, 1n, 1n]);
    const b = advance(a.state, FULL, 60, 1n, 1n, 280n);
    expect([b.r.previousSelloff, b.r.effectiveSelloff]).toEqual([0n, 1n]);
  });

  test("rejects beyond cap and is pure on rejection", () => {
    const state = fresh(0n);
    const a = advance(state, FULL, 60, VB, VB, 0n);
    expect(() => advance(a.state, FULL, 60, 1n, VB, 1n)).toThrow(MathError);
    expect(a.state.currentSelloff).toBe(VB);
  });

  test("config guards: period 0 and pct above scale", () => {
    expect(() => advance(fresh(0n), FULL, 0, 10n, VB, 0n)).toThrow();
    expect(() => advance(fresh(0n), 10_001, 60, 1n, VB, 0n)).toThrow();
  });
});

describe("rescaleWindowOnVbChange / rebaseSnapshot (tests/v6_windows.rs)", () => {
  const state = (snapshot: bigint, previous: bigint, current: bigint): SelloffState => ({ previousSelloff: previous, currentSelloff: current, windowStartTimestamp: 100n, selloffVbSnapshot: snapshot });
  const triple = (s: SelloffState) => [s.selloffVbSnapshot, s.previousSelloff, s.currentSelloff];

  test("l14: a buy-side shrink does not keep a loose snapshot", () => {
    const d = rescaleWindowOnVbChange(state(800_000n, 50_000n, 150_000n), 1_000_000n, 250_000n);
    expect(triple(d)).toEqual([200_000n, 12_500n, 37_500n]);
    expect(() => checkAndAdvanceSelloff({ state: d, maxSelloffPct: 5_000, period: 1_000, amountIn: 50_001n, virtualBalance: 250_000n, now: 100n })).toThrow("MaxSelloffExceeded");
  });

  test("l15: a disabled window still tracks every change; re-enabling grants no reset", () => {
    const d = rescaleWindowOnVbChange(state(950_000n, 47_500n, 95_000n), 950_000n, 475_000n);
    expect(triple(d)).toEqual([475_000n, 23_750n, 47_500n]);
    expect(d.windowStartTimestamp).toBe(100n);
    expect(() => checkAndAdvanceSelloff({ state: d, maxSelloffPct: 1_500, period: 1_000, amountIn: 1n, virtualBalance: 475_000n, now: 100n })).toThrow("MaxSelloffExceeded");
  });

  test("h04: tiny rebases cannot zero the snapshot or forgive pressure", () => {
    let d = state(1n, 1n, 1n);
    for (let i = 0; i < 100; i++) {
      d = rescaleWindowOnVbChange(d, 1_000n, 1n);
      expect(d.selloffVbSnapshot).toBe(1n);
      expect(d.previousSelloff >= 1n && d.currentSelloff >= 1n).toBe(true);
      d = rescaleWindowOnVbChange(d, 1n, 1_000n);
    }
    expect(() => checkAndAdvanceSelloff({ state: d, maxSelloffPct: 10_000, period: 1_000, amountIn: 1n, virtualBalance: 1_000n, now: 100n })).toThrow("MaxSelloffExceeded");
  });

  test("h04: an uninitialised window stays uninitialised; a bad rescale is atomic", () => {
    expect(triple(rescaleWindowOnVbChange(state(0n, 0n, 0n), 1n, U64_MAX))).toEqual([0n, 0n, 0n]);
    const d = state(1n, U64_MAX, 1n);
    expect(() => rescaleWindowOnVbChange(d, 1n, 2n)).toThrow(MathError);
    expect(() => rescaleWindowOnVbChange(d, 1n, 0n)).toThrow("InvalidVirtualBalances");
    expect(() => rescaleWindowOnVbChange(d, 0n, 1n)).toThrow("InvalidVirtualBalances");
    expect(triple(d)).toEqual([1n, U64_MAX, 1n]);
  });

  test("no-ops: unchanged vb, unchanged snapshot", () => {
    const d = state(5n, 2n, 3n);
    expect(rescaleWindowOnVbChange(d, 7n, 7n)).toEqual(d);
    expect(rebaseSnapshot(d, 5n)).toEqual(d);
    expect(rebaseSnapshot(state(0n, 5n, 5n), 7n)).toEqual(state(0n, 5n, 5n));
  });

  test("rebase scales both buckets UP by new / old", () => {
    expect(triple(rebaseSnapshot(state(10_000n, 300n, 500n), 15_000n))).toEqual([15_000n, 450n, 750n]);
    expect(triple(rebaseSnapshot(state(3n, 1n, 2n), 2n))).toEqual([2n, 1n, 2n]); // ceil(2/3), ceil(4/3)
    expect(() => rebaseSnapshot(state(1n, U64_MAX, 0n), 2n)).toThrow(MathError);
  });

  test("h04 property: rebase preserves both bucket fractions (never forgives)", () => {
    let seed = 0x9e3779b97f4a7c15n;
    const next = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & U64_MAX; return seed; };
    for (let i = 0; i < 2_000; i++) {
      const oldVb = 1n + (next() % 1_000_000_000_000n);
      const newVb = 1n + (next() % 1_000_000_000_000n);
      const snapshot = 1n + (next() % oldVb);
      const previous = next() % (snapshot + 1n);
      const current = next() % (snapshot + 1n);
      const d = rescaleWindowOnVbChange(state(snapshot, previous, current), oldVb, newVb);
      expect(d.selloffVbSnapshot > 0n).toBe(true);
      expect(d.previousSelloff * snapshot >= previous * d.selloffVbSnapshot).toBe(true);
      expect(d.currentSelloff * snapshot >= current * d.selloffVbSnapshot).toBe(true);
      expect(d.windowStartTimestamp).toBe(100n);
    }
  });
});
