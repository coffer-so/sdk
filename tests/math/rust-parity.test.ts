import fixtures from "./fixtures/deployed-v5-math.json";
import { lnFp, expFp, powFp } from "../../src/math/logExp";
import { calcOutGivenIn, calcTokensOutGivenBptIn, calcBptOutGivenExactTokensIn } from "../../src/math/cubicMath";
import { computeAllocations } from "../../src/math/singleToken";
import { calcSurgeFeePct, calcSurgeFeeAmount } from "../../src/math/surgeFee";
import { checkAndAdvanceSelloff, rescaleSelloffWindow } from "../../src/math/maxSelloff";
import { calculateInvariant } from "../../src/math/weightedMath";
import { ONE, U128_MAX, mulDown, mulDivDown, divDown } from "../../src/math/fixedPoint";
type Vector = {
    kind: string;
    expected: string | string[];
    [key: string]: unknown;
};
const vectors = fixtures.vectors as Vector[];
function evaluate(v: Vector): bigint | bigint[] {
    const b = (k: string) => BigInt(v[k] as string), n = (k: string) => Number(v[k]);
    switch (v.kind) {
        case "ln": return lnFp(b("x"));
        case "exp": return expFp(b("x"));
        case "pow": return powFp(b("base"), b("exponent"));
        case "swap": return calcOutGivenIn({ virtualBalanceIn: 1000000000n, weightInBps: b("weight"), virtualBalanceOut: 1000000000n, weightOutBps: 10000n - b("weight"), amountIn: b("amount"), actualBalanceOut: 1000000000n });
        case "allocation": return computeAllocations({ actualBalances: (v.actual as string[]).map(BigInt), virtualBalances: [1000000n, 1000000n], weightsBps: [5000, 5000], amountIn: b("amount"), tokenInIndex: 0 }).allocations;
        case "surgePct": return calcSurgeFeePct({ before: b("before"), after: b("after"), cap: b("cap"), thresholdPct: n("threshold"), slopeLowPct: n("low"), slopeMidPct: n("mid"), slopeHighPct: n("high"), kinkPct: n("kink") });
        case "surgeAmount": {
            const before = b("before"), weight = b("weight"), amount = 1000000000n - before;
            const swap = { virtualBalanceIn: 1000000000n, weightInBps: weight, virtualBalanceOut: 1000000000n, weightOutBps: 10000n - weight, actualBalanceOut: 1000000000n };
            return calcSurgeFeeAmount({ ...swap, window: { effectiveSelloffBefore: before, effectiveSelloff: 1000000000n, maxSelloffCap: 1000000000n, vbSnapshot: 1000000000n, previousSelloff: 0n, currentSelloff: 1000000000n, windowStartTimestamp: 0n }, thresholdPct: 8000, slopeLowPct: 10, slopeMidPct: 1000, slopeHighPct: 8000, kinkPct: 90, amountInAfterFee: amount, amountOut: calcOutGivenIn({ ...swap, amountIn: amount }) });
        }
        case "selloff": {
            const r = checkAndAdvanceSelloff({ state: { previousSelloff: 300n, currentSelloff: 500n, windowStartTimestamp: 0n, selloffVbSnapshot: 10000n }, maxSelloffPct: 10000, period: 60, amountIn: 100n, virtualBalance: 20000n, now: b("now") })!;
            return [r.effectiveSelloffBefore, r.effectiveSelloff, r.maxSelloffCap, r.vbSnapshot, r.previousSelloff, r.currentSelloff, r.windowStartTimestamp];
        }
        case "invariant": return calculateInvariant([1000000000n, 2000000000n], [5000, 5000], [n("decimals"), n("decimals")]);
        case "joinRounding": {
            const ratio = divDown(1n, 3n);
            return [ratio, calcBptOutGivenExactTokensIn([3n, 3n], [1n, 1n], b("supply")), mulDown(3n, ratio)];
        }
        case "joinRoundingExit": return calcTokensOutGivenBptIn([3n, 3n], b("acquired"), b("supply"));
        default: throw new Error(`Unknown reference kind ${v.kind}`);
    }
}
describe("native Rust arithmetic parity (contract 96a2ee2)", () => {
    test.each(vectors.map((v, i) => [`${i} ${v.kind}`, v] as const))("%s", (_name, v) => {
        if (typeof v.expected === "string" && v.expected.startsWith("error:"))
            expect(() => evaluate(v)).toThrow();
        else {
            const actual = evaluate(v);
            expect(Array.isArray(actual) ? actual.map(String) : String(actual)).toEqual(v.expected);
        }
    });
});
describe("selloff boundaries and checked arithmetic", () => {
    test("rejects beyond cap without mutating state", () => {
        const state = { previousSelloff: 0n, currentSelloff: 1000n, windowStartTimestamp: 0n, selloffVbSnapshot: 10000n };
        expect(() => checkAndAdvanceSelloff({ state, maxSelloffPct: 1000, period: 60, amountIn: 1n, virtualBalance: 10000n, now: 1n })).toThrow("MaxSelloffExceeded");
        expect(state.currentSelloff).toBe(1000n);
    });
    test("liquidity change scales both buckets and snapshot", () => {
        const state = { previousSelloff: 200n, currentSelloff: 400n, windowStartTimestamp: 3n, selloffVbSnapshot: 10000n };
        expect(rescaleSelloffWindow(state, ONE / 2n, true, 1000)).toEqual({ ...state, previousSelloff: 300n, currentSelloff: 600n, selloffVbSnapshot: 15000n });
        expect(rescaleSelloffWindow(state, ONE / 2n, false, 1000)).toEqual({ ...state, previousSelloff: 100n, currentSelloff: 200n, selloffVbSnapshot: 5000n });
        expect(rescaleSelloffWindow(state, ONE, false, 0)).toEqual(state);
    });
    test("fixed point checks intermediate overflow while mulDiv accepts wide product", () => {
        expect(() => mulDown(U128_MAX, 2n)).toThrow();
        expect(mulDivDown(U128_MAX, 2n, 2n)).toBe(U128_MAX);
    });
    test("exit preserves Rust two-step rounding", () => {
        expect(calcTokensOutGivenBptIn([1000000000000000000n], 1n, 3n)).toEqual([333333333333333333n]);
    });
});
