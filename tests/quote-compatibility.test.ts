import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CofferPoolClient, getConfig, MintExtension } from "../src";
import { PoolInfo } from "../src/types/pool";
import { SdkResult } from "../src/types/result";
import rust from "./math/fixtures/deployed-v6-math.json";

const bn = (value: number | string | bigint) => new BN(value.toString());
const U64_MAX = (1n << 64n) - 1n;
const key = (value: number) => new PublicKey(new Uint8Array(32).fill(value));
const creator = key(90);

function pool(count = 2): PoolInfo {
  return {
    address: key(1), config: key(2), bump: 255, poolId: bn(1), tokenCount: count,
    tokens: Array.from({ length: count }, (_, index) => ({
      index, mint: key(index + 3), vault: key(index + 30), tokenProgram: TOKEN_PROGRAM_ID,
      decimals: 9, weightBps: count === 2 ? 5000 : [5000, 3000, 2000][index],
      // v6.1 (T22): strictly levered (`V > A`) — the program refuses every swap / join otherwise.
      actualBalance: bn(1_000_000_000), virtualBalance: bn(2_000_000_000),
      protocolFeesOwed: bn(0), concentration: 1, isActive: true,
      maxSelloffPct: 0, maxSelloffPeriodLength: 0, variableFeeThresholdPct: 0,
      variableFeeSlopeLowPct: 0, variableFeeSlopeMidPct: 0, variableFeeSlopeHighPct: 0,
      variableFeeKinkPct: 0, previousSelloff: bn(0), currentSelloff: bn(0),
      windowStartTimestamp: bn(0), selloffVbSnapshot: bn(0), extensions: [], unsupportedExtensions: [],
    })),
    lpMint: key(20), lpTokenProgram: TOKEN_PROGRAM_ID, lpTotalSupply: bn(1_000_000_000),
    poolAdmin: creator, pendingPoolAdmin: PublicKey.default, rangeManager: PublicKey.default,
    rangeManagerEnabled: false, rangeManagerMaxVbChangePct: 0, rangeManagerMaxWeightChangePct: 0,
    rangeManagerMinUpdateIntervalSecs: 0, rangeManagerLastUpdated: bn(0),
    rangeManagerMinLeverageBps: 0, rangeManagerMaxLeverageBps: 0,
    swapFeeRate: 0, protocolFeeRate: 0, poolEnabled: true, swapsEnabled: true,
    createdAt: 0, chainTimestamp: 10030, lookupTable: PublicKey.default,
    unsupportedTokenIndices: [], syncedAt: 10030_000,
  };
}

function client(state: PoolInfo): CofferPoolClient {
  const c = new CofferPoolClient({ config: getConfig("devnet"), poolAddress: state.address });
  (c as unknown as { cache: PoolInfo }).cache = state;
  return c;
}

