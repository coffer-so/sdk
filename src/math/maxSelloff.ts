/**
 * Sliding-window cumulative-sell rate limiter.
 *
 * Port of contracts `v6` `programs/cubic-pool/src/math/max_selloff.rs`:
 * `check_and_advance` (rotation with the carryover rounded UP),
 * `rebase_snapshot` and `rescale_window_on_vb_change` (the window follows
 * every virtual-balance move of its token, tracked even while disabled).
 * The surge curve lives in `./surgeFee`.
 *
 * All arithmetic is bigint, mirroring the Rust u128 intermediates INCLUDING
 * integer-division order — do not "simplify" a `a*b/c` into a different
 * association, parity with the on-chain result depends on it. BN appears
 * only at the SDK boundary.
 */

import BN from "bn.js";
import { PERCENT_SCALE } from "../config";
import { assertInteger, assertU64, assertU128, ceilDiv, MathError } from "./fixedPoint";

const SCALE = BigInt(PERCENT_SCALE); // 10_000


export interface SelloffWindowInputs {
  maxSelloffPct: number;
  periodLength: number;
  previousSelloff: BN;
  currentSelloff: BN;
  windowStartTimestamp: BN;
  selloffVbSnapshot: BN;
  /** Current pre-trade virtual balance of the token. */
  virtualBalance: BN;
  /** Unix seconds. */
  now: number;
}

export interface SelloffWindowStatus {
  /** True when the limiter is configured (`maxSelloffPct > 0`). */
  enabled: boolean;
  cap: BN;
  /** Effective decayed usage WITHOUT a hypothetical trade. */
  used: BN;
  /** `max(0, cap - used)`. */
  remaining: BN;
  /** `used/cap` in PERCENT_SCALE units (0..10_000+); 0 when disabled/cap=0. */
  fillPct: number;
  windowStartTimestamp: BN;
  periodLength: number;
  /** Whether the projection at `now` rotated the window vs stored state. */
  rotated: boolean;
  /** Snapshot the cap was resolved against (post-projection). */
  vbSnapshot: BN;
}

/** Result of the pure bigint window projection. */
export interface WindowProjection {
  opened: boolean;
  windowStart: bigint;
  elapsedInWindow: bigint;
  /** Carried-over previous usage, POST v5.1 snapshot rescale. */
  previous: bigint;
  current: bigint;
  vbSnapshot: bigint;
  cap: bigint;
  weightedPrev: bigint;
  /** weightedPrev + current (decayed effective, WITHOUT a hypothetical trade). */
  usedWithoutTrade: bigint;
}

/**
 * Pure bigint projection of the sliding window at `now`. Mirrors v5.1
 * `check_and_advance`'s rotation + snapshot logic (read-only, no
 * `amount_in`), including the audit addition: when the projection OPENS a
 * window against a new vb snapshot, the carried-over `previous` usage is
 * rescaled by `newSnapshot / oldSnapshot` so a liquidity change between
 * windows doesn't distort the carried percentage.
 */
export function projectSelloffWindow(params: {
  maxSelloffPct: number;
  periodLength: number;
  previousSelloff: bigint;
  currentSelloff: bigint;
  windowStartTimestamp: bigint;
  selloffVbSnapshot: bigint;
  virtualBalance: bigint;
  now: number;
}): WindowProjection {
  const period = BigInt(params.periodLength);
  const storedWs = params.windowStartTimestamp;
  const nowBI = BigInt(Math.trunc(params.now));

  const rawElapsed = nowBI - storedWs;
  const elapsed = rawElapsed < 0n ? 0n : rawElapsed;

  let prev: bigint;
  let cur: bigint;
  let ws: bigint;
  let eiw: bigint;
  let opened: boolean;

  if (period > 0n && elapsed >= 2n * period) {
    prev = 0n;
    cur = 0n;
    ws = nowBI;
    eiw = 0n;
    opened = true;
  } else if (period > 0n && elapsed >= period) {
    ws = storedWs + period;
    const e = nowBI - ws;
    eiw = e < 0n ? 0n : e;
    prev = params.currentSelloff;
    cur = 0n;
    opened = true;
  } else if (period <= 0n) {
    // Degenerate config (rejected on-chain by `require!(period > 0)`);
    // treat as a fresh reset so callers never divide by zero.
    prev = 0n;
    cur = 0n;
    ws = nowBI;
    eiw = 0n;
    opened = true;
  } else {
    prev = params.previousSelloff;
    cur = params.currentSelloff;
    ws = storedWs;
    eiw = elapsed;
    opened = false;
  }

  const oldSnapshot = params.selloffVbSnapshot;
  const vbSnapshot =
    opened || oldSnapshot === 0n ? params.virtualBalance : oldSnapshot;

  // Rescale the carried previous when the window opened against a
  // DIFFERENT snapshot (mirrors max_selloff.rs; v6 rounds the carryover UP).
  if (opened && oldSnapshot > 0n && vbSnapshot !== oldSnapshot) {
    prev = ceilDiv(prev * vbSnapshot, oldSnapshot);
  }

  const cap = (BigInt(params.maxSelloffPct) * vbSnapshot) / SCALE;
  const weightedPrev = period > 0n ? (prev * (period - eiw)) / period : 0n;
  const usedWithoutTrade = weightedPrev + cur;

  return {
    opened,
    windowStart: ws,
    elapsedInWindow: eiw,
    previous: prev,
    current: cur,
    vbSnapshot,
    cap,
    weightedPrev,
    usedWithoutTrade,
  };
}

