/** Piecewise-linear surge rate and four-segment output fee from swap.rs. */
import { ONE, assertInteger, assertU64 } from "./fixedPoint";
import { calcOutGivenIn } from "./cubicMath";
import { SelloffResult } from "./maxSelloff";
const SCALE = 10000n;
export interface SurgeCurve {
    thresholdPct: number;
    slopeLowPct: number;
    slopeMidPct: number;
    slopeHighPct: number;
    kinkPct: number;
}
function validateCurve(c: SurgeCurve): void {
    assertInteger(c.thresholdPct, 0, 65535, "surge threshold");
    assertInteger(c.slopeLowPct, 0, 65535, "surge low");
    assertInteger(c.slopeMidPct, 0, 65535, "surge mid");
    assertInteger(c.slopeHighPct, 0, 65535, "surge high");
    assertInteger(c.kinkPct, 0, 255, "surge kink");
}
const sub = (a: bigint, b: bigint): bigint => a > b ? a - b : 0n;
const min = (a: bigint, b: bigint): bigint => a < b ? a : b;
const ceil = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n);
function kinkT(c: SurgeCurve): bigint { const thr = BigInt(c.thresholdPct), fill = BigInt(c.kinkPct) * 100n; return c.kinkPct === 0 || thr >= SCALE || fill <= thr || fill >= SCALE ? 0n : (fill - thr) * ONE / (SCALE - thr); }
function rateAt(t: bigint, c: SurgeCurve, k: bigint): bigint {
    t = min(t, ONE);
    const low = BigInt(c.slopeLowPct), mid = BigInt(c.slopeMidPct), high = BigInt(c.slopeHighPct);
    if (k === 0n)
        return min(low + ceil(sub(high, low) * t, ONE), SCALE);
    if (t <= k)
        return min(low + ceil(sub(mid, low) * t, k), SCALE);
    return min(mid + ceil(sub(high, mid) * (t - k), ONE - k), SCALE);
}
function integralTo(t: bigint, c: SurgeCurve, k: bigint): bigint {
    t = min(t, ONE);
    const low = BigInt(c.slopeLowPct), mid = BigInt(c.slopeMidPct), high = BigInt(c.slopeHighPct);
    // Keep Rust's division before multiplication; algebraic reordering changes rounding.
    const ramp = (x: bigint, span: bigint, den: bigint): bigint => den === 0n || span === 0n || x === 0n ? 0n : span * (x * x / (2n * den));
    if (k === 0n)
        return low * t + ramp(t, sub(high, low), ONE);
    if (t <= k)
        return low * t + ramp(t, sub(mid, low), k);
    const rest = t - k;
    return k * (low + mid) / 2n + mid * rest + ramp(rest, sub(high, mid), ONE - k);
}
export function calcSurgeFeePct(params: SurgeCurve & {
    before: bigint;
    after: bigint;
    cap: bigint;
}): bigint {
    validateCurve(params);
    const { before, after, cap } = params;
    assertU64(before);
    assertU64(after);
    assertU64(cap);
    const thr = BigInt(params.thresholdPct);
    if (cap === 0n || params.slopeHighPct === 0 || thr >= SCALE)
        return 0n;
    const k = kinkT(params), f0 = min(before * SCALE / cap, SCALE), f1 = min(after * SCALE / cap, SCALE);
    if (f1 <= thr)
        return 0n;
    const den = SCALE - thr, t1 = (f1 - thr) * ONE / den;
    if (f1 <= f0)
        return rateAt(t1, params, k);
    const f0Clamped = f0 > thr ? f0 : thr, t0 = (f0Clamped - thr) * ONE / den;
    const integral = sub(integralTo(t1, params, k), integralTo(t0, params, k));
    return min(ceil(den * integral, (f1 - f0Clamped) * ONE), SCALE);
}
export function calcSurgeFeeAmount(params: SurgeCurve & {
    window: SelloffResult | null;
    amountInAfterFee: bigint;
    amountOut: bigint;
    virtualBalanceIn: bigint;
    weightInBps: bigint;
    virtualBalanceOut: bigint;
    weightOutBps: bigint;
    actualBalanceOut: bigint;
}): bigint {
    const { window, amountInAfterFee, amountOut } = params;
    assertU64(amountInAfterFee);
    assertU64(amountOut);
    if (!window)
        return 0n;
    const before = window.effectiveSelloffBefore, after = window.effectiveSelloff, cap = window.maxSelloffCap;
    if (calcSurgeFeePct({ ...params, before, after, cap }) === 0n)
        return 0n;
    const thrUnits = cap * BigInt(params.thresholdPct) / SCALE;
    const span = sub(after, before), taxedLo = before > thrUnits ? before : thrUnits;
    if (span === 0n || after <= taxedLo)
        return 0n;
    const cumulative = (u: bigint): bigint => u <= before ? 0n : u >= after ? amountOut : calcOutGivenIn({ ...params, amountIn: amountInAfterFee * (u - before) / span });
    const width = after - taxedLo;
    let fee = 0n, prevU = taxedLo, prevY = cumulative(taxedLo);
    for (let k = 1n; k <= 4n; k++) {
        const u = k === 4n ? after : taxedLo + width * k / 4n, y = cumulative(u), segmentOut = sub(y, prevY);
        if (segmentOut > 0n && u > prevU)
            fee += ceil(segmentOut * calcSurgeFeePct({ ...params, before: prevU, after: u, cap }), SCALE);
        prevU = u;
        prevY = y;
    }
    return min(fee, amountOut);
}
