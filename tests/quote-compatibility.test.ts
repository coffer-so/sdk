import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CubicPoolClient, getConfig, MintExtension } from "../src";
import { PoolInfo } from "../src/types/pool";
import { SdkResult } from "../src/types/result";
import rust from "./math/fixtures/deployed-v5-math.json";

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
      actualBalance: bn(1_000_000_000), virtualBalance: bn(1_000_000_000),
      protocolFeesOwed: bn(0), concentration: 1, isActive: true,
      maxSelloffPct: 0, maxSelloffPeriodLength: 0, variableFeeThresholdPct: 0,
      variableFeeSlopeLowPct: 0, variableFeeSlopeMidPct: 0, variableFeeSlopeHighPct: 0,
      variableFeeKinkPct: 0, previousSelloff: bn(0), currentSelloff: bn(0),
      windowStartTimestamp: bn(0), selloffVbSnapshot: bn(0), extensions: [], unsupportedExtensions: [],
    })),
    bptMint: key(20), bptTokenProgram: TOKEN_PROGRAM_ID, bptTotalSupply: bn(1_000_000_000),
    poolAdmin: creator, pendingPoolAdmin: PublicKey.default, rangeManager: PublicKey.default,
    rangeManagerEnabled: false, rangeManagerMaxVbChangePct: 0, rangeManagerMaxWeightChangePct: 0,
    rangeManagerMinUpdateIntervalSecs: 0, rangeManagerLastUpdated: bn(0),
    rangeManagerMinLeverageBps: 0, rangeManagerMaxLeverageBps: 0,
    swapFeeRate: 0, protocolFeeRate: 0, poolEnabled: true, swapsEnabled: true,
    createdAt: 0, chainTimestamp: 10030, lookupTable: PublicKey.default,
    bannedExtensions: bn(0), unsupportedTokenIndices: [], syncedAt: 10030_000,
  };
}

