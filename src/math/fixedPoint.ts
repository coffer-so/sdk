/** Fixed-point primitives matching coffer-pool's checked u128 operations. */
/**
 * Thrown by every checked-arithmetic guard in `src/math`. The v6 zap
 * planner treats these the way the program treats `checked_*` failures:
 * as "this candidate is infeasible", never as a bug.
 */
export class MathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MathError";
    }
}
export const ONE = 1000000000000000000n;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const I128_MIN = -(1n << 127n);
export const I128_MAX = (1n << 127n) - 1n;
export function assertU64(value: bigint, label = "value"): bigint {
    if (value < 0n || value > U64_MAX)
        throw new MathError(`${label}: outside u64`);
    return value;
}
export function assertU128(value: bigint, label = "value"): bigint {
    if (value < 0n || value > U128_MAX)
        throw new MathError(`${label}: outside u128`);
    return value;
}
export function assertI128(value: bigint, label = "value"): bigint {
    if (value < I128_MIN || value > I128_MAX)
        throw new MathError(`${label}: outside i128`);
    return value;
}
export function assertInteger(value: number, min: number, max: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${label}: invalid integer`);
    return value;
}
/** Rust mul_div_down permits a 256-bit product, but a u128 quotient. */
export function mulDivDown(a: bigint, b: bigint, denominator: bigint): bigint {
    assertU128(a);
    assertU128(b);
    assertU128(denominator);
    if (denominator === 0n)
        throw new MathError("mulDivDown: divide by zero");
    return assertU128(a * b / denominator);
}
export function mulDown(a: bigint, b: bigint): bigint {
    assertU128(a);
    assertU128(b);
    return assertU128(a * b) / ONE;
}
export function mulUp(a: bigint, b: bigint): bigint {
    assertU128(a);
    assertU128(b);
    const product = assertU128(a * b);
    return product === 0n ? 0n : (product - 1n) / ONE + 1n;
}
export function divDown(a: bigint, b: bigint): bigint {
    assertU128(a);
    assertU128(b);
    if (b === 0n)
        throw new MathError("fixedPoint.divDown: divide by zero");
    return assertU128(a * ONE) / b;
}
export function divUp(a: bigint, b: bigint): bigint {
    assertU128(a);
    assertU128(b);
    if (b === 0n)
        throw new MathError("fixedPoint.divUp: divide by zero");
    const numerator = assertU128(a * ONE);
    return numerator === 0n ? 0n : (numerator - 1n) / b + 1n;
}
export function complement(x: bigint): bigint {
    assertU128(x);
    if (x > ONE)
        throw new MathError("fixedPoint.complement: greater than ONE");
    return ONE - x;
}
export function weightToFp(weightBps: bigint | number): bigint {
    const w = typeof weightBps === "number" ? BigInt(assertInteger(weightBps, 0, 10000, "weight")) : assertU64(weightBps);
    return w * ONE / 10000n;
}
/** `ceil(numerator / denominator)` on non-negative bigints, as the contract's `ceil_div` / `+ (rem != 0)` idiom. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
    if (denominator <= 0n)
        throw new MathError("ceilDiv: divide by zero");
    if (numerator < 0n)
        throw new MathError("ceilDiv: negative numerator");
    return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}