function result<T>(r: SdkResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.humanMessage}`);
  return r.data;
}

describe("client swap quotes against deployed Rust behavior", () => {
  const vectors = rust.vectors.filter(v => v.kind === "swap" && ["1000", "100000000"].includes(String((v as { amount?: string }).amount)));
  test.each(vectors.map((v, i) => [i, v] as const))("native Rust curve vector %i", (_i, vector) => {
    const v = vector as { amount: string; weight: number; expected: string };
    const state = pool(); state.tokens[0].weightBps = v.weight; state.tokens[1].weightBps = 10000 - v.weight;
    // The vectors price on V = 1e9; the curve never reads A, so any A < V reproduces them (T22).
    state.tokens.forEach((t) => { t.virtualBalance = bn(1_000_000_000); t.actualBalance = bn(999_999_999); });
    const q = result(client(state).quoteSwap(0, 1, bn(v.amount), 0));
    expect(q.amountOut.toString()).toBe(v.expected);
  });

  test("rounds base fee and protocol share upward (Rust H-01 regression)", () => {
    const state = pool(); state.swapFeeRate = 1000; state.protocolFeeRate = 2000;
    const q = result(client(state).quoteSwap(0, 1, bn(3998), 0));
    expect(q.feeAmount.toString()).toBe("4");
    expect(q.protocolFeeAmount.toString()).toBe("1");
    expect(q.surgeFeeAmount?.toString()).toBe("0");
  });

  test("actual output reserve already excludes protocol fees", () => {
    const state = pool();
    state.tokens[0].virtualBalance = bn(1_000_000); state.tokens[0].actualBalance = bn(500_000);
    state.tokens[1].virtualBalance = bn(1_000_000);
    state.tokens[1].actualBalance = bn(1000);
    const c = client(state);
    const withoutFees = result(c.quoteSwap(0, 1, bn(500), 0));
    state.tokens[1].protocolFeesOwed = bn(990);
    const withFees = result(c.quoteSwap(0, 1, bn(500), 0));
    expect(withFees.amountOut.toString()).toBe(withoutFees.amountOut.toString());
    expect(withFees.amountOut.gt(bn(10))).toBe(true);
    expect(withFees.amountOut.lte(bn(1000))).toBe(true);
  });

  test.each([-1, 0.5, NaN, Infinity, 2])("invalid input index %s is a result error", (index) => {
    expect(client(pool()).quoteSwap(index, 1, bn(1000)).ok).toBe(false);
  });
  test.each(["0", "-1", (U64_MAX + 1n).toString()])("invalid amount %s is refused", (amount) => {
    expect(client(pool()).quoteSwap(0, 1, bn(amount)).ok).toBe(false);
  });
  test.each([-1, 0.5, NaN, 1_000_001])("invalid slippage %s is refused", (slippage) => {
    expect(client(pool()).quoteSwap(0, 1, bn(1000), slippage).ok).toBe(false);
  });
  test("disabled pools/swaps and inactive input tokens are rejected", () => {
    const state = pool(); const c = client(state);
    state.poolEnabled = false; expect(c.quoteSwap(0, 1, bn(1000)).ok).toBe(false);
    state.poolEnabled = true; state.swapsEnabled = false; expect(c.quoteSwap(0, 1, bn(1000)).ok).toBe(false);
    state.swapsEnabled = true; state.tokens[0].isActive = false; expect(c.quoteSwap(0, 1, bn(1000)).ok).toBe(false);
    state.tokens[0].isActive = true; state.tokens[1].isActive = false;
    expect(c.quoteSwap(0, 1, bn(1000)).ok).toBe(true); // isActive gates the INPUT side.
  });
});

describe("proportional liquidity quotes", () => {
  test("full requested burn preserves 1000 LP and does not subtract protocol fees twice", () => {
    const state = pool(); state.lpTotalSupply = bn(5000);
    state.tokens[0].actualBalance = bn(10000); state.tokens[0].protocolFeesOwed = bn(9900);
    state.tokens[1].actualBalance = bn(20000);
    expect(result(client(state).quoteRemove(bn(5000))).tokenOuts.map(String)).toEqual(["8000", "16000"]);
  });

  test("withdrawal uses Rust fixed-point ratio then multiplication, with two floors", () => {
    const state = pool(); state.lpTotalSupply = bn(3000);
    state.tokens[0].actualBalance = bn(3); state.tokens[1].actualBalance = bn(9);
    expect(result(client(state).quoteRemove(bn(1000))).tokenOuts.map(String)).toEqual(["0", "2"]);
  });

  test("an unsupported token is untouched when the double-rounded withdrawal is zero", () => {
    const state = pool(); state.lpTotalSupply = bn(3000);
    state.tokens[0].actualBalance = bn(3); state.tokens[1].actualBalance = bn(9);
    state.tokens[0].extensions = [MintExtension.NonTransferable];
    state.tokens[0].unsupportedExtensions = [MintExtension.NonTransferable];
    const c = client(state);
    expect(result(c.quoteRemove(bn(1000))).tokenOuts.map(String)).toEqual(["0", "2"]);
    expect(c.buildRemoveLiquidityTx({ user: creator, lpAmount: bn(1000), minimumTokenAmounts: [bn(0), bn(2)] }).ok).toBe(true);
  });

  test.each(["0", "-1", "1000000001", (U64_MAX + 1n).toString()])("invalid withdrawal %s is refused", (amount) => {
    expect(client(pool()).quoteRemove(bn(amount)).ok).toBe(false);
  });
  test("no withdrawal below the LP reserve and no liquidity quotes when disabled", () => {
    const state = pool(); const c = client(state);
    state.lpTotalSupply = bn(1000); expect(c.quoteRemove(bn(1)).ok).toBe(false);
    state.lpTotalSupply = bn(2000); state.poolEnabled = false;
    expect(c.quoteRemove(bn(1)).ok).toBe(false);
    expect(c.quoteAddLiquidity([bn(1000), bn(1000)]).ok).toBe(false);
  });

  test("deposit liveness must match actual balances", () => {
    const state = pool(); const c = client(state);
    expect(c.quoteAddLiquidity([bn(0), bn(1000)]).ok).toBe(false);
    state.tokens[0].actualBalance = bn(0);
    expect(c.quoteAddLiquidity([bn(1000), bn(1000)]).ok).toBe(false);
    expect(c.quoteAddLiquidity([bn(0), bn(1000)]).ok).toBe(true);
  });

  test("v6: a thin live leg is credited UP from the ratio instead of being refused", () => {
    const state = pool(); state.tokens[0].actualBalance = bn(1); state.tokens[1].actualBalance = bn(2);
    state.tokens[0].virtualBalance = bn(5); state.tokens[1].virtualBalance = bn(4);
    // ratio = min(1/1, 1/2) = 0.5, LP = 500m; credits ceil(1·0.5) = 1 and ceil(2·0.5) = 1.
    const q = result(client(state).quoteAddLiquidity([bn(1), bn(1)], 0));
    expect(q.lpOut.toString()).toBe("500000000");
    expect(q.creditedAmounts.map(String)).toEqual(["1", "1"]);
    expect(q.chargedAmounts.map(String)).toEqual(["1", "1"]);
    expect(q.limitingTokenIndex).toBe(1);
    // V grows by ceil(V·c/A): 5 + ceil(5·1/1) = 10, 4 + ceil(4·1/2) = 6.
    expect(q.virtualBalancesAfter.map(String)).toEqual(["10", "6"]);
  });

  test("v6 join/exit virtual-balance round trip returns the original V (A=4, V=5, c=1)", () => {
    const state = pool(); state.lpTotalSupply = bn(4000);
    state.tokens[0].actualBalance = bn(4); state.tokens[0].virtualBalance = bn(5);
    state.tokens[1].actualBalance = bn(4); state.tokens[1].virtualBalance = bn(5);
    const join = result(client(state).quoteAddLiquidity([bn(1), bn(1)], 0));
    expect(join.lpOut.toString()).toBe("1000");
    expect(join.virtualBalancesAfter.map(String)).toEqual(["7", "7"]);
    const after = pool(); after.lpTotalSupply = bn(5000);
    after.tokens.forEach((t) => { t.actualBalance = bn(5); t.virtualBalance = bn(7); });
    const exit = result(client(after).quoteRemove(bn(1000)));
    expect(exit.tokenOuts.map(String)).toEqual(["1", "1"]);
    expect(exit.receivedAmounts.map(String)).toEqual(["1", "1"]);
    expect(exit.virtualBalancesAfter.map(String)).toEqual(["5", "5"]);
  });

  test.each(["-1", (U64_MAX + 1n).toString()])("deposit amount %s must fit u64", (amount) => {
    expect(client(pool()).quoteAddLiquidity([bn(amount), bn(1000)]).ok).toBe(false);
  });
  test("refuses LP, reserve and virtual-balance overflow", () => {
    const supply = pool(); supply.lpTotalSupply = bn(U64_MAX);
    expect(client(supply).quoteAddLiquidity([bn(1_000_000_000), bn(1_000_000_000)]).ok).toBe(false);
    const reserve = pool(); reserve.tokens.forEach(t => { t.actualBalance = bn(U64_MAX); });
    expect(client(reserve).quoteAddLiquidity([bn(U64_MAX), bn(U64_MAX)]).ok).toBe(false);
    const virtual = pool(); virtual.tokens[0].virtualBalance = bn(U64_MAX);
    expect(client(virtual).quoteAddLiquidity([bn(1), bn(1)]).ok).toBe(false);
  });
});

describe("creator-only seed quote", () => {
  function unseeded(): PoolInfo {
    const state = pool(); state.lpTotalSupply = bn(0);
    state.tokens.forEach(t => { t.actualBalance = bn(0); });
    state.tokens[0].virtualBalance = bn(1_000_000_000);
    state.tokens[1].virtualBalance = bn(2_000_000_000);
    return state;
  }
  test("v6.1 (T2): LP is the creator-chosen lp_amount, minted exactly; zero seed legs stay sidelined", () => {
    const state = unseeded(); const c = client(state);
    const q = result(c.quoteSeedDeposit(creator, [bn(10_000_000), bn(0)], bn(5_000_000_000)));
    expect(q.lpOut.toString()).toBe("5000000000");
    expect(q.minimumLpAmount.toString()).toBe("5000000000"); // exact mint: no slippage floor
    expect(q.lpGross.toString()).toBe("5000000000");
    expect(q.depositFeeLp.toString()).toBe("0");
    expect(q.depositAmounts.map(String)).toEqual(["10000000", "0"]);
    expect(q.creditedAmounts.map(String)).toEqual(["10000000", "0"]);
    expect(q.refundAmounts.map(String)).toEqual(["0", "0"]);
    expect(q.virtualBalancesAfter.map(String)).toEqual(["1000000000", "2000000000"]); // untouched
    expect(q.limitingTokenIndex).toBe(-1);
    // The amounts do not price the LP any more: 1 raw unit seeds the same supply.
    expect(result(c.quoteSeedDeposit(creator, [bn(1), bn(0)], 1_000_000_000n)).lpOut.toString()).toBe("1000000000");
    // Default: the atomic deploy's 1_000 LP.
    expect(result(c.quoteSeedDeposit(creator, [bn(1), bn(0)])).lpOut.toString()).toBe("1000000000000");
  });
  test("rejects another wallet, disabled admin, zero seed, existing supply, bad u64 and an lp_amount outside [1e9, 1e16]", () => {
    const state = unseeded(); const c = client(state);
    expect(c.quoteSeedDeposit(key(91), [bn(1), bn(0)], bn(1_000_000_000)).ok).toBe(false);
    expect(c.quoteSeedDeposit(creator, [bn(0), bn(0)], bn(1_000_000_000)).ok).toBe(false);
    expect(c.quoteSeedDeposit(creator, [bn(U64_MAX + 1n), bn(0)], bn(1_000_000_000)).ok).toBe(false);
    expect(c.quoteSeedDeposit(creator, [bn(1), bn(0)], bn(999_999_999)).ok).toBe(false);
    expect(c.quoteSeedDeposit(creator, [bn(1), bn(0)], 10_000_000_000_000_001n).ok).toBe(false);
    state.poolAdmin = PublicKey.default; expect(c.quoteSeedDeposit(creator, [bn(1), bn(0)], bn(1_000_000_000)).ok).toBe(false);
    state.poolAdmin = creator; state.lpTotalSupply = bn(1);
    expect(c.quoteSeedDeposit(creator, [bn(1), bn(0)], bn(1_000_000_000)).ok).toBe(false);
  });
});

describe("v6 Token-2022 transfer fees in quotes", () => {
  const fee = (bps: number, maximumFee: bigint) => ({ epoch: 0n, maximumFee, transferFeeBasisPoints: bps });
  function feePool(): PoolInfo {
    const state = pool(); state.swapFeeRate = 3000; state.protocolFeeRate = 2000;
    state.tokens[0].transferFee = fee(100, 1_000_000n); // 1 %, cap 1e6
    state.tokens[1].transferFee = fee(200, 50n); // 2 %, cap 50
    return state;
  }

  test("swap nets the input fee, prices the net, withholds the output fee and floors on what is received", () => {
    const q = result(client(feePool()).quoteSwap(0, 1, bn(1_000_000), 10_000));
    expect(q.transferFeeIn.toString()).toBe("10000");
    expect(q.amountInNet.toString()).toBe("990000");
    expect(q.feeAmount.toString()).toBe("2970"); // ceil(990000 · 0.003)
    expect(q.protocolFeeAmount.toString()).toBe("594");
    // Same curve as a fee-less 990_000 − 2_970 input.
    const clean = pool(); clean.swapFeeRate = 3000; clean.protocolFeeRate = 2000;
    const ref = result(client(clean).quoteSwap(0, 1, bn(990_000), 10_000));
    expect(q.grossAmountOut!.toString()).toBe(ref.grossAmountOut!.toString());
    expect(q.amountOut.toString()).toBe(ref.amountOut.toString());
    expect(q.transferFeeOut.toString()).toBe("50"); // capped
    expect(q.amountOutReceived.toString()).toBe((BigInt(q.amountOut.toString()) - 50n).toString());
    expect(q.minAmountOut.toString()).toBe(((BigInt(q.amountOutReceived.toString()) * 9900n) / 10000n).toString());
    expect(ref.transferFeeIn.toString()).toBe("0");
    expect(ref.amountOutReceived.toString()).toBe(ref.amountOut.toString());
  });

  test("an input fully consumed by its transfer fee is refused as amount_too_small", () => {
    const state = feePool(); state.tokens[0].transferFee = fee(10_000, 1_000_000n);
    const q = client(state).quoteSwap(0, 1, bn(5));
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error.code).toBe("amount_too_small");
  });

  test("join: ratio from the net ceilings, credit rounded up, debit grossed up by the inverse fee", () => {
    const q = result(client(feePool()).quoteAddLiquidity([bn(10_000_000), bn(10_000_000)], 0));
    // net = [9_900_000, 9_999_950] → limiting leg 0 at ratio 0.0099 → LP 9_900_000.
    expect(q.limitingTokenIndex).toBe(0);
    expect(q.lpOut.toString()).toBe("9900000");
    expect(q.creditedAmounts.map(String)).toEqual(["9900000", "9900000"]);
    // Leg 0 is grossed up by 1 % (100_000); leg 1 by the 50-unit cap.
    expect(q.chargedAmounts.map(String)).toEqual(["10000000", "9900050"]);
    expect(q.transferFees.map(String)).toEqual(["100000", "50"]);
    expect(q.unspentAmounts.map(String)).toEqual(["0", "99950"]);
    expect(q.depositAmounts.map(String)).toEqual(q.chargedAmounts.map(String));
  });

  test("join: the gross-up of a credit always fits the ceiling it was netted from", () => {
    for (const [bps0, cap0, bps1, cap1] of [[100, 1_000_000n, 0, 0n], [5_000, 1_000_000n, 200, 50n], [5_000, 100n, 9_999, 1_000n], [1, 1n, 10_000, 7n]] as const) {
      const state = feePool();
      state.tokens[0].transferFee = bps0 ? fee(bps0, cap0) : null;
      state.tokens[1].transferFee = bps1 ? fee(bps1, cap1) : null;
      for (const ceilings of [[1_000_000n, 1_000_000n], [1_000_001n, 999_999n], [3n, 1_000_000n], [123_457n, 98_765n]]) {
        const q = client(state).quoteAddLiquidity(ceilings.map((c) => bn(c)), 0);
        if (!q.ok) { expect(q.error.code).toBe("amount_too_small"); continue; }
        q.data.chargedAmounts.forEach((charge, i) => {
          expect(BigInt(charge.toString()) <= ceilings[i]).toBe(true);
          expect(BigInt(charge.toString()) - BigInt(q.data.creditedAmounts[i].toString())).toBe(BigInt(q.data.transferFees[i].toString()));
          expect(BigInt(charge.toString()) + BigInt(q.data.unspentAmounts[i].toString())).toBe(ceilings[i]);
        });
      }
    }
    // Odd net under a 50 % uncapped fee: net_0 = 500_000 from 1_000_001; leg 0 limits at 0.0005,
    // so leg 1 is credited 500_000 as well and keeps the rest of its ceiling.
    const state = feePool(); state.tokens[0].transferFee = fee(5_000, 1_000_000n); state.tokens[1].transferFee = null;
    const odd = result(client(state).quoteAddLiquidity([bn(1_000_001), bn(1_000_000)], 0));
    expect(odd.chargedAmounts.map(String)).toEqual(["1000000", "500000"]);
    expect(odd.unspentAmounts.map(String)).toEqual(["1", "500000"]);
  });

  test("seed deposit credits the net amounts; the LP supply is the creator's choice regardless", () => {
    const state = feePool(); state.lpTotalSupply = bn(0); state.tokens.forEach((t) => { t.actualBalance = bn(0); });
    const q = result(client(state).quoteSeedDeposit(creator, [bn(1_000_000_000), bn(1_000_000_000)], bn(2_000_000_000)));
    expect(q.chargedAmounts.map(String)).toEqual(["1000000000", "1000000000"]);
    expect(q.creditedAmounts.map(String)).toEqual(["999000000", "999999950"]); // 1 % capped at 1e6; 2 % capped at 50
    expect(q.actualIn.map(String)).toEqual(["999000000", "999999950"]);
    expect(q.transferFees.map(String)).toEqual(["1000000", "50"]);
    expect(q.limitingTokenIndex).toBe(-1);
    expect(q.lpOut.toString()).toBe("2000000000");
    // A leg fully consumed by its transfer fee is refused.
    state.tokens[0].transferFee = fee(10_000, 1_000_000_000n);
    const eaten = client(state).quoteSeedDeposit(creator, [bn(5), bn(1_000_000_000)], bn(2_000_000_000));
    expect(eaten.ok).toBe(false);
    if (!eaten.ok) expect(eaten.error.code).toBe("amount_too_small");
  });

  test("exit withholds each leg's transfer fee from what the user receives", () => {
    const q = result(client(feePool()).quoteRemove(bn(10_000_000)));
    expect(q.effectiveLpIn.toString()).toBe("10000000");
    expect(q.tokenOuts.map(String)).toEqual(["10000000", "10000000"]);
    expect(q.transferFees.map(String)).toEqual(["100000", "50"]);
    expect(q.receivedAmounts.map(String)).toEqual(["9900000", "9999950"]);
    // 1 % of the pool leaves: V shrinks by floor(V·(A−payout)/A) (V = 2e9).
    expect(q.virtualBalancesAfter.map(String)).toEqual(["1980000000", "1980000000"]);
  });

  test("exit near the floor keeps MIN_LP_SUPPLY and normalises V to A' + 1 on a legacy V ≤ A pool (T22)", () => {
    // Exits are never gated: a pre-T22 pool at V ≤ A can always be left, and
    // the live-leg rule `max(floor(V·(A−p)/A), (A−p)+1)` repairs the slots.
    const state = pool(); state.lpTotalSupply = bn(1_000_000);
    state.tokens[0].actualBalance = bn(1000); state.tokens[0].virtualBalance = bn(1);
    state.tokens[1].actualBalance = bn(1000); state.tokens[1].virtualBalance = bn(1000);
    const q = result(client(state).quoteRemove(bn(1_000_000)));
    expect(q.effectiveLpIn.toString()).toBe("999000");
    expect(q.tokenOuts.map(String)).toEqual(["999", "999"]);
    expect(q.virtualBalancesAfter.map(String)).toEqual(["2", "2"]);
  });
});
