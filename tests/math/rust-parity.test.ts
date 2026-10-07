/**
 * Bit-for-bit parity with the contracts `v6` Rust math. The fixture is
 * produced by `tests/math/generate-rust-reference.py` from a v6 checkout:
 * the program's own `cubic_math.rs`, `surge_fee.rs`, `max_selloff.rs`,
 * `log_exp_math.rs`, the STLD `compute_allocations` and the swap handler's
 * fee helpers plus its verbatim surge-charge block, compiled natively.
 */
import fixtures from "./fixtures/deployed-v6-math.json";
import { lnFp, expFp, powFp } from "../../src/math/logExp";
import {
  calcOutGivenIn,
  calcTokensOutGivenBptIn,
  calcJoinRatioAndBpt,
  calcDepositCredit,
  virtualBalanceAfterDeposit,
  virtualBalanceAfterWithdrawal,
  calcEffectiveBptBurn,
} from "../../src/math/cubicMath";
import { computeAllocations } from "../../src/math/singleToken";
import { calcSurgeFeeRate, calcSurgeFeePct, calcSurgeFeeAmount, SurgeCurve } from "../../src/math/surgeFee";
import { checkAndAdvanceSelloff, rebaseSnapshot, rescaleWindowOnVbChange } from "../../src/math/maxSelloff";
import { calculateSwapFee, calculateProtocolFee } from "../../src/math/slippage";
import { calculateInvariant } from "../../src/math/weightedMath";
import { ONE, U128_MAX, mulDown, mulDivDown, MathError } from "../../src/math/fixedPoint";

type Vector = {
  kind: string;
  expected: string | string[];
  [key: string]: unknown;
};
const vectors = fixtures.vectors as Vector[];

function evaluate(v: Vector): bigint | bigint[] {
  const b = (k: string) => BigInt(v[k] as string), n = (k: string) => Number(v[k]);
  const list = (k: string) => (v[k] as string[]).map(BigInt);
  const curve = (): SurgeCurve => ({ thresholdPct: n("threshold"), slopeLowPct: n("low"), slopeMidPct: n("mid"), slopeHighPct: n("high"), kinkPct: n("kink") });
  switch (v.kind) {
    case "ln": return lnFp(b("x"));
    case "exp": return expFp(b("x"));
    case "pow": return powFp(b("base"), b("exponent"));
    case "swap": return calcOutGivenIn({ virtualBalanceIn: 1000000000n, weightInBps: b("weight"), virtualBalanceOut: 1000000000n, weightOutBps: 10000n - b("weight"), amountIn: b("amount"), actualBalanceOut: 1000000000n });
    case "swapEqualWeights": return calcOutGivenIn({ virtualBalanceIn: b("vbIn"), weightInBps: b("weight"), virtualBalanceOut: b("vbOut"), weightOutBps: b("weight"), amountIn: b("amount"), actualBalanceOut: b("actualOut") });
    case "allocation": return computeAllocations({ actualBalances: list("actual"), virtualBalances: [1000000n, 1000000n], weightsBps: [5000, 5000], amountIn: b("amount"), tokenInIndex: 0 }).allocations;
    case "surgeRate": return calcSurgeFeeRate(b("before"), b("after"), b("cap"), curve());
    case "surgePct": return BigInt(calcSurgeFeePct(b("before"), b("after"), b("cap"), curve()));
    case "surgeAmount": {
      // Mirror `swap::handler`: the window advanced by the net input
      // (span = after − before), the curve sees the post-fee input.
      const before = b("before"), after = b("after"), weight = b("weight"), amountInAfterFee = b("amountInAfterFee");
      const swap = { virtualBalanceIn: b("vbIn"), weightInBps: weight, virtualBalanceOut: b("vbOut"), weightOutBps: 10000n - weight, actualBalanceOut: b("vbOut") };
      const span = after - before;
      return calcSurgeFeeAmount({
        before, after, cap: b("cap"), curve: curve(),
        amountOut: calcOutGivenIn({ ...swap, amountIn: amountInAfterFee }),
        cumulativeOut: (u) => calcOutGivenIn({ ...swap, amountIn: (amountInAfterFee * (u - before)) / span }),
      });
    }
    case "selloff": {
      const r = checkAndAdvanceSelloff({ state: { previousSelloff: b("previous"), currentSelloff: b("current"), windowStartTimestamp: b("windowStart"), selloffVbSnapshot: b("snapshot") }, maxSelloffPct: n("pct"), period: n("period"), amountIn: b("amount"), virtualBalance: b("vb"), now: b("now") })!;
      return [r.effectiveSelloffBefore, r.effectiveSelloff, r.maxSelloffCap, r.vbSnapshot, r.previousSelloff, r.currentSelloff, r.windowStartTimestamp];
    }
    case "windowRescale": {
      const s = rescaleWindowOnVbChange({ previousSelloff: b("previous"), currentSelloff: b("current"), windowStartTimestamp: 100n, selloffVbSnapshot: b("snapshot") }, b("oldVb"), b("newVb"));
      return [s.selloffVbSnapshot, s.previousSelloff, s.currentSelloff];
    }
    case "windowRebase": {
      const s = rebaseSnapshot({ previousSelloff: b("previous"), currentSelloff: b("current"), windowStartTimestamp: 100n, selloffVbSnapshot: b("snapshot") }, b("newSnapshot"));
      return [s.selloffVbSnapshot, s.previousSelloff, s.currentSelloff];
    }
    case "depositCredit": return calcDepositCredit(b("actual"), b("ratio"));
    case "vbAfterDeposit": return virtualBalanceAfterDeposit(b("vb"), b("actual"), b("credit"), b("minted"), b("supply"));
    case "vbAfterWithdrawal": return virtualBalanceAfterWithdrawal(b("vb"), b("actual"), b("payout"), b("burned"), b("supply"));
    case "effectiveBurn": return calcEffectiveBptBurn(b("requested"), b("supply"));
    case "swapFee": return calculateSwapFee(b("amount"), n("rate"));
    case "protocolFee": return calculateProtocolFee(b("fee"), n("rate"));
    case "invariant": return calculateInvariant([1000000000n, 2000000000n], [5000, 5000], [n("decimals"), n("decimals")]);
    case "joinRounding": {
      const { bpt, ratio } = calcJoinRatioAndBpt([3n, 3n], [1n, 1n], b("supply"));
      return [ratio, bpt, calcDepositCredit(3n, ratio)];
    }
    case "joinRoundingExit": return calcTokensOutGivenBptIn([3n, 3n], b("acquired"), b("supply"));
    case "joinLegV6": {
      // One v6 join per leg (ratio → bpt floor → credit ceil → V ceil) and
      // the exact exit of the same basket (V floor): the round trip returns V.
      const actual = list("actual"), vb = list("vb"), supply = b("supply");
      const { bpt, ratio } = calcJoinRatioAndBpt(actual, list("amount"), supply);
      const out = [bpt, ratio / ONE, ratio % ONE];
      for (let i = 0; i < 2; i++) {
        const credit = actual[i] > 0n ? calcDepositCredit(actual[i], ratio) : 0n;
        const next = virtualBalanceAfterDeposit(vb[i], actual[i], credit, bpt, supply);
        out.push(credit, next, virtualBalanceAfterWithdrawal(next, actual[i] + credit, actual[i] > 0n ? credit : 0n, bpt, supply + bpt));
      }
      return out;
    }
    default: throw new Error(`Unknown reference kind ${v.kind}`);
  }
}

