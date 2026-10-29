/**
 * v6.1 (T22) strict leverage invariant: `math/leverage.ts` parity with the
 * Rust rule (fixtures cite `v61_leverage_invariant.rs`), the T22 exit
 * normalisation, the create-pool / seed / fund gates in the builders and
 * quotes, the planner guards, `rescale_virtual_balances` (raw builder,
 * AdminClient wrapper, cooldown kind 13, Treasury slot @1499) and the
 * `leverage_invariant` error code.
 */
import { AnchorProvider, BorshCoder, Idl, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import vectors from "./fixtures/leverage/t22-vectors.json";
import {
  applyRescale, assertLeverageInvariant, assertVirtualFloor, checkFundLeverage, checkLeverage, checkSeedLeverage, leverageHolds, leverageViolations,
  minRescaleMultiplier, minVirtualBalance, virtualFloorViolations,
} from "../src/math/leverage";
import { virtualBalanceAfterWithdrawal } from "../src/math/poolMath";
import { MathError } from "../src/math/fixedPoint";
import { quoteZap, replay, swapInPool, validateQuotePool, QuotePool } from "../src/math/planner";
import { SwapLeg } from "../src/math/swapSim";
import { MAX_TOKEN_DECIMALS, MIN_VIRTUAL_BALANCE_ABS, MIN_VIRTUAL_RESCALE_MULTIPLIER } from "../src/config";
import { IDLS } from "../src/idl";
import {
  buildFundSidelinedTokenIx, buildInitializePoolIx, buildRescaleVirtualBalancesIx, buildSeedLiquidityIx, buildSetHookDisabledIx, buildSwapIx, buildAddLiquidityIx,
} from "../src/clients/tx-builders";
import { buildAtomicDeploy, DeployBuildConnection, POOL_CONFIG_DISCRIMINATOR, POOL_CONFIG_LEN } from "../src/clients/atomicDeploy";
import { AdminClient, rescaleMultiplierArg } from "../src/clients/AdminClient";
import { ProtocolActions, protocolActionKindOf, PROTOCOL_EXECUTE_INSTRUCTIONS } from "../src/clients/cooldown";
import { PROTOCOL_ACTION_KINDS, PROTOCOL_ACTION_KIND, TREASURY_LAYOUT } from "../src/parsers/layout";
import { decodeTreasuryAccount, TREASURY_DISCRIMINATOR } from "../src/parsers/treasuryAccount";
import { CofferPoolClient } from "../src/clients/CofferPoolClient";
import { describeProgramError, toSdkError } from "../src/utils/errors";
import { LP_METADATA_GOOD } from "../src/utils/lpMetadata";
import { mockPool, cfg, pk } from "./helpers/poolFixture";
import type { PoolInfo } from "../src/types/pool";

const big = (s: string) => BigInt(s);
const clientFor = (pool: PoolInfo) => { const c = new CofferPoolClient({ config: cfg, poolAddress: pool.address }); (c as unknown as { cache: PoolInfo }).cache = pool; return c; };
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: { code: string; humanMessage: string } }): T => { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.humanMessage}`); return r.data; };
const fail = <T>(r: { ok: true; data: T } | { ok: false; error: { code: string; humanMessage: string } }) => { if (r.ok) throw new Error("expected a failure"); return r.error; };
const noWindow = { previousSelloff: 0n, currentSelloff: 0n, windowStartTimestamp: 0n, selloffVbSnapshot: 0n };
const noCurve = { thresholdPct: 0, slopeLowPct: 0, slopeMidPct: 0, slopeHighPct: 0, kinkPct: 0 };
const leg = (actual: bigint, virtual: bigint, weight = 5000): SwapLeg => ({ virtualBalance: virtual, actualBalance: actual, protocolFeesOwed: 0n, weightBps: BigInt(weight), isActive: true, maxSelloffPct: 0, maxSelloffPeriodLength: 0, curve: { ...noCurve }, window: { ...noWindow }, transferFee: null });
const quotePool = (legs: SwapLeg[]): QuotePool => ({ tokens: legs, lpSupply: 1_000_000_000n, swapFeeRate: 0, protocolFeeRate: 0, now: 100n });
const RESCALE_DISC = "dc51a090bd46a9eb", SET_HOOK_DISABLED_DISC = "f78c7bef72feba57";
const PA_RESCALE_DISC = "0a4f4de6e300d077", PA_EXECUTE_RESCALE_DISC = "7afb910c6574e63b";

// ── positive ────────────────────────────────────────────────────────────────

describe("PoolMath::check_leverage parity (fixtures from v61_leverage_invariant.rs)", () => {
  test("[P01] every checkLeverage vector", () => {
    for (const v of vectors.checkLeverage) {
      expect(leverageHolds(big(v.virtual), big(v.actual))).toBe(v.ok);
      if (v.ok) expect(() => checkLeverage(big(v.virtual), big(v.actual))).not.toThrow();
      else expect(() => checkLeverage(big(v.virtual), big(v.actual))).toThrow(/VirtualBalanceNotAboveActual/);
    }
  });
  test("[P02] minVirtualBalance = max(10^decimals, 1000), clamped at 18 decimals", () => {
    for (const v of vectors.minVirtualBalance) expect(minVirtualBalance(v.decimals).toString()).toBe(v.expected);
    expect(MIN_VIRTUAL_BALANCE_ABS).toBe(1_000n); expect(MAX_TOKEN_DECIMALS).toBe(18); expect(MIN_VIRTUAL_RESCALE_MULTIPLIER).toBe(2n);
  });
  test("[P03] the per-slot floor sweep (assert_virtual_floor) and its violation list", () => {
    for (const v of vectors.virtualFloor) {
      expect(virtualFloorViolations(v.virtual.map(big), v.decimals)).toEqual(v.violations);
      if (v.ok) expect(() => assertVirtualFloor(v.virtual.map(big), v.decimals)).not.toThrow();
      else expect(() => assertVirtualFloor(v.virtual.map(big), v.decimals)).toThrow(/VirtualBalanceBelowFloor/);
    }
  });
  test("[P04] the seed gate accepts the boundary (net = V − 1) and sidelined slots", () => {
    for (const v of vectors.seedGate.filter((x) => x.ok)) expect(() => checkSeedLeverage(v.virtual.map(big), v.net.map(big))).not.toThrow();
  });
  test("[P05] the fund gate accepts net = V − 1", () => {
    for (const v of vectors.fundGate.filter((x) => x.ok)) expect(() => checkFundLeverage(big(v.virtual), big(v.net))).not.toThrow();
  });
  test("[P06] the exit normalisation: boundary → A' + 1, off the boundary byte-identical to the v6 floor, sidelined legs unchanged", () => {
    for (const v of vectors.exitNormalisation) {
      expect(virtualBalanceAfterWithdrawal(big(v.virtual), big(v.actual), big(v.payout), big(v.burned), big(v.supply)).toString()).toBe(v.expected);
    }
  });
  test("[P07] a guard sweep ignores slots past token_count and lists every violating slot", () => {
    expect(leverageViolations([2n, 2n, 0n], [1n, 1n, 5n], 2)).toEqual([]);
    expect(() => assertLeverageInvariant([2n, 2n, 0n], [1n, 1n, 5n], 2)).not.toThrow();
    expect(leverageViolations([1n, 5n, 3n, 9n], [1n, 2n, 3n, 8n])).toEqual([0, 2]);
  });
  test("[P08] rescale: price-neutral repair, the mainnet dust pool by 1e9, repaired slots reported", () => {
    for (const v of vectors.rescale.filter((x) => x.ok)) {
      const r = applyRescale(v.virtual.map(big), v.actual.map(big), big(v.multiplier), v.decimals);
      expect(r.newVirtualBalances.map(String)).toEqual(v.expected); expect(r.repairedSlots).toEqual(v.repaired);
      const old = v.virtual.map(big);
      for (let i = 0; i < old.length; i++) for (let j = 0; j < old.length; j++) expect(r.newVirtualBalances[i] * old[j]).toBe(old[i] * r.newVirtualBalances[j]);
    }
  });
  test("[P09] minRescaleMultiplier is the smallest repairing m (leverage AND floor), and applyRescale accepts it", () => {
    const virtual = [1n, 13_099n, 2n, 50n, 3_000n, 9n, 777n], actual = [1n, 200n, 0n, 10n, 100n, 8n, 0n], decimals = Array(7).fill(9);
    const m = minRescaleMultiplier(virtual, actual, decimals)!;
    expect(m).toBe(1_000_000_000n);
    expect(() => applyRescale(virtual, actual, m, decimals)).not.toThrow();
    expect(() => applyRescale(virtual, actual, m - 1n, decimals)).toThrow(/VirtualBalanceBelowFloor/);
    expect(minRescaleMultiplier([1n, 10n], [5n, 2n])).toBe(6n);
    expect(minRescaleMultiplier([3n, 3n], [1n, 1n])).toBe(2n);
    expect(minRescaleMultiplier([1n, 1n], [0n, 0n], [0, 0])).toBe(1_000n);
  });
  test("[P10] the round trip from V = A + 1 keeps the strict invariant through a bumped exit (t22_pos_11)", () => {
    // exit from V = 101, A = 100 by half: normalised to A' + 1; a later proportional deposit grows the gap again
    let v = 101n, a = 100n;
    for (let i = 0; i < 20; i++) {
      v = virtualBalanceAfterWithdrawal(v, a, 50n, 500n, 1_000n); a -= 50n;
      expect(v > a).toBe(true);
      v += (v * 50n + a - 1n) / a; a += 50n; // ceil(V·c/A)
      expect(v > a).toBe(true);
    }
    expect(v <= 121n && a <= 120n).toBe(true);
  });
});

describe("planner guards (QuotePool::from_pool, swap and join post-guards)", () => {
  test("[P11] a levered pool quotes; validateQuotePool passes", () => {
    const p = quotePool([leg(1_000_000_000n, 2_000_000_000n), leg(1_000_000_000n, 2_000_000_000n)]);
    expect(() => validateQuotePool(p)).not.toThrow();
    const q = quoteZap(p, 0, 50_000_000n);
    expect(q.stateAfter.tokens.every((t) => t.virtualBalance > t.actualBalance)).toBe(true);
    const r = swapInPool(p, 0, 1, 1_000_000n);
    expect(r.pool.tokens[0].virtualBalance - r.pool.tokens[0].actualBalance).toBe(1_000_000_000n);
    expect(r.pool.tokens[1].virtualBalance - r.pool.tokens[1].actualBalance).toBe(1_000_000_000n);
  });
  test("[P12] a swap preserves V − A on both legs exactly (t22_pos_05) for fee / no-fee pools", () => {
    for (const [fee, proto] of [[0, 0], [3000, 1000], [50_000, 10_000]]) {
      const p = { ...quotePool([leg(700_000_000n, 2_000_000_000n), leg(999_999_999n, 1_000_000_000n)]), swapFeeRate: fee, protocolFeeRate: proto };
      const r = swapInPool(p, 0, 1, 123_456_789n);
      expect(r.pool.tokens[0].virtualBalance - r.pool.tokens[0].actualBalance).toBe(1_300_000_000n);
      expect(r.pool.tokens[1].virtualBalance - r.pool.tokens[1].actualBalance).toBe(1n);
    }
  });
});

describe("builders and quotes mirror the gates", () => {
  const admin = pk();
  test("[P13] initialize_pool accepts virtual balances at the floor when decimals are given; omitted decimals skip the floor", () => {
    const base = { payer: pk(), configKey: pk(), poolId: new BN(1), tokens: [pk(), pk()], weightsBps: [5000, 5000], swapFeeRate: 3000, lpMetadata: LP_METADATA_GOOD };
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN(1_000_000), new BN(1_000)], tokenDecimals: [6, 0] })).not.toThrow();
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN(1_000_000), new BN(1_000)], tokenDecimals: [6, 3] })).not.toThrow();
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN(1), new BN(1)] })).not.toThrow();
  });
  test("[P14] seed_liquidity accepts net = V − 1 and zero (sidelined) slots; fund accepts net = V − 1", () => {
    const pool = mockPool({ lpSupply: 0n, poolAdmin: admin, balances: [[0n, 1_000n], [0n, 1_000n], [0n, 7n]] });
    expect(() => buildSeedLiquidityIx(cfg, pool, { user: admin, tokenAmounts: [new BN(999), new BN(0), new BN(6)], lpAmount: new BN("1000000000") })).not.toThrow();
    const seeded = mockPool({ poolAdmin: admin, balances: [[1n, 2n], [0n, 1_000n]] });
    expect(() => buildFundSidelinedTokenIx(cfg, seeded, { authority: admin, tokenIndex: 1, amount: new BN(999) })).not.toThrow();
  });
  test("[P15] seed / fund gates net the Token-2022 transfer fee first (gross may equal V when the net is below it)", () => {
    const pool = mockPool({ lpSupply: 0n, poolAdmin: admin, balances: [[0n, 1_000n], [0n, 1_000n]] });
    pool.tokens[0].transferFee = { epoch: 0n, maximumFee: 1_000_000n, transferFeeBasisPoints: 100 };
    expect(() => buildSeedLiquidityIx(cfg, pool, { user: admin, tokenAmounts: [new BN(1_000), new BN(1)], lpAmount: new BN("1000000000") })).not.toThrow();
    const q = ok(clientFor(pool).quoteSeedDeposit(admin, [new BN(1_000), new BN(1)], 1_000_000_000n));
    expect(q.creditedAmounts[0].toNumber()).toBe(990);
    const seeded = mockPool({ poolAdmin: admin, balances: [[1n, 2n], [0n, 1_000n]] });
    seeded.tokens[1].transferFee = { epoch: 0n, maximumFee: 1_000_000n, transferFeeBasisPoints: 100 };
    const f = ok(clientFor(seeded).quoteFundSidelinedToken(admin, 1, new BN(1_000)));
    expect(f.amountCredited.toNumber()).toBe(990); expect(f.transferFee.toNumber()).toBe(10); expect(f.maxAmountNet.toNumber()).toBe(999); expect(f.actualAfter.toNumber()).toBe(990);
  });
  test("[P16] quoteFundSidelinedToken on a plain mint: credited = charged, actualAfter = net", () => {
    const seeded = mockPool({ poolAdmin: admin, balances: [[1n, 2n], [0n, 1_000n]] });
    const f = ok(clientFor(seeded).quoteFundSidelinedToken(admin, 1, new BN(999)));
    expect(f.amountCharged.toNumber()).toBe(999); expect(f.amountCredited.toNumber()).toBe(999); expect(f.transferFee.isZero()).toBe(true); expect(f.virtualBalance.toNumber()).toBe(1_000);
  });
  test("[P17] sync-style PoolInfo exposes leverageViolations; a compliant pool quotes swaps and joins", () => {
    const pool = mockPool();
    expect(pool.leverageViolations).toEqual([]);
    const c = clientFor(pool);
    expect(c.quoteSwap(0, 1, new BN(1_000)).ok).toBe(true);
    expect(c.quoteAddLiquidity([new BN(1_000), new BN(1_000)]).ok).toBe(true);
    expect(c.quoteRemove(new BN(1_000_000)).ok).toBe(true);
  });
  test("[P18] quoteRescaleVirtualBalances previews the repair (default = the smallest multiplier) and reports the repaired slots", () => {
    const pool = mockPool({ balances: [[1n, 1n], [200n, 13_099n], [0n, 2n]], decimals: [9, 9, 9] });
    const c = clientFor(pool);
    const q = ok(c.quoteRescaleVirtualBalances());
    expect(q.multiplier.toString()).toBe("1000000000"); expect(q.minMultiplier!.toString()).toBe("1000000000");
    expect(q.newVirtualBalances.map(String)).toEqual(["1000000000", "13099000000000", "2000000000"]); expect(q.repairedSlots).toEqual([0]);
    const explicit = ok(c.quoteRescaleVirtualBalances(new BN("10000000000")));
    expect(explicit.newVirtualBalances[0].toString()).toBe("10000000000");
  });
  test("[P19] exits are never gated: quoteRemove on a V ≤ A pool works and normalises V to A' + 1", () => {
    const pool = mockPool({ balances: [[1_000n, 1_000n], [1_000n, 1_000n]], lpSupply: 1_000_000n });
    expect(pool.leverageViolations).toEqual([0, 1]);
    const q = ok(clientFor(pool).quoteRemove(new BN(500_000)));
    expect(q.virtualBalancesAfter.map(String)).toEqual(["501", "501"]);
  });
  test("[P20] the raw rescale_virtual_balances / set_hook_disabled builders use the pinned discriminators and [config, pool w, authority s]", () => {
    const config = pk(), pool = pk(), authority = pk();
    const r = buildRescaleVirtualBalancesIx(cfg, config, pool, authority, 1_000_000_000n);
    expect(r.data.subarray(0, 8).toString("hex")).toBe(RESCALE_DISC); expect(r.data.length).toBe(16); expect(r.data.readBigUInt64LE(8)).toBe(1_000_000_000n);
    expect(r.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([[config.toBase58(), false, false], [pool.toBase58(), false, true], [authority.toBase58(), true, false]]);
    const h = buildSetHookDisabledIx(cfg, config, pool, authority, true);
    expect(h.data.subarray(0, 8).toString("hex")).toBe(SET_HOOK_DISABLED_DISC); expect([...h.data.subarray(8)]).toEqual([1]);
    expect(h.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([[false, false], [false, true], [true, false]]);
    expect(buildRescaleVirtualBalancesIx(cfg, config, pool, authority, new BN(2)).data.readBigUInt64LE(8)).toBe(2n);
    expect(buildRescaleVirtualBalancesIx(cfg, config, pool, authority, 7).data.readBigUInt64LE(8)).toBe(7n);
  });
  test("[P21] AdminClient wrappers: pool_rescale_virtual_balances carries the u64 and execute takes no args; both CPI into coffer_pool", async () => {
    const admin = Keypair.generate();
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(admin), {}) });
    const config = pk(), pool = pk();
    const ix = await client.poolRescaleVirtualBalancesIx(admin.publicKey, config, pool, 1_000_000_000n);
    expect(ix.data.subarray(0, 8).toString("hex")).toBe(PA_RESCALE_DISC); expect(ix.data.readBigUInt64LE(8)).toBe(1_000_000_000n);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([client.treasuryPda, admin.publicKey, config, pool, cfg.programs.cofferPool].map((k) => k.toBase58()));
    expect(ix.keys[1].isSigner).toBe(true); expect(ix.keys[3].isWritable).toBe(true);
    const ex = await client.executePoolRescaleVirtualBalancesIx(admin.publicKey, config, pool);
    expect(ex.data.subarray(0, 8).toString("hex")).toBe(PA_EXECUTE_RESCALE_DISC); expect(ex.data.length).toBe(8);
    expect(ex.keys[0].isWritable).toBe(true);
    expect(rescaleMultiplierArg(2).toString()).toBe("2");
  });
  test("[P22] cooldown kind 13: ProtocolAction tag 12, execute table, Treasury slot @1499 (48 B) and reserve 77 B @1547", () => {
    const action = ProtocolActions.poolRescaleVirtualBalances(pk(), 1_000_000_000n);
    expect(protocolActionKindOf(action)).toBe(13); expect(PROTOCOL_ACTION_KIND.PoolRescaleVirtualBalances).toBe(13); expect(PROTOCOL_ACTION_KINDS[13]).toBe("PoolRescaleVirtualBalances");
    const coder = new BorshCoder(IDLS.protocolAdmin as unknown as Idl);
    const encoded = coder.types.encode("ProtocolAction", action);
    expect(encoded[0]).toBe(12); expect(encoded.length).toBe(1 + 32 + 8);
    expect(PROTOCOL_EXECUTE_INSTRUCTIONS.PoolRescaleVirtualBalances).toEqual(["execute_pool_rescale_virtual_balances"]);
    expect(TREASURY_LAYOUT.PENDING_POOL_RESCALE_VIRTUAL_BALANCES).toEqual({ offset: 1499, size: 48 });
    expect(TREASURY_LAYOUT.RESERVED_V61).toEqual({ offset: 1547, size: 77 });
    const pending = (IDLS.protocolAdmin as any).types.find((t: any) => t.name === "PendingPoolRescale").type.fields.map((f: any) => `${f.name}:${f.type}`);
    expect(pending).toEqual(["eta:i64", "pool:pubkey", "multiplier:u64"]);
    const treasury = (IDLS.protocolAdmin as any).types.find((t: any) => t.name === "Treasury").type.fields;
    expect(treasury.at(-2).name).toBe("pending_pool_rescale_virtual_balances"); expect(treasury.at(-1).type).toEqual({ array: ["u8", 77] });
  });
  test("[P23] decodeTreasuryAccount reads the kind-13 slot {pool, multiplier} and sets bit 13 of the mask", () => {
    const b = Buffer.alloc(1624); TREASURY_DISCRIMINATOR.copy(b, 0);
    const off = TREASURY_LAYOUT.PENDING_POOL_RESCALE_VIRTUAL_BALANCES.offset;
    const pool = pk();
    b.writeBigInt64LE(1_800_000_000n, off); pool.toBuffer().copy(b, off + 8); b.writeBigUInt64LE(1_000_000_000n, off + 40);
    const t = decodeTreasuryAccount(b);
    expect(t.pendingActions[13].name).toBe("PoolRescaleVirtualBalances"); expect((t.pendingActions[13].payload.pool as PublicKey).equals(pool)).toBe(true);
    expect(t.pendingActions[13].payload.multiplier!.toString()).toBe("1000000000"); expect(t.pendingActionsMask).toBe(1 << 13); expect(t.reservedV61NonZero).toBe(false);
  });
  test("[P24] buildAtomicDeploy reads the mint decimals and accepts a floor-compliant deploy; explicit tokenDecimals are honoured", async () => {
    const mints = [pk(), pk()], config = pk();
    const conn = fakeConnection(config, new Map(mints.map((m, i) => [m.toBase58(), [6, 9][i]])));
    const base = { payer: pk(), config, mints, weights: [new BN(5000), new BN(5000)], virtualBalances: [new BN(1_000_000), new BN(1_000_000_000)], swapFeeRate: 3000, seedAmounts: [new BN(999_999), new BN(1_000)], lpMetadata: LP_METADATA_GOOD, poolId: new BN(7) };
    await expect(buildAtomicDeploy(cfg, conn, base)).resolves.toBeDefined();
    await expect(buildAtomicDeploy(cfg, conn, { ...base, tokenPrograms: [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID], tokenDecimals: [6, 9] })).resolves.toBeDefined();
  });
  test("[P25] the error map: 6104 / 6105 are leverage_invariant with actionable messages, 6106 invalid_input", () => {
    expect(describeProgramError(6104)?.sdkCode).toBe("leverage_invariant"); expect(describeProgramError(6105)?.sdkCode).toBe("leverage_invariant"); expect(describeProgramError(6106)?.sdkCode).toBe("invalid_input");
    expect(toSdkError(new Error("Error Number: 6104")).humanMessage).toMatch(/rescale_virtual_balances/);
    expect(toSdkError(new Error("custom program error: 0x17d9")).humanMessage).toMatch(/10\^decimals/); // 6105
    expect(toSdkError(new Error("custom program error: 0x17da")).code).toBe("invalid_input"); // 6106
  });
});

// ── negative ────────────────────────────────────────────────────────────────

describe("refusals", () => {
  const admin = pk();
  test("[N01] checkLeverage refuses V == A and V < A (incl. u64::MAX and zeros) and non-u64 inputs", () => {
    for (const v of vectors.checkLeverage.filter((x) => !x.ok)) expect(() => checkLeverage(big(v.virtual), big(v.actual))).toThrow(/VirtualBalanceNotAboveActual/);
    expect(() => checkLeverage(-1n, 0n)).toThrow(); expect(() => checkLeverage(1n << 64n, 0n)).toThrow();
  });
  test("[N02] the seed gate rejects net == V and net > V on any slot; a length mismatch is InvalidArrayLength", () => {
    for (const v of vectors.seedGate.filter((x) => !x.ok)) expect(() => checkSeedLeverage(v.virtual.map(big), v.net.map(big))).toThrow(new RegExp(v.error!));
  });
  test("[N03] the fund gate rejects net == V and net > V", () => {
    for (const v of vectors.fundGate.filter((x) => !x.ok)) expect(() => checkFundLeverage(big(v.virtual), big(v.net))).toThrow(/VirtualBalanceNotAboveActual/);
  });
  test("[N04] rescale rejections: m < 2, overflow, floor, leverage, zero virtual — nothing is returned", () => {
    for (const v of vectors.rescale.filter((x) => !x.ok)) {
      expect(() => applyRescale(v.virtual.map(big), v.actual.map(big), big(v.multiplier), v.decimals)).toThrow(new RegExp(v.error!));
    }
    expect(minRescaleMultiplier([0n, 5n], [0n, 1n])).toBeNull();
    expect(minRescaleMultiplier([1n << 63n, 5n], [1n, 1n])).toBeNull();
    expect(() => applyRescale([1n], [1n, 2n], 2n)).toThrow(/InvalidArrayLength/);
  });
  test("[N05] minVirtualBalance refuses negative / fractional decimals; the floor sweeps refuse short decimals", () => {
    expect(() => minVirtualBalance(-1)).toThrow(/InvalidTokenDecimals/); expect(() => minVirtualBalance(1.5)).toThrow(/InvalidTokenDecimals/);
    expect(() => assertVirtualFloor([1n, 1n], [0])).toThrow(/InvalidArrayLength/);
    expect(() => leverageViolations([1n], [1n, 1n], 2)).toThrow(/InvalidArrayLength/);
  });
  test("[N06] the planner refuses a pool that already violates the invariant (QuotePool::from_pool)", () => {
    const p = quotePool([leg(1_000_000_000n, 1_000_000_000n), leg(1_000_000_000n, 2_000_000_000n)]);
    expect(() => validateQuotePool(p)).toThrow(/VirtualBalanceNotAboveActual/);
    expect(() => quoteZap(p, 0, 1_000_000n)).toThrow(/VirtualBalanceNotAboveActual/);
    expect(() => replay(p, 0, 1_000_000n, [500_000n, 500_000n])).toThrow(/VirtualBalanceNotAboveActual/);
    expect(() => swapInPool(p, 1, 0, 1_000_000n)).toThrow(/VirtualBalanceNotAboveActual/);
  });
  test("[N07] a swap INTO a slot at V = A + 1 keeps the gap (passes); a swap out of a slot at V ≤ A fails the post-guard", () => {
    const p = quotePool([leg(999_999_999n, 1_000_000_000n), leg(500_000_000n, 1_000_000_000n)]);
    expect(() => swapInPool(p, 1, 0, 1_000n)).not.toThrow();
    const bad = quotePool([leg(1_000_000_000n, 1_000_000_000n), leg(500_000_000n, 1_000_000_000n)]);
    expect(() => swapInPool(bad, 0, 1, 1_000n)).toThrow(/VirtualBalanceNotAboveActual/);
  });
  test("[N08] initialize_pool refuses a virtual balance below the floor for its decimals, zero / negative / overflowing values and a short decimals list", () => {
    const base = { payer: pk(), configKey: pk(), poolId: new BN(1), tokens: [pk(), pk()], weightsBps: [5000, 5000], swapFeeRate: 3000, lpMetadata: LP_METADATA_GOOD };
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN(999_999), new BN(1_000)], tokenDecimals: [6, 0] })).toThrow(/VirtualBalanceBelowFloor/);
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN(1_000_000), new BN(999)], tokenDecimals: [6, 0] })).toThrow(/6105/);
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN("999999999999999999"), new BN(1_000)], tokenDecimals: [18, 0] })).toThrow(/VirtualBalanceBelowFloor/);
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN(0), new BN(1_000)] })).toThrow(/InvalidVirtualBalances/);
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN(-1), new BN(1_000)] })).toThrow(/unsigned/);
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN(1).shln(64), new BN(1_000)] })).toThrow(/unsigned/);
    expect(() => buildInitializePoolIx(cfg, { ...base, virtualBalances: [new BN(1_000_000), new BN(1_000)], tokenDecimals: [6] })).toThrow(/one entry per token/);
  });
  test("[N09] seed_liquidity refuses net == V / net > V (builder and quote), naming the slot and 6104", () => {
    const pool = mockPool({ lpSupply: 0n, poolAdmin: admin, balances: [[0n, 1_000n], [0n, 1_000n]] });
    expect(() => buildSeedLiquidityIx(cfg, pool, { user: admin, tokenAmounts: [new BN(1_000), new BN(1)], lpAmount: new BN("1000000000") })).toThrow(/slot 0.*6104/);
    expect(() => buildSeedLiquidityIx(cfg, pool, { user: admin, tokenAmounts: [new BN(1), new BN(5_000)], lpAmount: new BN("1000000000") })).toThrow(/slot 1/);
    const e = fail(clientFor(pool).quoteSeedDeposit(admin, [new BN(1_000), new BN(1)], 1_000_000_000n));
    expect(e.code).toBe("leverage_invariant"); expect(e.humanMessage).toMatch(/VirtualBalanceNotAboveActual/);
    // a 1 % fee mint nets 1_011 → 1_000 == V: still refused; 1_010 → 999 passes
    pool.tokens[0].transferFee = { epoch: 0n, maximumFee: 1_000_000n, transferFeeBasisPoints: 100 };
    expect(fail(clientFor(pool).quoteSeedDeposit(admin, [new BN(1_011), new BN(1)], 1_000_000_000n)).code).toBe("leverage_invariant");
    expect(clientFor(pool).quoteSeedDeposit(admin, [new BN(1_010), new BN(1)], 1_000_000_000n).ok).toBe(true);
  });
  test("[N10] fund_sidelined_token refuses net ≥ V (builder and quote); the quote also refuses a non-sidelined slot, a stranger, zero and an unseeded pool", () => {
    const seeded = mockPool({ poolAdmin: admin, balances: [[1n, 2n], [0n, 1_000n]] });
    expect(() => buildFundSidelinedTokenIx(cfg, seeded, { authority: admin, tokenIndex: 1, amount: new BN(1_000) })).toThrow(/6104/);
    expect(() => buildFundSidelinedTokenIx(cfg, seeded, { authority: admin, tokenIndex: 1, amount: new BN(5_000) })).toThrow(/VirtualBalanceNotAboveActual/);
    const c = clientFor(seeded);
    expect(fail(c.quoteFundSidelinedToken(admin, 1, new BN(1_000))).code).toBe("leverage_invariant");
    expect(fail(c.quoteFundSidelinedToken(admin, 0, new BN(1))).humanMessage).toMatch(/TokenNotSidelined/);
    expect(fail(c.quoteFundSidelinedToken(pk(), 1, new BN(1))).code).toBe("auth_failed");
    expect(fail(c.quoteFundSidelinedToken(admin, 1, new BN(0))).humanMessage).toMatch(/ZeroAmount/);
    expect(fail(c.quoteFundSidelinedToken(admin, 7, new BN(1))).humanMessage).toMatch(/InvalidTokenIndex/);
    expect(fail(clientFor(mockPool({ lpSupply: 0n, poolAdmin: admin, balances: [[0n, 2n], [0n, 1_000n]] })).quoteFundSidelinedToken(admin, 1, new BN(1))).humanMessage).toMatch(/PoolNotSeeded/);
  });
  test("[N11] swaps / joins / planned zaps on a legacy V ≤ A pool are leverage_invariant until rescaled; exits are not", () => {
    const pool = mockPool({ balances: [[1_000_000_000n, 1_000_000_000n], [1_000_000_000n, 2_000_000_000n]] });
    expect(pool.leverageViolations).toEqual([0]);
    const c = clientFor(pool);
    const s = fail(c.quoteSwap(0, 1, new BN(1_000)));
    expect(s.code).toBe("leverage_invariant"); expect(s.humanMessage).toMatch(/slot 0.*rescale_virtual_balances/);
    expect(fail(c.quoteSwap(1, 0, new BN(1_000))).code).toBe("leverage_invariant"); // the guard sweeps every slot
    expect(fail(c.quoteAddLiquidity([new BN(1_000), new BN(1_000)])).code).toBe("leverage_invariant");
    expect(fail(c.buildSwapTx({ user: pk(), tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1_000) })).code).toBe("leverage_invariant");
    expect(c.quoteRemove(new BN(1_000_000)).ok).toBe(true);
    // a snapshot without the field is computed on the fly
    const legacy = { ...pool }; delete (legacy as any).leverageViolations;
    expect(fail(clientFor(legacy).quoteSwap(0, 1, new BN(1_000))).code).toBe("leverage_invariant");
  });
  test("[N12] quoteRescaleVirtualBalances refuses m < 2, a non-repairing m, an overflowing m and a zero virtual balance", () => {
    const c = clientFor(mockPool({ balances: [[1n, 1n], [200n, 13_099n]], decimals: [9, 9] }));
    expect(fail(c.quoteRescaleVirtualBalances(1)).code).toBe("invalid_input");
    expect(fail(c.quoteRescaleVirtualBalances(0)).code).toBe("invalid_input");
    const floor = fail(c.quoteRescaleVirtualBalances(2));
    expect(floor.code).toBe("leverage_invariant"); expect(floor.humanMessage).toMatch(/VirtualBalanceBelowFloor.*smallest repairing multiplier: 1000000000/);
    expect(fail(c.quoteRescaleVirtualBalances(new BN("18446744073709551615"))).code).toBe("math_overflow");
    expect(fail(c.quoteRescaleVirtualBalances(new BN("18446744073709551616"))).code).toBe("invalid_input");
    expect(fail(clientFor(mockPool({ balances: [[1n, 5n], [1n, 0n]], decimals: [0, 0] })).quoteRescaleVirtualBalances()).code).toBe("unsupported_pool_state");
    const lev = fail(clientFor(mockPool({ balances: [[5_000n, 1n], [1n, 2_000n]], decimals: [0, 0] })).quoteRescaleVirtualBalances(1_000));
    expect(lev.code).toBe("leverage_invariant"); expect(lev.humanMessage).toMatch(/VirtualBalanceNotAboveActual.*smallest repairing multiplier: 5001/);
  });
  test("[N13] the raw rescale builder and the ProtocolAction constructor refuse m < 2, negatives and > u64", () => {
    for (const m of [0, 1, new BN(1)]) expect(() => buildRescaleVirtualBalancesIx(cfg, pk(), pk(), pk(), m)).toThrow(/InvalidVirtualRescale/);
    expect(() => buildRescaleVirtualBalancesIx(cfg, pk(), pk(), pk(), -3)).toThrow(/unsigned/);
    expect(() => buildRescaleVirtualBalancesIx(cfg, pk(), pk(), pk(), new BN(1).shln(64))).toThrow(/unsigned/);
    expect(() => ProtocolActions.poolRescaleVirtualBalances(pk(), 0)).toThrow(/InvalidVirtualRescale/);
    expect(() => rescaleMultiplierArg(1)).toThrow(/InvalidVirtualRescale/);
    expect(() => rescaleMultiplierArg(new BN(-1))).toThrow(/unsigned/);
    expect(() => buildSetHookDisabledIx(cfg, pk(), pk(), pk(), 1 as unknown as boolean)).toThrow(/boolean/);
  });
  test("[N14] buildAtomicDeploy refuses a seed amount ≥ its virtual balance and a virtual balance below the mint's floor", async () => {
    const mints = [pk(), pk()], config = pk();
    const conn = fakeConnection(config, new Map(mints.map((m, i) => [m.toBase58(), [6, 9][i]])));
    const base = { payer: pk(), config, mints, weights: [new BN(5000), new BN(5000)], virtualBalances: [new BN(1_000_000), new BN(1_000_000_000)], swapFeeRate: 3000, seedAmounts: [new BN(999_999), new BN(1_000)], lpMetadata: LP_METADATA_GOOD, poolId: new BN(7) };
    await expect(buildAtomicDeploy(cfg, conn, { ...base, seedAmounts: [new BN(1_000_000), new BN(1_000)] })).rejects.toThrow(/seedAmounts\[0\].*6104/);
    await expect(buildAtomicDeploy(cfg, conn, { ...base, virtualBalances: [new BN(1_000_000), new BN(999_999_999)] })).rejects.toThrow(/VirtualBalanceBelowFloor/);
    await expect(buildAtomicDeploy(cfg, conn, { ...base, tokenPrograms: [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID], tokenDecimals: [6, 9], virtualBalances: [new BN(999_999), new BN(1_000_000_000)], seedAmounts: [new BN(1), new BN(1_000)] })).rejects.toThrow(/VirtualBalanceBelowFloor/);
    // explicit tokenPrograms without decimals: no mint read, no floor check — the program is the backstop
    await expect(buildAtomicDeploy(cfg, conn, { ...base, tokenPrograms: [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID], virtualBalances: [new BN(999_999), new BN(1_000_000_000)], seedAmounts: [new BN(1), new BN(1_000)] })).resolves.toBeDefined();
    await expect(buildAtomicDeploy(cfg, conn, { ...base, tokenDecimals: [6] })).rejects.toThrow(/tokenDecimals length/);
  });
  test("[N15] the exit normalisation never produces V' ≤ A' on a live leg and refuses a payout that empties it", () => {
    for (const [v, a, p] of [[101n, 100n, 99n], [2n, 1n, 0n], [1_000n, 999n, 998n], [(1n << 64n) - 1n, (1n << 64n) - 1n, 1n]]) {
      const next = virtualBalanceAfterWithdrawal(v, a, p, 1n, 1_000n);
      expect(next > a - p).toBe(true);
    }
    expect(() => virtualBalanceAfterWithdrawal(101n, 100n, 100n, 1n, 1_000n)).toThrow(/InvalidAmounts/);
    expect(() => virtualBalanceAfterWithdrawal(0n, 100n, 1n, 1n, 1_000n)).toThrow(/InvalidVirtualBalances/);
  });
  test("[N16] the swap / add builders are raw: they do not gate leverage themselves (the client quotes do), but the join quote refuses the violating pool", () => {
    const pool = mockPool({ balances: [[1_000n, 1_000n], [1_000n, 2_000n]], lpSupply: 1_000_000n });
    expect(() => buildSwapIx(cfg, pool, { user: pk(), tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(10), minAmountOut: new BN(1) })).not.toThrow();
    expect(() => buildAddLiquidityIx(cfg, pool, { user: pk(), tokenAmounts: [new BN(10), new BN(10)], minimumLpAmount: new BN(1) })).not.toThrow();
    expect(fail(clientFor(pool).quoteAddLiquidity([new BN(10), new BN(10)])).code).toBe("leverage_invariant");
  });
  test("[N17] unknown error 6107 stays unknown; 6104 on protocol_admin is not a leverage error", () => {
    expect(describeProgramError(6107)).toBeUndefined();
    expect(describeProgramError(6104, "protocolAdmin")).toBeUndefined();
    expect(toSdkError(new Error("Error Number: 6104"), "protocolAdmin").code).toBe("unknown");
  });
});

function fakeConnection(configKey: PublicKey, decimals: Map<string, number>): DeployBuildConnection {
  return {
    async getMultipleAccountsInfo(keys) {
      return keys.map((k) => {
        if (k.equals(configKey)) return { owner: cfg.programs.cofferPool, data: Buffer.concat([POOL_CONFIG_DISCRIMINATOR, Buffer.alloc(POOL_CONFIG_LEN - 8)]), executable: false, lamports: 1 };
        const d = decimals.get(k.toBase58());
        if (d !== undefined) { const data = Buffer.alloc(82); data[44] = d; return { owner: TOKEN_PROGRAM_ID, data, executable: false, lamports: 1 }; }
        return null;
      });
    },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1_000 }; },
    async getBlockHeight() { return 900; },
    async getSlot() { return 123_456; },
  };
}
