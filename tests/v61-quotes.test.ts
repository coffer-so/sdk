/**
 * v6.1 quotes on `CofferPoolClient`: swap fee cascade (T15 / T14 / T12 /
 * T9), deposit on NAV with the bucket buy-in and the deposit fee (T12 / T7),
 * exit with the bucket share and the withdraw fee, the seed quote (T2 /
 * T10), LP price on NAV (T2), sidelined slots (T10) and the pending-action
 * read model (T3).
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { CofferPoolClient } from "../src/clients/CofferPoolClient";
import { splitFee } from "../src/math/feeSplit";
import { applyLiquidityFee } from "../src/math/liquidityFee";
import { calcJoinRatioAndLp, calcTokensOutGivenLpIn, calcEffectiveLpBurn } from "../src/math/poolMath";
import { splitDepositCredit } from "../src/math/surgeBucket";
import { simulatePoolSwap } from "../src/clients/quote-math";
import { HOOK_FLAGS, DEFAULT_INITIAL_LP_SUPPLY, MIN_INITIAL_LP_SUPPLY, MAX_INITIAL_LP_SUPPLY } from "../src/config";
import { GRACE_PERIOD_SECS } from "../src/parsers/layout";
import { mockPool, cfg, pk, bn, MockPoolOptions } from "./helpers/poolFixture";
import type { PoolInfo } from "../src/types/pool";

function clientFor(pool: PoolInfo): CofferPoolClient {
  const client = new CofferPoolClient({ config: cfg, poolAddress: pool.address });
  (client as unknown as { cache: PoolInfo }).cache = pool;
  return client;
}
const client = (o: MockPoolOptions = {}) => { const pool = mockPool(o); return { pool, client: clientFor(pool) }; };
const unwrap = <T>(r: { ok: true; data: T } | { ok: false; error: { code: string; humanMessage: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.humanMessage}`);
  return r.data;
};
const big = (b: BN) => BigInt(b.toString());
const err = <T>(r: { ok: true; data: T } | { ok: false; error: { code: string; humanMessage: string } }) => (r.ok ? undefined : r.error);

describe("quoteSwap — fee cascade", () => {
  test("[P01] 10 % protocol, 0 creator: base fee ceil, protocol ceil of the fee, LP the rest", () => {
    const { client: c } = client({ swapFeeRate: 3000, protocolFeeRate: 1000 });
    const q = unwrap(c.quoteSwap(0, 1, new BN(1_000_000)));
    expect(q.feeAmount.toNumber()).toBe(3000);
    const s = splitFee(3000n, 1000, 0);
    expect(big(q.protocolFeeAmount)).toBe(s.protocol); expect(big(q.creatorFeeAmount)).toBe(0n); expect(big(q.lpFeeAmount)).toBe(s.lp);
    expect(q.effectiveFeeRate).toBe(3000); expect(q.feeSource).toBe("pool");
  });
  test("[P02] creator share 25 % is the floor of the LP remainder and leaves amountOut unchanged", () => {
    const a = unwrap(client({ swapFeeRate: 3000, protocolFeeRate: 1000, creatorFeeBps: 0 }).client.quoteSwap(0, 1, new BN(1_000_000)));
    const b = unwrap(client({ swapFeeRate: 3000, protocolFeeRate: 1000, creatorFeeBps: 2500 }).client.quoteSwap(0, 1, new BN(1_000_000)));
    expect(b.amountOut.toString()).toBe(a.amountOut.toString());
    expect(b.feeAmount.toString()).toBe(a.feeAmount.toString());
    expect(b.protocolFeeAmount.toString()).toBe(a.protocolFeeAmount.toString());
    expect(big(b.creatorFeeAmount)).toBe(((3000n - big(b.protocolFeeAmount)) * 2500n) / 10_000n);
    expect(big(b.creatorFeeAmount) + big(b.lpFeeAmount) + big(b.protocolFeeAmount)).toBe(3000n);
  });
  test("[P03] 100 % creator share: LPs get nothing, trader unaffected", () => {
    const q = unwrap(client({ swapFeeRate: 3000, protocolFeeRate: 1000, creatorFeeBps: 10_000 }).client.quoteSwap(0, 1, new BN(1_000_000)));
    expect(q.lpFeeAmount.isZero()).toBe(true);
    expect(big(q.creatorFeeAmount)).toBe(3000n - big(q.protocolFeeAmount));
  });
  test("[P04] 100 % protocol: everything to the protocol", () => {
    const q = unwrap(client({ swapFeeRate: 3000, protocolFeeRate: 10_000, creatorFeeBps: 5000 }).client.quoteSwap(0, 1, new BN(1_000_000)));
    expect(q.protocolFeeAmount.toNumber()).toBe(3000); expect(q.creatorFeeAmount.isZero()).toBe(true); expect(q.lpFeeAmount.isZero()).toBe(true);
  });
  test("[P05] 0 % protocol: fee minus creator share stays with the LPs", () => {
    const q = unwrap(client({ swapFeeRate: 3000, protocolFeeRate: 0, creatorFeeBps: 1000 }).client.quoteSwap(0, 1, new BN(1_000_000)));
    expect(q.protocolFeeAmount.isZero()).toBe(true); expect(q.creatorFeeAmount.toNumber()).toBe(300); expect(q.lpFeeAmount.toNumber()).toBe(2700);
  });
  test("[P06] the input reserves grow by net − (protocol + creator); the creator bucket by the creator share", () => {
    const pool = mockPool({ swapFeeRate: 3000, protocolFeeRate: 1000, creatorFeeBps: 2500 });
    const r = simulatePoolSwap(pool, 0, 1, 1_000_000n, 1_700_000_000n);
    expect(r.inputAfter.actualBalance).toBe(1_000_000_000n + 1_000_000n - r.protocolFeeAmount - r.creatorFeeAmount);
    expect(r.inputAfter.creatorFeesOwed).toBe(r.creatorFeeAmount);
    expect(r.inputAfter.protocolFeesOwed).toBe(r.protocolFeeAmount);
    expect(r.outputAfter.actualBalance).toBe(1_000_000_000n - r.grossAmountOut);
  });
  test("[P07] surge cascade: protocol ceil → creator floor → LP bucket on the OUTPUT slot; reserves move by the gross output", () => {
    const pool = mockPool({ swapFeeRate: 3000, protocolFeeRate: 1000, creatorFeeBps: 2500 });
    // arm a sell-off window on the input token that the swap crosses
    const t = pool.tokens[0];
    t.maxSelloffPct = 1000; t.maxSelloffPeriodLength = 3600; t.variableFeeThresholdPct = 1000; t.variableFeeSlopeLowPct = 100; t.variableFeeSlopeMidPct = 1800; t.variableFeeSlopeHighPct = 8000; t.variableFeeKinkPct = 75;
    t.selloffVbSnapshot = bn(1_000_000_000n); t.windowStartTimestamp = bn(1_699_999_000n); t.currentSelloff = bn(50_000_000n);
    const r = simulatePoolSwap(pool, 0, 1, 40_000_000n, 1_700_000_000n);
    expect(r.surgeFeeAmount > 0n).toBe(true);
    const s = splitFee(r.surgeFeeAmount, 1000, 2500);
    expect(r.surgeProtocolFeeAmount).toBe(s.protocol); expect(r.surgeCreatorFeeAmount).toBe(s.creator); expect(r.surgeLpFeeAmount).toBe(s.lp);
    expect(r.outputAfter.protocolFeesOwed).toBe(s.protocol);
    expect(r.outputAfter.creatorFeesOwed).toBe(s.creator);
    expect(r.outputAfter.surgeFeesOwed).toBe(s.lp);
    expect(r.outputAfter.actualBalance).toBe(1_000_000_000n - r.grossAmountOut);
    expect(r.outputAfter.virtualBalance).toBe(1_000_000_000n - r.grossAmountOut);
    expect(r.amountOut).toBe(r.grossAmountOut - r.surgeFeeAmount);
    const q = unwrap(clientFor(pool).quoteSwap(0, 1, new BN(40_000_000)));
    expect(big(q.surgeLpFeeAmount)).toBe(s.lp); expect(big(q.surgeProtocolFeeAmount)).toBe(s.protocol);
  });
  test("[P08] a hook fee override is clamped into [feeMin, feeMax] and reported as hook_override", () => {
    const hook = { flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin: 1000, feeMax: 50_000 };
    const { client: c } = client({ swapFeeRate: 3000, hook });
    const q = unwrap(c.quoteSwap(0, 1, new BN(1_000_000), { hookFeeOverride: 999_999 }));
    expect(q.effectiveFeeRate).toBe(50_000); expect(q.feeAmount.toNumber()).toBe(50_000); expect(q.feeSource).toBe("hook_override");
    const lo = unwrap(c.quoteSwap(0, 1, new BN(1_000_000), { hookFeeOverride: 1 }));
    expect(lo.effectiveFeeRate).toBe(1000);
    const mid = unwrap(c.quoteSwap(0, 1, new BN(1_000_000), { hookFeeOverride: 2500 }));
    expect(mid.effectiveFeeRate).toBe(2500); expect(mid.feeAmount.toNumber()).toBe(2500);
  });
  test("[P09] a hooked swap at override r is byte-equal to a plain pool whose base rate is r", () => {
    const hooked = unwrap(client({ swapFeeRate: 3000, hook: { flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin: 0, feeMax: 100_000 } }).client.quoteSwap(0, 1, new BN(123_456_789), { hookFeeOverride: 7_777 }));
    const plain = unwrap(client({ swapFeeRate: 7_777 }).client.quoteSwap(0, 1, new BN(123_456_789)));
    for (const k of ["amountOut", "feeAmount", "protocolFeeAmount", "amountOutReceived", "minAmountOut"] as const) expect(hooked[k].toString()).toBe(plain[k].toString());
  });
  test("[P10] a DYNAMIC_FEE pool quoted without an override runs at the base rate and says hook_dynamic_unknown", () => {
    const q = unwrap(client({ swapFeeRate: 3000, hook: { flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin: 0, feeMax: 100_000 } }).client.quoteSwap(0, 1, new BN(1_000_000)));
    expect(q.feeSource).toBe("hook_dynamic_unknown"); expect(q.effectiveFeeRate).toBe(3000);
  });
  test("[P11] a non-dynamic hook (or a disabled one) quotes as `pool`", () => {
    expect(unwrap(client({ hook: { flags: HOOK_FLAGS.AFTER_SWAP } }).client.quoteSwap(0, 1, new BN(1_000))).feeSource).toBe("pool");
    expect(unwrap(client({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMax: 100, disabled: true } }).client.quoteSwap(0, 1, new BN(1_000))).feeSource).toBe("pool");
  });
  test("[P12] the positional (in, out, amount, slippage, now) signature still works", () => {
    const q = unwrap(client().client.quoteSwap(0, 1, new BN(1_000_000), 10_000, 1_700_000_000));
    expect(q.minAmountOut.toString()).toBe(((big(q.amountOutReceived) * 990_000n) / 1_000_000n).toString());
  });
  test("[P13] minAmountOut is never 0 for a positive output", () => {
    const q = unwrap(client().client.quoteSwap(0, 1, new BN(1_000_000)));
    expect(q.minAmountOut.gtn(0)).toBe(true);
  });
  test("[N01] a sidelined output slot is a typed no_liquidity error, never a zero quote", () => {
    const r = client({ balances: [[1_000_000_000n, 1_000_000_000n], [0n, 1_000_000_000n]] }).client.quoteSwap(0, 1, new BN(1_000));
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.code).toBe("no_liquidity");
  });
  test("[N02] a hookFeeOverride on a pool without a DYNAMIC_FEE hook is refused", () => {
    const r = client().client.quoteSwap(0, 1, new BN(1_000), { hookFeeOverride: 100 });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.code).toBe("invalid_input");
  });
  test("[N03] an out-of-range hookFeeOverride is refused", () => {
    const { client: c } = client({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMax: 100 } });
    for (const v of [-1, 1_000_001, 1.5, NaN]) expect(c.quoteSwap(0, 1, new BN(1_000), { hookFeeOverride: v }).ok).toBe(false);
  });
  test("[N04] a paused fail-closed hook refuses swaps (HookPaused)", () => {
    const r = client({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.PAUSE_WHEN_DISABLED, disabled: true } }).client.quoteSwap(0, 1, new BN(1_000));
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.code).toBe("hook_rejected");
  });
  test("[N05] a disabled fail-OPEN hook still quotes at the base rate", () => {
    expect(client({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP, disabled: true } }).client.quoteSwap(0, 1, new BN(1_000)).ok).toBe(true);
  });
  test("[N06] same index / out of range / disabled pool / swaps off", () => {
    const { client: c } = client();
    expect(c.quoteSwap(0, 0, new BN(1)).ok).toBe(false);
    expect(c.quoteSwap(0, 5, new BN(1)).ok).toBe(false);
    expect(err(client({ poolEnabled: false }).client.quoteSwap(0, 1, new BN(1)))?.code).toBe("pool_disabled");
    expect(err(client({ swapsEnabled: false }).client.quoteSwap(0, 1, new BN(1)))?.code).toBe("swaps_disabled");
  });
});

describe("quoteAddLiquidity — NAV, buy-in, deposit fee", () => {
  test("[P14] without buckets / fees the v6 quote is unchanged", () => {
    const q = unwrap(client().client.quoteAddLiquidity([new BN(10_000_000), new BN(8_000_000)], 10_000));
    expect(q.limitingTokenIndex).toBe(1); expect(q.lpOut.toString()).toBe("8000000000"); expect(q.minimumLpAmount.toString()).toBe("7920000000");
    expect(q.surgeBuyIn.map(String)).toEqual(["0", "0"]); expect(q.depositFeeLp.isZero()).toBe(true); expect(q.lpGross.toString()).toBe(q.lpOut.toString());
  });
  test("[P15] the ratio is taken over NAV (actual + surge) and the credit buys into the bucket", () => {
    const pool = mockPool({ balances: [[900n, 1_000n], [1_000n, 1_000n]], surge: [100n, 0n], lpSupply: 1_000_000n });
    const q = unwrap(clientFor(pool).quoteAddLiquidity([new BN(500), new BN(500)]));
    const navs = [1_000n, 1_000n];
    const { lp, ratio } = calcJoinRatioAndLp(navs, [500n, 500n], 1_000_000n);
    expect(q.navBalances.map(String)).toEqual(navs.map(String));
    expect(big(q.lpGross)).toBe(lp);
    const leg = splitDepositCredit(900n, 100n, ratio);
    expect(big(q.creditedAmounts[0])).toBe(leg.totalCredit); expect(big(q.surgeBuyIn[0])).toBe(leg.bucketIn); expect(big(q.actualIn[0])).toBe(leg.actualIn);
    expect(big(q.creditedAmounts[0])).toBe(big(q.actualIn[0]) + big(q.surgeBuyIn[0]));
  });
  test("[P16] the deposit fee is a haircut on the LP, the basket is untouched", () => {
    const a = unwrap(client().client.quoteAddLiquidity([new BN(10_000_000), new BN(10_000_000)]));
    const b = unwrap(client({ depositFeeBps: 50 }).client.quoteAddLiquidity([new BN(10_000_000), new BN(10_000_000)]));
    expect(b.lpGross.toString()).toBe(a.lpOut.toString());
    const { net, fee } = applyLiquidityFee(big(a.lpOut), 50);
    expect(big(b.lpOut)).toBe(net); expect(big(b.depositFeeLp)).toBe(fee); expect(b.depositFeeBps).toBe(50);
    expect(b.creditedAmounts.map(String)).toEqual(a.creditedAmounts.map(String));
    expect(b.minimumLpAmount.lt(b.lpOut) || b.minimumLpAmount.eq(b.lpOut)).toBe(true);
  });
  test("[P17] a reserve-less slot with a bucket is live and takes its whole credit into the bucket", () => {
    const pool = mockPool({ balances: [[1_000n, 1_000n], [0n, 1_000n]], surge: [0n, 500n], lpSupply: 1_000_000n });
    const q = unwrap(clientFor(pool).quoteAddLiquidity([new BN(100), new BN(100)]));
    expect(big(q.surgeBuyIn[1])).toBe(big(q.creditedAmounts[1])); expect(q.actualIn[1].isZero()).toBe(true);
  });
  test("[P18] a sidelined slot (NAV 0) must be 0 and gets no credit", () => {
    const pool = mockPool({ balances: [[1_000n, 1_000n], [0n, 1_000n]], lpSupply: 1_000_000n });
    const q = unwrap(clientFor(pool).quoteAddLiquidity([new BN(100), new BN(0)]));
    expect(q.creditedAmounts[1].isZero()).toBe(true); expect(q.chargedAmounts[1].isZero()).toBe(true);
  });
  test("[P19] the virtual balance grows from the ACTUAL leg only", () => {
    const pool = mockPool({ balances: [[900n, 2_000n], [1_000n, 2_000n]], surge: [100n, 0n], lpSupply: 1_000_000n });
    const q = unwrap(clientFor(pool).quoteAddLiquidity([new BN(500), new BN(500)]));
    // ceil(V · (A + actual_in) / A)
    const expected = (2_000n * (900n + big(q.actualIn[0])) + 899n) / 900n;
    expect(big(q.virtualBalancesAfter[0])).toBe(expected);
  });
  test("[N07] a 100 % deposit fee closes deposits (DepositFeeConsumesAll → amount_too_small)", () => {
    const r = client({ depositFeeBps: 10_000 }).client.quoteAddLiquidity([new BN(10_000_000), new BN(10_000_000)]);
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.code).toBe("amount_too_small"); expect(r.error.humanMessage).toMatch(/DepositFeeConsumesAll/);
  });
  test("[N08] liveness is keyed on NAV: a bucket-only slot needs a positive ceiling", () => {
    const pool = mockPool({ balances: [[1_000n, 1_000n], [0n, 1_000n]], surge: [0n, 500n], lpSupply: 1_000_000n });
    expect(err(clientFor(pool).quoteAddLiquidity([new BN(100), new BN(0)]))?.humanMessage).toMatch(/TokenLivenessMismatch/);
  });
  test("[N09] a sidelined slot with a positive ceiling is a liveness mismatch", () => {
    const pool = mockPool({ balances: [[1_000n, 1_000n], [0n, 1_000n]], lpSupply: 1_000_000n });
    expect(clientFor(pool).quoteAddLiquidity([new BN(100), new BN(100)]).ok).toBe(false);
  });
  test("[N10] a paused fail-closed hook refuses deposits", () => {
    const r = client({ hook: { flags: HOOK_FLAGS.BEFORE_ADD_LIQUIDITY | HOOK_FLAGS.PAUSE_WHEN_DISABLED, disabled: true } }).client.quoteAddLiquidity([new BN(1_000), new BN(1_000)]);
    expect(err(r)?.code).toBe("hook_rejected");
  });
  test("[N11] unseeded pool / wrong length / disabled pool", () => {
    expect(client({ lpSupply: 0n }).client.quoteAddLiquidity([new BN(1), new BN(1)]).ok).toBe(false);
    expect(client().client.quoteAddLiquidity([new BN(1)]).ok).toBe(false);
    expect(err(client({ poolEnabled: false }).client.quoteAddLiquidity([new BN(1), new BN(1)]))?.code).toBe("pool_disabled");
  });
});

describe("quoteRemove — bucket share and withdraw fee", () => {
  test("[P20] without buckets / fees the v6 payout is unchanged and surgeOuts are 0", () => {
    const q = unwrap(client().client.quoteRemove(new BN(1_000_000_000)));
    expect(q.tokenOuts.map(String)).toEqual(["1000000", "1000000"]); expect(q.surgeOuts.map(String)).toEqual(["0", "0"]);
    expect(q.receivedAmounts.map(String)).toEqual(["1000000", "1000000"]); expect(q.withdrawFeeAmounts.map(String)).toEqual(["0", "0"]);
  });
  test("[P21] the bucket pays its pro-rata share in the same transfer", () => {
    const pool = mockPool({ balances: [[1_000_000n, 1_000_000n], [1_000_000n, 1_000_000n]], surge: [100_000n, 0n], lpSupply: 1_000_000n });
    const q = unwrap(clientFor(pool).quoteRemove(new BN(100_000)));
    expect(q.tokenOuts[0].toString()).toBe("100000"); expect(q.surgeOuts[0].toString()).toBe("10000");
    expect(q.transferAmounts[0].toString()).toBe("110000"); expect(q.receivedAmounts[0].toString()).toBe("110000"); expect(q.surgeOuts[1].isZero()).toBe(true);
  });
  test("[P22] the withdraw fee is a ceil on each part; payouts are net; vb follows the net reserve payout", () => {
    const pool = mockPool({ balances: [[1_000_000n, 2_000_000n], [1_000_000n, 2_000_000n]], surge: [100_001n, 0n], lpSupply: 1_000_000n, withdrawFeeBps: 5 });
    const q = unwrap(clientFor(pool).quoteRemove(new BN(100_000)));
    const grossA = 100_000n, grossS = (100_001n * ((100_000n * 10n ** 18n) / 1_000_000n)) / 10n ** 18n;
    expect(big(q.grossAmounts[0])).toBe(grossA); expect(big(q.grossSurgeAmounts[0])).toBe(grossS);
    const fa = applyLiquidityFee(grossA, 5), fs = applyLiquidityFee(grossS, 5);
    expect(big(q.tokenOuts[0])).toBe(fa.net); expect(big(q.surgeOuts[0])).toBe(fs.net); expect(big(q.withdrawFeeAmounts[0])).toBe(fa.fee + fs.fee);
    expect(q.withdrawFeeBps).toBe(5);
    expect(big(q.virtualBalancesAfter[0])).toBe((2_000_000n * (1_000_000n - fa.net)) / 1_000_000n);
  });
  test("[P23] MIN_LP_SUPPLY clamp and effectiveLpIn", () => {
    const pool = mockPool({ lpSupply: 1_000_000n });
    const q = unwrap(clientFor(pool).quoteRemove(new BN(1_000_000)));
    expect(big(q.effectiveLpIn)).toBe(calcEffectiveLpBurn(1_000_000n, 1_000_000n));
  });
  test("[P24] sidelined slots pay 0 and need no account", () => {
    const pool = mockPool({ balances: [[1_000_000n, 1_000_000n], [0n, 1_000_000n]], lpSupply: 1_000_000n });
    const q = unwrap(clientFor(pool).quoteRemove(new BN(100_000)));
    expect(q.tokenOuts[1].isZero()).toBe(true); expect(q.receivedAmounts[1].isZero()).toBe(true);
  });
  test("[P25] payouts agree with calcTokensOutGivenLpIn on both arrays", () => {
    const pool = mockPool({ balances: [[123_456n, 1n], [987_654n, 1n]], surge: [10n, 20n], lpSupply: 10_000n });
    const q = unwrap(clientFor(pool).quoteRemove(new BN(3_333)));
    expect(q.grossAmounts.map(String)).toEqual(calcTokensOutGivenLpIn([123_456n, 987_654n], 3_333n, 10_000n).map(String));
    expect(q.grossSurgeAmounts.map(String)).toEqual(calcTokensOutGivenLpIn([10n, 20n], 3_333n, 10_000n).map(String));
  });
  test("[N12] a 100 % withdraw fee closes withdrawals (WithdrawFeeConsumesAll → amount_too_small)", () => {
    const r = client({ withdrawFeeBps: 10_000 }).client.quoteRemove(new BN(1_000_000));
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.code).toBe("amount_too_small");
  });
  test("[N13] InvalidLpAmount: zero, above supply, unseeded", () => {
    const { client: c } = client();
    expect(c.quoteRemove(new BN(0)).ok).toBe(false);
    expect(c.quoteRemove(new BN("2000000000000")).ok).toBe(false);
    expect(client({ lpSupply: 0n }).client.quoteRemove(new BN(1)).ok).toBe(false);
  });
  test("[N14] a dust burn that pays nothing anywhere with no fee is still allowed (pre-fee behaviour)", () => {
    const pool = mockPool({ balances: [[5n, 1_000n], [5n, 1_000n]], lpSupply: 1_000_000n });
    expect(clientFor(pool).quoteRemove(new BN(1)).ok).toBe(true);
  });
});

describe("quoteSeedDeposit (T2 / T10)", () => {
  const admin = pk();
  test("[P26] exact amounts, creator-chosen supply, zeros allowed", () => {
    const pool = mockPool({ lpSupply: 0n, poolAdmin: admin, balances: [[0n, 1_000n], [0n, 1_000n], [0n, 1_000n]] });
    const q = unwrap(clientFor(pool).quoteSeedDeposit(admin, [new BN(100), new BN(0), new BN(300)], new BN(5_000_000_000)));
    expect(q.lpOut.toString()).toBe("5000000000"); expect(q.minimumLpAmount.toString()).toBe("5000000000");
    expect(q.creditedAmounts.map(String)).toEqual(["100", "0", "300"]); expect(q.depositFeeLp.isZero()).toBe(true); expect(q.limitingTokenIndex).toBe(-1);
  });
  test("[P27] the default supply is DEFAULT_INITIAL_LP_SUPPLY (1_000 LP)", () => {
    const pool = mockPool({ lpSupply: 0n, poolAdmin: admin, balances: [[0n, 1_000n], [0n, 1_000n]] });
    expect(unwrap(clientFor(pool).quoteSeedDeposit(admin, [new BN(1), new BN(1)])).lpOut.toString()).toBe(DEFAULT_INITIAL_LP_SUPPLY.toString());
  });
  test("[N15] gate order: PoolDisabled → PoolAlreadySeeded → PoolAdminDisabled → SeedDepositNotPoolAdmin → length → non-zero → supply bounds", () => {
    const base = { lpSupply: 0n, poolAdmin: admin, balances: [[0n, 1_000n], [0n, 1_000n]] as Array<[bigint, bigint]> };
    expect(err(clientFor(mockPool({ ...base, poolEnabled: false })).quoteSeedDeposit(admin, [new BN(1), new BN(1)]))?.code).toBe("pool_disabled");
    expect(err(clientFor(mockPool({ ...base, lpSupply: 1n })).quoteSeedDeposit(admin, [new BN(1), new BN(1)]))?.humanMessage).toMatch(/PoolAlreadySeeded/);
    expect(err(clientFor(mockPool({ ...base, poolAdmin: PublicKey.default })).quoteSeedDeposit(admin, [new BN(1), new BN(1)]))?.humanMessage).toMatch(/PoolAdminDisabled/);
    expect(err(clientFor(mockPool(base)).quoteSeedDeposit(pk(), [new BN(1), new BN(1)]))?.code).toBe("auth_failed");
    expect(err(clientFor(mockPool(base)).quoteSeedDeposit(admin, [new BN(1)]))?.humanMessage).toMatch(/InvalidArrayLength/);
    expect(err(clientFor(mockPool(base)).quoteSeedDeposit(admin, [new BN(0), new BN(0)]))?.humanMessage).toMatch(/FirstDepositRequiresNonzero/);
    expect(err(clientFor(mockPool(base)).quoteSeedDeposit(admin, [new BN(1), new BN(1)], MIN_INITIAL_LP_SUPPLY - 1n))?.humanMessage).toMatch(/InitialLiquidityTooSmall/);
    expect(err(clientFor(mockPool(base)).quoteSeedDeposit(admin, [new BN(1), new BN(1)], MAX_INITIAL_LP_SUPPLY + 1n))?.humanMessage).toMatch(/InitialLpSupplyTooLarge/);
  });
});

describe("LP price / position value (T2 / T12)", () => {
  test("[P28] price = Σ NAV_i / 10^dec_i × price_i ÷ (supply / 1e9)", () => {
    const pool = mockPool({ balances: [[1_000_000_000n, 1n], [2_000_000n, 1n]], surge: [0n, 1_000_000n], decimals: [9, 6], lpSupply: 2_000_000_000n });
    const prices = { [pool.tokens[0].mint.toBase58()]: 2, [pool.tokens[1].mint.toBase58()]: 1 };
    const q = unwrap(clientFor(pool).quoteLpPriceUsd(prices));
    expect(q.navUsd).toBeCloseTo(1 * 2 + 3 * 1, 9); expect(q.lpSupplyUi).toBe(2); expect(q.lpPriceUsd).toBeCloseTo(2.5, 9);
    expect(q.perToken[1].nav.toString()).toBe("3000000");
  });
  test("[P29] position value is the pro-rata NAV share per token", () => {
    const pool = mockPool({ balances: [[1_000_000n, 1n], [500_000n, 1n]], surge: [100_000n, 0n], lpSupply: 1_000_000n });
    expect(unwrap(clientFor(pool).quoteLpPositionValue(new BN(100_000))).map(String)).toEqual(["110000", "50000"]);
  });
  test("[N16] unseeded pools / missing prices are refused", () => {
    expect(client({ lpSupply: 0n }).client.quoteLpPriceUsd({}).ok).toBe(false);
    expect(client().client.quoteLpPriceUsd({}).ok).toBe(false);
    expect(client().client.quoteLpPositionValue(new BN(-1)).ok).toBe(false);
  });
});

describe("pendingActionsStatus (T3)", () => {
  test("[P30] none / waiting / ready / expired at the chain clock, readyKinds, directPathOpen", () => {
    const now = 1_700_000_000;
    const etas = Array(11).fill(0); etas[2] = now + 100; etas[4] = now; etas[9] = now - GRACE_PERIOD_SECS - 1;
    const pool = mockPool({ pendingEtas: etas, chainTimestamp: now, poolAdminDelaySecs: 3600, poolAdminEpoch: 2 });
    const s = unwrap(clientFor(pool).pendingActionsStatus());
    expect(s.now).toBe(now); expect(s.delaySecs).toBe(3600); expect(s.epoch).toBe(2); expect(s.directPathOpen).toBe(false);
    expect(s.actions.map((a) => a.status)).toEqual(["none", "none", "waiting", "none", "ready", "none", "none", "none", "none", "expired", "none"]);
    expect(s.actions[2].secondsUntilReady).toBe(100); expect(s.readyKinds).toEqual([4]); expect(s.mask).toBe((1 << 2) | (1 << 4) | (1 << 9));
  });
  test("[P31] an explicit chainNow overrides the synced clock; delay 0 opens the direct path", () => {
    const pool = mockPool({ pendingEtas: [0, 0, 1_700_000_100, 0, 0, 0, 0, 0, 0, 0, 0], chainTimestamp: 1_700_000_000 });
    expect(unwrap(clientFor(pool).pendingActionsStatus(1_700_000_200)).actions[2].status).toBe("ready");
    expect(unwrap(clientFor(pool).pendingActionsStatus()).directPathOpen).toBe(true);
  });
  test("[N17] no chain timestamp and no override is an error (never Date.now())", () => {
    const pool = mockPool(); delete (pool as any).chainTimestamp;
    expect(clientFor(pool).pendingActionsStatus().ok).toBe(false);
    expect(clientFor(pool).pendingActionsStatus(-1).ok).toBe(false);
  });
});
