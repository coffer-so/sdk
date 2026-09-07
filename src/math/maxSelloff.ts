/** Sliding sell window, including snapshot rebasing; mirrors max_selloff.rs. */
import { assertInteger, assertU64, assertU128, mulDown } from "./fixedPoint";
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
    if (opened && state.selloffVbSnapshot > 0n && snapshot !== state.selloffVbSnapshot)
        previous = assertU64(assertU128(previous * snapshot) / state.selloffVbSnapshot);
    const cap = assertU64(BigInt(maxSelloffPct) * snapshot / 10000n);
    const before = previous * (p - elapsed) / p + current;
    const effective = before + amountIn;
    if (effective > cap)
        throw new Error("MaxSelloffExceeded");
    return { effectiveSelloffBefore: before, effectiveSelloff: effective, maxSelloffCap: cap, vbSnapshot: snapshot, previousSelloff: previous, currentSelloff: assertU64(current + amountIn), windowStartTimestamp: windowStart };
}
/** Mirror of window rescaling after proportional add/remove liquidity. */
export function rescaleSelloffWindow(state: SelloffState, ratio: bigint, isIncrease: boolean, maxSelloffPct: number): SelloffState {
    assertU128(ratio);
    assertInteger(maxSelloffPct, 0, 10000, "max selloff percent");
    if (ratio === 0n || maxSelloffPct === 0)
        return { ...state };
    const scale = (value: bigint): bigint => { assertU64(value); if (value === 0n)
        return 0n; const delta = mulDown(value, ratio); return isIncrease ? assertU64(value + delta) : value > delta ? value - delta : 0n; };
    return { ...state, previousSelloff: scale(state.previousSelloff), currentSelloff: scale(state.currentSelloff), selloffVbSnapshot: scale(state.selloffVbSnapshot) };
}
