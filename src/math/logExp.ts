/** Exact integer port of cubic-pool log_exp_math.rs (audit-fixes-excluded-SF). */
import { ONE, assertI128, assertU128, mulDivDown } from "./fixedPoint";
export const MAX_NATURAL_EXPONENT = 46000000000000000000n;
export const MIN_NATURAL_EXPONENT = -41000000000000000000n;
const X = [32000000000000000000n, 16000000000000000000n, 8000000000000000000n, 4000000000000000000n, 2000000000000000000n, 1000000000000000000n, 500000000000000000n, 250000000000000000n, 125000000000000000n, 62500000000000000n];
const A = [78962960182680695161000000000000n, 8886110520507872636760000n, 2980957987041728274740n, 54598150033144239078n, 7389056098930650227n, 2718281828459045235n, 1648721270700128146n, 1284025416687741484n, 1133148453066826316n, 1064494458917859429n];
function lnPositive(a: bigint): bigint {
    let sum = 0n;
    for (let i = 0; i < X.length; i++)
        if (a >= A[i]) {
            a = mulDivDown(a, ONE, A[i]);
            sum += X[i];
        }
    const z = mulDivDown(a - ONE, ONE, assertU128(a + ONE));
    const zSq = assertI128(z * z) / ONE;
    let num = z, seriesSum = z;
    for (let k = 1n; k < 6n; k++) {
        num = assertI128(num * zSq) / ONE;
        seriesSum = assertI128(seriesSum + num / (2n * k + 1n));
    }
    return assertI128(sum + assertI128(seriesSum * 2n));
}
export function lnFp(a: bigint): bigint {
    assertU128(a);
    if (a === 0n)
        throw new Error("logExp.ln: divide by zero");
    return a < ONE ? -lnPositive(mulDivDown(ONE, ONE, a)) : lnPositive(a);
}
export function expFp(x: bigint): bigint {
    assertI128(x);
    if (x < MIN_NATURAL_EXPONENT || x > MAX_NATURAL_EXPONENT)
        throw new Error("logExp.exp: exponent out of range");
    if (x < 0n)
        return mulDivDown(ONE, ONE, expFp(-x));
    let product = ONE;
    for (let i = 0; i < X.length; i++)
        if (x >= X[i]) {
            x -= X[i];
            product = mulDivDown(product, A[i], ONE);
        }
    let sum = assertU128(ONE + x), term = x;
    for (let n = 2n; n <= 12n; n++) {
        term = mulDivDown(term, x, ONE) / n;
        sum = assertU128(sum + term);
    }
    return mulDivDown(product, sum, ONE);
}
export function powFp(base: bigint, exponent: bigint): bigint {
    assertU128(base);
    assertU128(exponent);
    if (exponent === 0n || base === ONE)
        return ONE;
    if (base === 0n)
        return 0n;
    const logarithm = lnFp(base);
    // Rust casts u128 to i128 here. Valid pool weights are far below i128::MAX.
    const y = BigInt.asIntN(128, exponent);
    const whole = assertI128((logarithm / ONE) * y);
    const fraction = assertI128((logarithm % ONE) * y) / ONE;
    return expFp(assertI128(whole + fraction));
}