/** Read-only status of a token's max-selloff window at `now`. */
export function computeSelloffWindow(inputs: SelloffWindowInputs): SelloffWindowStatus {
  const enabled = inputs.maxSelloffPct > 0;
  if (!enabled) {
    return {
      enabled: false,
      cap: new BN(0),
      used: new BN(0),
      remaining: new BN(0),
      fillPct: 0,
      windowStartTimestamp: inputs.windowStartTimestamp,
      periodLength: inputs.periodLength,
      rotated: false,
      vbSnapshot: new BN(0),
    };
  }

  const proj = projectSelloffWindow({
    maxSelloffPct: inputs.maxSelloffPct,
    periodLength: inputs.periodLength,
    previousSelloff: BigInt(inputs.previousSelloff.toString()),
    currentSelloff: BigInt(inputs.currentSelloff.toString()),
    windowStartTimestamp: BigInt(inputs.windowStartTimestamp.toString()),
    selloffVbSnapshot: BigInt(inputs.selloffVbSnapshot.toString()),
    virtualBalance: BigInt(inputs.virtualBalance.toString()),
    now: inputs.now,
  });

  const used = proj.usedWithoutTrade;
  const remaining = proj.cap > used ? proj.cap - used : 0n;
  const fillPct = proj.cap === 0n ? 0 : Number((used * SCALE) / proj.cap);

  return {
    enabled: true,
    cap: new BN(proj.cap.toString()),
    used: new BN(used.toString()),
    remaining: new BN(remaining.toString()),
    fillPct,
    windowStartTimestamp: new BN(proj.windowStart.toString()),
    periodLength: inputs.periodLength,
    rotated: proj.opened,
    vbSnapshot: new BN(proj.vbSnapshot.toString()),
  };
}

// ── Contract-exact window state machine (max_selloff.rs mirror) ────────
// Companion API used by the quote engine (`quote-math.ts`): advances the
// rotating window like the deployed program (throws MaxSelloffExceeded)
// and rescales it after proportional liquidity changes. The projection
// API above serves display/UX; this one drives simulation.
export interface SelloffState {
    previousSelloff: bigint;
    currentSelloff: bigint;
    windowStartTimestamp: bigint;
    selloffVbSnapshot: bigint;
}
export interface SelloffResult {
    effectiveSelloffBefore: bigint;
    effectiveSelloff: bigint;
    maxSelloffCap: bigint;
    vbSnapshot: bigint;
    previousSelloff: bigint;
    currentSelloff: bigint;
    windowStartTimestamp: bigint;
}
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;
function i64(v: bigint): bigint { if (v < I64_MIN || v > I64_MAX)
    throw new Error("timestamp: outside i64"); return v; }