function client(state: PoolInfo): CubicPoolClient {
  const c = new CubicPoolClient({ config: getConfig("devnet"), poolAddress: state.address });
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
    state.tokens[0].virtualBalance = bn(1_000_000);
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
  test("full requested burn preserves 1000 BPT and does not subtract protocol fees twice", () => {
    const state = pool(); state.bptTotalSupply = bn(5000);
    state.tokens[0].actualBalance = bn(10000); state.tokens[0].protocolFeesOwed = bn(9900);
    state.tokens[1].actualBalance = bn(20000);
    expect(result(client(state).quoteRemove(bn(5000))).tokenOuts.map(String)).toEqual(["8000", "16000"]);
  });

  test("withdrawal uses Rust fixed-point ratio then multiplication, with two floors", () => {
    const state = pool(); state.bptTotalSupply = bn(3000);
    state.tokens[0].actualBalance = bn(3); state.tokens[1].actualBalance = bn(9);
    expect(result(client(state).quoteRemove(bn(1000))).tokenOuts.map(String)).toEqual(["0", "2"]);
  });

  test("an unsupported token is untouched when the double-rounded withdrawal is zero", () => {
    const state = pool(); state.bptTotalSupply = bn(3000);
    state.tokens[0].actualBalance = bn(3); state.tokens[1].actualBalance = bn(9);
    state.tokens[0].extensions = [MintExtension.TransferFeeConfig];
    state.tokens[0].unsupportedExtensions = [MintExtension.TransferFeeConfig];
    const c = client(state);
    expect(result(c.quoteRemove(bn(1000))).tokenOuts.map(String)).toEqual(["0", "2"]);
    expect(c.buildRemoveLiquidityTx({ user: creator, bptAmount: bn(1000), minimumTokenAmounts: [bn(0), bn(2)] }).ok).toBe(true);
  });

  test.each(["0", "-1", "1000000001", (U64_MAX + 1n).toString()])("invalid withdrawal %s is refused", (amount) => {
    expect(client(pool()).quoteRemove(bn(amount)).ok).toBe(false);
  });
  test("no withdrawal below the BPT reserve and no liquidity quotes when disabled", () => {
    const state = pool(); const c = client(state);
    state.bptTotalSupply = bn(1000); expect(c.quoteRemove(bn(1)).ok).toBe(false);
    state.bptTotalSupply = bn(2000); state.poolEnabled = false;
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

  test("refuses a zero-credit live leg even if the contract math would mint BPT", () => {
    const state = pool(); state.tokens[0].actualBalance = bn(1); state.tokens[1].actualBalance = bn(2);
    // ratio=1/2, BPT=500m, but the first transfer would round down to zero.
    expect(client(state).quoteAddLiquidity([bn(1), bn(1)]).ok).toBe(false);
  });

  test.each(["-1", (U64_MAX + 1n).toString()])("deposit amount %s must fit u64", (amount) => {
    expect(client(pool()).quoteAddLiquidity([bn(amount), bn(1000)]).ok).toBe(false);
  });
  test("refuses BPT, reserve and virtual-balance overflow", () => {
    const supply = pool(); supply.bptTotalSupply = bn(U64_MAX);
    expect(client(supply).quoteAddLiquidity([bn(1_000_000_000), bn(1_000_000_000)]).ok).toBe(false);
    const reserve = pool(); reserve.tokens.forEach(t => { t.actualBalance = bn(U64_MAX); });
    expect(client(reserve).quoteAddLiquidity([bn(U64_MAX), bn(U64_MAX)]).ok).toBe(false);
    const virtual = pool(); virtual.tokens[0].virtualBalance = bn(U64_MAX);
    expect(client(virtual).quoteAddLiquidity([bn(1), bn(1)]).ok).toBe(false);
  });
});

describe("creator-only seed quote", () => {
  function unseeded(): PoolInfo {
    const state = pool(); state.bptTotalSupply = bn(0);
    state.tokens.forEach(t => { t.actualBalance = bn(0); });
    state.tokens[1].virtualBalance = bn(2_000_000_000);
    return state;
  }
  test("BPT comes from virtual balances; zero seed legs stay sidelined", () => {
    const state = unseeded(); const c = client(state);
    const q = result(c.quoteSeedDeposit(creator, [bn(10_000_000), bn(0)], 0));
    // Native Rust calculate_invariant([1e9,2e9],[5000,5000],[9,9]).
    expect(q.bptOut.toString()).toBe("1414213");
    expect(q.depositAmounts.map(String)).toEqual(["10000000", "0"]);
    expect(q.refundAmounts.map(String)).toEqual(["0", "0"]);
    expect(result(c.quoteSeedDeposit(creator, [bn(1), bn(0)], 0)).bptOut.toString()).toBe("1414213");
  });
  test("rejects another wallet, disabled admin, zero seed, existing supply and bad u64", () => {
    const state = unseeded(); const c = client(state);
    expect(c.quoteSeedDeposit(key(91), [bn(1), bn(0)]).ok).toBe(false);
    expect(c.quoteSeedDeposit(creator, [bn(0), bn(0)]).ok).toBe(false);
    expect(c.quoteSeedDeposit(creator, [bn(U64_MAX + 1n), bn(0)]).ok).toBe(false);
    state.poolAdmin = PublicKey.default; expect(c.quoteSeedDeposit(creator, [bn(1), bn(0)]).ok).toBe(false);
    state.poolAdmin = creator; state.bptTotalSupply = bn(1);
    expect(c.quoteSeedDeposit(creator, [bn(1), bn(0)]).ok).toBe(false);
  });
});

function surgePool(): PoolInfo {
  const state = pool(3); state.swapFeeRate = 5000; state.protocolFeeRate = 2000;
  state.tokens.forEach((t, i) => {
    t.actualBalance = bn((i + 1) * 1_000_000_000);
    t.virtualBalance = bn((i + 4) * 1_000_000_000);
    t.protocolFeesOwed = bn([30_000_000, 90_000_000, 120_000_000][i]);
  });
  Object.assign(state.tokens[0], {
    maxSelloffPct: 2000, maxSelloffPeriodLength: 60,
    variableFeeThresholdPct: 6000, variableFeeSlopeLowPct: 100,
    variableFeeSlopeMidPct: 1800, variableFeeSlopeHighPct: 8000, variableFeeKinkPct: 75,
    previousSelloff: bn(300_000_000), currentSelloff: bn(350_000_000),
    windowStartTimestamp: bn(10000), selloffVbSnapshot: bn(4_000_000_000),
  });
  return state;
}

describe("sequential STLD quote with v5 selloff state", () => {
  // Constants were generated with native Rust math from contract 96a2ee2:
  // compute_allocations -> two swap.rs fee/surge/window updates -> helper cap
  // -> cubic_pool proportional join. The route crosses the 75% window kink.
  const vectors = [
    { dust: [0, 0, 0], deposit: [67970811, 112081355, 168361406], refund: [4492958, 16562742, 2], bpt: 60289416 },
    { dust: [1000000, 500000, 0], deposit: [67970811, 112081355, 168361406], refund: [5492958, 17062742, 2], bpt: 60289416 },
    { dust: [0, 0, 500000], deposit: [68172671, 112414215, 168861406], refund: [4291098, 16229882, 2], bpt: 60468464 },
  ];
  test.each(vectors)("native Rust route with helper dust $dust", ({ dust, deposit, refund, bpt }) => {
    const state = surgePool(); const before = JSON.stringify(state);
    const q = result(client(state).quoteSingleTokenDeposit(0, bn(200_000_000), 0, 10030, dust.map(bn)));
    expect(q.allocations.map(String)).toEqual(["72463769", "69565217", "57971014"]);
    expect(q.expectedOuts.map(String)).toEqual(["0", "128644097", "168361408"]);
    expect(q.depositedAmounts.map(String)).toEqual(deposit.map(String));
    expect(q.refundAmounts.map(String)).toEqual(refund.map(String));
    expect(q.estimatedBpt.toString()).toBe(String(bpt));
    expect(JSON.stringify(state)).toBe(before);
  });
  test.each([-1, 0.5, NaN, Infinity, 3])("invalid STLD index %s never throws", (index) => {
    expect(client(surgePool()).quoteSingleTokenDeposit(index, bn(1000)).ok).toBe(false);
  });
  test("pool and swaps must be enabled even if all non-input slots are sidelined", () => {
    const state = pool(); state.tokens[1].actualBalance = bn(0); const c = client(state);
    state.poolEnabled = false; expect(c.quoteSingleTokenDeposit(0, bn(1000)).ok).toBe(false);
    state.poolEnabled = true; state.swapsEnabled = false; expect(c.quoteSingleTokenDeposit(0, bn(1000)).ok).toBe(false);
  });
  test.each(["0", "-1", "1", (U64_MAX + 1n).toString()])("STLD amount %s is invalid or cannot fund every live allocation", (amount) => {
    expect(client(surgePool()).quoteSingleTokenDeposit(0, bn(amount)).ok).toBe(false);
  });
  test("rejects malformed, negative and overflowing existing helper balances", () => {
    const c = client(surgePool());
    for (const dust of [[bn(0)], [bn(-1), bn(0), bn(0)], [bn(U64_MAX), bn(0), bn(0)], [bn(0), bn(U64_MAX), bn(0)]]) {
      expect(c.quoteSingleTokenDeposit(0, bn(200_000_000), 0, 10030, dust).ok).toBe(false);
    }
  });
  test("requires a complete selloff state and enforces the cap without mutating cache", () => {
    const state = surgePool(); const c = client(state); const before = JSON.stringify(state);
    expect(c.quoteSingleTokenDeposit(0, bn(2_000_000_000)).ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
    state.tokens[0].previousSelloff = undefined;
    expect(c.quoteSingleTokenDeposit(0, bn(200_000_000)).ok).toBe(false);
  });
  test("a donated unsupported sidelined token is rejected because refund must transfer it", () => {
    const state = pool(); state.tokens[1].actualBalance = bn(0);
    state.tokens[1].extensions = [MintExtension.TransferFeeConfig];
    state.tokens[1].unsupportedExtensions = [MintExtension.TransferFeeConfig];
    const c = client(state);
    expect(c.quoteSingleTokenDeposit(0, bn(1000)).ok).toBe(true);
    expect(c.quoteSingleTokenDeposit(0, bn(1000), 0, 10030, [bn(0), bn(1)]).ok).toBe(false);
  });
});