/** Rust error names the SDK reproduces verbatim; the rest surface as range guards. */
const NAMED_ERRORS = new Set(["MaxSelloffExceeded", "InvalidVirtualBalances", "TokenLivenessMismatch", "InvalidAmounts", "InvalidBptAmount", "PoolNotSeeded", "AmountOutExceedsBalance", "MaxSelloffInvalidConfig"]);

describe(`native Rust arithmetic parity (contracts ${fixtures.contractBranch} ${fixtures.contractCommit.slice(0, 7)})`, () => {
  test("fixture was generated from the v6 branch", () => {
    expect(fixtures.contractBranch).toBe("v6");
    expect(Object.keys(fixtures.sourceHashes)).toContain("programs/cubic-pool/src/instructions/user/swap.rs");
  });

  test.each(vectors.map((v, i) => [`${i} ${v.kind}`, v] as const))("%s", (_name, v) => {
    if (typeof v.expected === "string" && v.expected.startsWith("error:")) {
      const name = v.expected.slice("error:".length);
      // `MaxSelloffInvalidConfig` is a config guard (`assertInteger`), not a MathError.
      if (NAMED_ERRORS.has(name) && name !== "MaxSelloffInvalidConfig") {
        expect(() => evaluate(v)).toThrow(new MathError(name));
      } else {
        expect(() => evaluate(v)).toThrow();
      }
    } else {
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
  test("a failed rescale leaves the input state untouched", () => {
    const state = { previousSelloff: (1n << 64n) - 1n, currentSelloff: 1n, windowStartTimestamp: 3n, selloffVbSnapshot: 1n };
    expect(() => rescaleWindowOnVbChange(state, 1n, 2n)).toThrow(MathError);
    expect(() => rescaleWindowOnVbChange(state, 1n, 0n)).toThrow("InvalidVirtualBalances");
    expect(state).toEqual({ previousSelloff: (1n << 64n) - 1n, currentSelloff: 1n, windowStartTimestamp: 3n, selloffVbSnapshot: 1n });
  });
  test("fixed point checks intermediate overflow while mulDiv accepts wide product", () => {
    expect(() => mulDown(U128_MAX, 2n)).toThrow();
    expect(mulDivDown(U128_MAX, 2n, 2n)).toBe(U128_MAX);
  });
  test("exit preserves Rust two-step rounding", () => {
    expect(calcTokensOutGivenBptIn([1000000000000000000n], 1n, 3n)).toEqual([333333333333333333n]);
  });
});