function saturatingSubI64(a: bigint, b: bigint): bigint { const v = a - b; return v < I64_MIN ? I64_MIN : v > I64_MAX ? I64_MAX : v; }
/** Pure: does not modify its input, including on rejection. */
export function checkAndAdvanceSelloff(params: {
    state: SelloffState;
    maxSelloffPct: number;
    period: number;
    amountIn: bigint;
    virtualBalance: bigint;
    now: bigint;
}): SelloffResult | null {
    const { state, maxSelloffPct, period, amountIn, virtualBalance, now } = params;
    assertInteger(maxSelloffPct, 0, 10000, "max selloff percent");
    if (maxSelloffPct === 0)
        return null;
    assertInteger(period, 1, 0xffffffff, "selloff period");
    assertU64(amountIn);
    assertU64(virtualBalance);
    assertU64(state.previousSelloff);
    assertU64(state.currentSelloff);
    assertU64(state.selloffVbSnapshot);
    i64(now);
    i64(state.windowStartTimestamp);
    const p = BigInt(period), rawElapsed = saturatingSubI64(now, state.windowStartTimestamp);
    let elapsed = rawElapsed < 0n ? 0n : rawElapsed;
    let previous = state.previousSelloff, current = state.currentSelloff, windowStart = state.windowStartTimestamp, opened = false;
    if (elapsed >= 2n * p) {
        previous = 0n;
        current = 0n;
        windowStart = now;
        elapsed = 0n;
        opened = true;
    }
    else if (elapsed >= p) {
        previous = current;
        current = 0n;
        windowStart = i64(windowStart + p);
        elapsed = saturatingSubI64(now, windowStart);
        if (elapsed < 0n)
            elapsed = 0n;
        opened = true;
    }
    const snapshot = opened || state.selloffVbSnapshot === 0n ? virtualBalance : state.selloffVbSnapshot;
    // v6: the carryover moves into the new scale rounded UP (a raw unit of
    // pressure is never erased by the rotation).
    if (opened && state.selloffVbSnapshot > 0n && snapshot !== state.selloffVbSnapshot)
        previous = assertU64(ceilDiv(assertU128(previous * snapshot), state.selloffVbSnapshot));
    const cap = assertU64(BigInt(maxSelloffPct) * snapshot / 10000n);
    const before = previous * (p - elapsed) / p + current;
    const effective = before + amountIn;
    if (effective > cap)
        throw new MathError("MaxSelloffExceeded");
    return { effectiveSelloffBefore: before, effectiveSelloff: effective, maxSelloffCap: cap, vbSnapshot: snapshot, previousSelloff: previous, currentSelloff: assertU64(current + amountIn), windowStartTimestamp: windowStart };
}
/**
 * `rebase_snapshot`: rebase an already-open window to `newSnapshot` without
 * forgiving pressure — both buckets scale by `new / old` rounded UP. A
 * window whose snapshot is still 0 (never opened) is left untouched, and so
 * is a snapshot that does not change. Pure: returns a new state.
 */
export function rebaseSnapshot(state: SelloffState, newSnapshot: bigint): SelloffState {
    assertU64(newSnapshot);
    const old = state.selloffVbSnapshot;
    if (old === 0n || old === newSnapshot)
        return { ...state };
    const scale = (value: bigint): bigint => assertU64(ceilDiv(assertU128(value * newSnapshot), old), "selloff bucket");
    return { ...state, selloffVbSnapshot: newSnapshot, previousSelloff: scale(state.previousSelloff), currentSelloff: scale(state.currentSelloff) };
}
/**
 * `rescale_window_on_vb_change`: keep one token's window in step with a
 * liquidity, range-manager or buy-side move of its virtual balance from
 * `oldVb` to `newVb` (the snapshot follows `floor(snapshot · new / old)`,
 * never below one raw unit). Tracked even while the cap is disabled, so a
 * disable/enable cycle cannot restore a stale basis. SELL-side growth of
 * the input leg must NOT call this. No-op when nothing moved or the window
 * never opened; otherwise both balances must be positive.
 */
export function rescaleWindowOnVbChange(state: SelloffState, oldVb: bigint, newVb: bigint): SelloffState {
    assertU64(oldVb);
    assertU64(newVb);
    if (oldVb === newVb || state.selloffVbSnapshot === 0n)
        return { ...state };
    if (oldVb === 0n || newVb === 0n)
        throw new MathError("InvalidVirtualBalances");
    const snapshot = assertU128(state.selloffVbSnapshot * newVb) / oldVb;
    return rebaseSnapshot(state, assertU64(snapshot > 1n ? snapshot : 1n, "selloff snapshot"));
}
