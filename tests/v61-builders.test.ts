/**
 * v6.1 instruction builders: layout migration (L0), seed / fund-sidelined
 * (T2 / T10), initialize_pool with the appended arguments (T1 / T7 / T9 /
 * T14), the pool-admin setters (T3 / T6 / T7 / T14), bypass remove (T9).
 * Wire bytes are checked against the pinned discriminators.
 */
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  buildAddLiquidityTx, buildSwapTx, buildRemoveLiquidityTx, buildRemoveLiquidityIx, buildRemoveLiquidityBypassHooksIx,
  buildSeedLiquidityIx, buildSeedLiquidityRawIx, buildSeedLiquidityTx, buildFundSidelinedTokenIx, buildFundSidelinedTokenTx,
  buildMigratePoolLayoutV61Ix, prependLayoutMigration, buildInitializePoolIx, buildDeployPoolTx, buildSetSwapsEnabledIx,
  buildSetCreatorFeeBpsIx, buildSetLiquidityFeesIx, buildLockLiquidityFeesIx, buildLockRangeManagerIx, buildSetPoolAdminDelayIx,
} from "../src/clients/tx-builders";
import { PoolLayoutOutdatedError, DeployPoolParamsV61 } from "../src/types/tx-v61";
import { encodeLpMetadataArgs, LP_METADATA_GOOD } from "../src/utils/lpMetadata";
import { hookAccountSliceFor, encodeHookConfig } from "../src/utils/hooks";
import { HOOK_FLAGS, MIN_INITIAL_LP_SUPPLY, MAX_INITIAL_LP_SUPPLY, DEFAULT_INITIAL_LP_SUPPLY } from "../src/config";
import { deriveAta, deriveLpMint, derivePoolPda } from "../src/utils/pda";
import { mockPool, cfg, pk } from "./helpers/poolFixture";

const DISC = {
  migrate: "9408318da470c1c7", seed: "b4395e2349300d0b", fund: "103bfef8cb10bcc2", setCreator: "9c0a977111fab10d",
  lockRange: "fd1d12cec0dece9b", setLiq: "1d1b91f9fa1bce18", lockLiq: "83f537885078fe72", setDelay: "21e7c161237d218c",
  bypass: "6182e9862d4f6f24", setSwaps: "909acd3af1a94028", initPool: "5fb40aac54aee828", remove: "5055d14818ceb16c",
};
const disc = (data: Buffer) => data.subarray(0, 8).toString("hex");
const isCb = (ix: { programId: PublicKey }) => ix.programId.equals(ComputeBudgetProgram.programId);

describe("migrate_pool_layout_v61 (L0)", () => {
  test("[P01] accounts [pool w, payer w s, system] + mints read-only, 8-byte data", () => {
    const pool = pk(), payer = pk(), mints = [pk(), pk(), pk()];
    const ix = buildMigratePoolLayoutV61Ix(cfg, { pool, payer, mints });
    expect(disc(ix.data)).toBe(DISC.migrate); expect(ix.data.length).toBe(8);
    expect(ix.keys.slice(0, 3).map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([[pool.toBase58(), false, true], [payer.toBase58(), true, true], [SystemProgram.programId.toBase58(), false, false]]);
    expect(ix.keys.slice(3).map((k) => k.pubkey.toBase58())).toEqual(mints.map((m) => m.toBase58()));
    expect(ix.keys.slice(3).every((k) => !k.isWritable && !k.isSigner)).toBe(true);
  });
  test("[P02] build*Tx prepend the migration on a layoutVersion-0 pool (payer = user), right after the CU ix", () => {
    const pool = mockPool({ layoutVersion: 0 }); const user = pk();
    for (const tx of [
      buildSwapTx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1000), minAmountOut: new BN(1) }),
      buildAddLiquidityTx(cfg, pool, { user, tokenAmounts: [new BN(1000), new BN(1000)], minimumLpAmount: new BN(1) }),
      buildRemoveLiquidityTx(cfg, pool, { user, lpAmount: new BN(1000), minimumTokenAmounts: [new BN(0), new BN(0)] }),
      buildFundSidelinedTokenTx(cfg, mockPool({ layoutVersion: 0, balances: [[1n, 1n], [0n, 1n]], poolAdmin: user }), { authority: user, tokenIndex: 1, amount: new BN(5) }),
    ]) {
      expect(isCb(tx.instructions[0])).toBe(true);
      expect(disc(tx.instructions[1].data)).toBe(DISC.migrate);
      expect(tx.instructions[1].keys[1].pubkey.equals(user)).toBe(true);
    }
  });
  test("[P03] no migration on a v6.1 pool or on a snapshot without layoutVersion", () => {
    const user = pk();
    const a = buildSwapTx(cfg, mockPool(), { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1000), minAmountOut: new BN(1) });
    expect(a.instructions.some((ix) => disc(ix.data) === DISC.migrate)).toBe(false);
    const legacy = mockPool(); delete (legacy as any).layoutVersion;
    const b = buildSwapTx(cfg, legacy, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1000), minAmountOut: new BN(1) });
    expect(b.instructions.some((ix) => disc(ix.data) === DISC.migrate)).toBe(false);
  });
  test("[P04] prependLayoutMigration is pure and only acts on layoutVersion 0", () => {
    const ix = buildSetSwapsEnabledIx(cfg, pk(), pk(), pk(), true);
    expect(prependLayoutMigration(cfg, mockPool(), pk(), [ix])).toEqual([ix]);
    const out = prependLayoutMigration(cfg, mockPool({ layoutVersion: 0 }), pk(), [ix]);
    expect(out.length).toBe(2); expect(disc(out[0].data)).toBe(DISC.migrate); expect(out[1]).toBe(ix);
  });
  test("[N01] autoMigrate: false throws PoolLayoutOutdatedError (code pool_layout_outdated)", () => {
    const pool = mockPool({ layoutVersion: 0 }); const user = pk();
    const run = () => buildSwapTx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1000), minAmountOut: new BN(1), autoMigrate: false });
    expect(run).toThrow(PoolLayoutOutdatedError);
    try { run(); } catch (e) { expect((e as PoolLayoutOutdatedError).code).toBe("pool_layout_outdated"); expect((e as Error).message).toMatch(/6070/); }
  });
  test("[N02] mint count outside 2..10 / tokenPrograms mismatch", () => {
    expect(() => buildMigratePoolLayoutV61Ix(cfg, { pool: pk(), payer: pk(), mints: [pk()] })).toThrow(/2\.\.10/);
    expect(() => buildMigratePoolLayoutV61Ix(cfg, { pool: pk(), payer: pk(), mints: Array.from({ length: 11 }, pk) })).toThrow(/2\.\.10/);
    expect(() => buildMigratePoolLayoutV61Ix(cfg, { pool: pk(), payer: pk(), mints: [pk(), pk()], tokenPrograms: [TOKEN_PROGRAM_ID] })).toThrow(/mismatch/);
  });
});

describe("seed_liquidity (T2 / T10)", () => {
  const admin = pk();
  const unseeded = (extra = {}) => mockPool({ lpSupply: 0n, poolAdmin: admin, balances: [[0n, 1_000n], [0n, 1_000n], [0n, 1_000n]], ...extra });
  test("[P05] fixed accounts, ×4 remaining layout, data = disc + vec<u64> + u64", () => {
    const pool = unseeded();
    const ix = buildSeedLiquidityIx(cfg, pool, { user: admin, tokenAmounts: [new BN(100), new BN(0), new BN(300)], lpAmount: new BN("5000000000") });
    expect(disc(ix.data)).toBe(DISC.seed);
    expect(ix.data.length).toBe(8 + 4 + 3 * 8 + 8);
    expect(ix.data.readUInt32LE(8)).toBe(3); expect(ix.data.readBigUInt64LE(12)).toBe(100n); expect(ix.data.readBigUInt64LE(20)).toBe(0n); expect(ix.data.readBigUInt64LE(28)).toBe(300n);
    expect(ix.data.readBigUInt64LE(36)).toBe(5_000_000_000n);
    const k = ix.keys;
    expect(k[0].pubkey.equals(pool.address) && k[0].isWritable).toBe(true);
    expect(k[1].pubkey.equals(pool.lpMint) && k[1].isWritable).toBe(true);
    expect(k[2].pubkey.equals(deriveAta(admin, pool.lpMint, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(k[3].pubkey.equals(admin) && k[3].isSigner).toBe(true);
    expect(k[4].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(k.length).toBe(5 + 4 * 3);
    for (let i = 0; i < 3; i++) {
      expect(k[5 + 2 * i].pubkey.equals(deriveAta(admin, pool.tokens[i].mint, TOKEN_PROGRAM_ID))).toBe(true);
      expect(k[6 + 2 * i].pubkey.equals(pool.tokens[i].vault)).toBe(true);
      expect(k[11 + i].pubkey.equals(pool.tokens[i].mint)).toBe(true);
      expect(k[14 + i].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    }
  });
  test("[P06] the seed tx creates vault ATAs for NON-ZERO slots only, the LP ATA, never migrates", () => {
    const pool = unseeded();
    const tx = buildSeedLiquidityTx(cfg, pool, { user: admin, tokenAmounts: [new BN(100), new BN(0), new BN(300)], lpAmount: new BN(DEFAULT_INITIAL_LP_SUPPLY.toString()) });
    const atas = tx.instructions.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    expect(atas.length).toBe(3); // 2 vaults + LP ATA
    expect(atas[0].keys[1].pubkey.equals(pool.tokens[0].vault)).toBe(true);
    expect(atas[1].keys[1].pubkey.equals(pool.tokens[2].vault)).toBe(true);
    expect(tx.instructions.some((ix) => disc(ix.data) === DISC.migrate)).toBe(false);
    expect(disc(tx.instructions[tx.instructions.length - 1].data)).toBe(DISC.seed);
    expect(tx.suggestedCuLimit).toBe(200_000 + 3 * 60_000);
  });
  test("[P07] a hooked pool's seed carries the slice before the Token-2022 tail", () => {
    const hookProgram = pk();
    const pool = unseeded({ hook: { program: hookProgram, flags: HOOK_FLAGS.BEFORE_ADD_LIQUIDITY, accountsLen: 3 } });
    const extra = pk();
    const slice = hookAccountSliceFor(cfg, pool, [{ pubkey: extra, isSigner: false, isWritable: true }]);
    const memo = pk();
    const ix = buildSeedLiquidityIx(cfg, pool, { user: admin, tokenAmounts: [new BN(1), new BN(1), new BN(1)], lpAmount: new BN(MIN_INITIAL_LP_SUPPLY.toString()), hookAccounts: slice, extraAccounts: [{ pubkey: memo, isSigner: false, isWritable: false }] });
    const tail = ix.keys.slice(5 + 12);
    expect(tail.map((k) => k.pubkey.toBase58())).toEqual([hookProgram, slice[1].pubkey, extra, memo].map((k) => k.toBase58()));
    expect(tx(pool).suggestedCuLimit).toBe(Math.min(1_400_000, 200_000 + 3 * 60_000 + 1 * (50_000 + 5_000)));
    function tx(p: typeof pool) { return buildSeedLiquidityTx(cfg, p, { user: admin, tokenAmounts: [new BN(1), new BN(1), new BN(1)], lpAmount: new BN(MIN_INITIAL_LP_SUPPLY.toString()), hookAccounts: slice }); }
  });
  test("[P08] raw builder accepts bigint amounts and an SPL-Token LP program", () => {
    const ix = buildSeedLiquidityRawIx(cfg, { pool: pk(), lpMint: pk(), userLpAccount: pk(), user: pk(), mints: [pk(), pk()], tokenPrograms: [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID], userTokenAccounts: [pk(), pk()], vaults: [pk(), pk()], amounts: [1n, 0n], lpAmount: MIN_INITIAL_LP_SUPPLY, lpTokenProgram: TOKEN_PROGRAM_ID });
    expect(ix.keys[4].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true); expect(ix.data.readBigUInt64LE(8 + 4 + 16)).toBe(MIN_INITIAL_LP_SUPPLY);
  });
  test("[N03] gates: not admin / admin disabled / already seeded / all-zero / length", () => {
    const ok = { user: admin, tokenAmounts: [new BN(1), new BN(1), new BN(1)], lpAmount: new BN(MIN_INITIAL_LP_SUPPLY.toString()) };
    expect(() => buildSeedLiquidityIx(cfg, unseeded(), { ...ok, user: pk() })).toThrow(/SeedDepositNotPoolAdmin/);
    expect(() => buildSeedLiquidityIx(cfg, unseeded({ poolAdmin: PublicKey.default }), ok)).toThrow(/PoolAdminDisabled/);
    expect(() => buildSeedLiquidityIx(cfg, unseeded({ lpSupply: 1n }), ok)).toThrow(/PoolAlreadySeeded/);
    expect(() => buildSeedLiquidityIx(cfg, unseeded(), { ...ok, tokenAmounts: [new BN(0), new BN(0), new BN(0)] })).toThrow(/FirstDepositRequiresNonzero/);
    expect(() => buildSeedLiquidityIx(cfg, unseeded(), { ...ok, tokenAmounts: [new BN(1), new BN(1)] })).toThrow(/token count/);
  });
  test("[N04] LP supply bounds and type", () => {
    const base = { user: admin, tokenAmounts: [new BN(1), new BN(1), new BN(1)] };
    expect(() => buildSeedLiquidityIx(cfg, unseeded(), { ...base, lpAmount: new BN((MIN_INITIAL_LP_SUPPLY - 1n).toString()) })).toThrow(/InitialLiquidityTooSmall/);
    expect(() => buildSeedLiquidityIx(cfg, unseeded(), { ...base, lpAmount: new BN((MAX_INITIAL_LP_SUPPLY + 1n).toString()) })).toThrow(/InitialLpSupplyTooLarge/);
    expect(() => buildSeedLiquidityIx(cfg, unseeded(), { ...base, lpAmount: new BN(-1) })).toThrow(/unsigned/);
    expect(() => buildSeedLiquidityIx(cfg, unseeded(), { ...base, lpAmount: new BN(1).shln(64) })).toThrow(/unsigned/);
  });
  test("[N05] hook slice required on a hooked pool, refused on an unhooked one, no signers in the tail", () => {
    const hooked = unseeded({ hook: { program: pk(), flags: HOOK_FLAGS.BEFORE_ADD_LIQUIDITY, accountsLen: 2 } });
    const base = { user: admin, tokenAmounts: [new BN(1), new BN(1), new BN(1)], lpAmount: new BN(MIN_INITIAL_LP_SUPPLY.toString()) };
    expect(() => buildSeedLiquidityIx(cfg, hooked, base)).toThrow(/HookAccountsInvalid/);
    expect(() => buildSeedLiquidityIx(cfg, unseeded(), { ...base, hookAccounts: [{ pubkey: pk(), isSigner: false, isWritable: false }] })).toThrow(/no active hook/);
    expect(() => buildSeedLiquidityIx(cfg, unseeded(), { ...base, extraAccounts: [{ pubkey: pk(), isSigner: true, isWritable: false }] })).toThrow(/signers/);
  });
  test("[N06] raw builder: lengths, token count, foreign LP program", () => {
    const two = { pool: pk(), lpMint: pk(), userLpAccount: pk(), user: pk(), mints: [pk(), pk()], tokenPrograms: [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID], userTokenAccounts: [pk(), pk()], vaults: [pk(), pk()], amounts: [1n, 1n], lpAmount: MIN_INITIAL_LP_SUPPLY };
    expect(() => buildSeedLiquidityRawIx(cfg, { ...two, vaults: [pk()] })).toThrow(/match mints length/);
    expect(() => buildSeedLiquidityRawIx(cfg, { ...two, mints: [pk()], tokenPrograms: [TOKEN_PROGRAM_ID], userTokenAccounts: [pk()], vaults: [pk()], amounts: [1n] })).toThrow(/outside \[2, 10\]/);
    expect(() => buildSeedLiquidityRawIx(cfg, { ...two, lpTokenProgram: pk() })).toThrow(/SPL Token or Token-2022/);
  });
});

describe("fund_sidelined_token (T10)", () => {
  const admin = pk();
  const sidelined = () => mockPool({ balances: [[1_000n, 1_000n], [0n, 1_000n]], poolAdmin: admin });
  test("[P09] accounts [pool w, lp_mint, authority s, user_token w, vault w, mint, program] + tail; 17-byte data", () => {
    const pool = sidelined();
    const ix = buildFundSidelinedTokenIx(cfg, pool, { authority: admin, tokenIndex: 1, amount: new BN(777) });
    expect(disc(ix.data)).toBe(DISC.fund); expect(ix.data.length).toBe(17); expect(ix.data[8]).toBe(1); expect(ix.data.readBigUInt64LE(9)).toBe(777n);
    const t = pool.tokens[1];
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([pool.address, pool.lpMint, admin, deriveAta(admin, t.mint, t.tokenProgram), t.vault, t.mint, t.tokenProgram].map((k) => k.toBase58()));
    expect(ix.keys.map((k) => k.isWritable)).toEqual([true, false, false, true, true, false, false]);
    expect(ix.keys[2].isSigner).toBe(true);
  });
  test("[P10] explicit source account and a Token-2022 tail; the tx creates the vault ATA first", () => {
    const pool = sidelined(); const src = pk(), memo = pk();
    const ix = buildFundSidelinedTokenIx(cfg, pool, { authority: admin, tokenIndex: 1, amount: new BN(1), userToken: src, extraAccounts: [{ pubkey: memo, isSigner: false, isWritable: false }] });
    expect(ix.keys[3].pubkey.equals(src)).toBe(true); expect(ix.keys[7].pubkey.equals(memo)).toBe(true);
    const tx = buildFundSidelinedTokenTx(cfg, pool, { authority: admin, tokenIndex: 1, amount: new BN(1) });
    expect(tx.instructions.map((i) => i.programId.toBase58())).toEqual([ComputeBudgetProgram.programId, ASSOCIATED_TOKEN_PROGRAM_ID, cfg.programs.cofferPool].map((k) => k.toBase58()));
    expect(tx.instructions[1].keys[1].pubkey.equals(pool.tokens[1].vault)).toBe(true);
  });
  test("[N07] not sidelined / out of range / not admin / zero amount / signer tail", () => {
    const pool = sidelined();
    expect(() => buildFundSidelinedTokenIx(cfg, pool, { authority: admin, tokenIndex: 0, amount: new BN(1) })).toThrow(/TokenNotSidelined/);
    expect(() => buildFundSidelinedTokenIx(cfg, pool, { authority: admin, tokenIndex: 2, amount: new BN(1) })).toThrow(/InvalidTokenIndex/);
    expect(() => buildFundSidelinedTokenIx(cfg, pool, { authority: pk(), tokenIndex: 1, amount: new BN(1) })).toThrow(/Unauthorized/);
    expect(() => buildFundSidelinedTokenIx(cfg, pool, { authority: admin, tokenIndex: 1, amount: new BN(0) })).toThrow(/ZeroAmount/);
    expect(() => buildFundSidelinedTokenIx(cfg, pool, { authority: admin, tokenIndex: 1, amount: new BN(1), extraAccounts: [{ pubkey: pk(), isSigner: true, isWritable: false }] })).toThrow(/signers/);
  });
});

describe("initialize_pool v6.1 args (T1 / T7 / T9 / T14)", () => {
  const base = (): DeployPoolParamsV61 => ({
    payer: pk(), configKey: pk(), poolId: new BN(42), tokens: [pk(), pk()], weightsBps: [6000, 4000], virtualBalances: [new BN(1_000), new BN(2_000)],
    swapFeeRate: 3000, lpMetadata: LP_METADATA_GOOD,
  });
  const argsOffset = 8 + 4 + 16 + 4 + 16 + 4 + 8; // disc, vec<u64>×2 (2 each), u32, u64
  test("[P11] data = v6 prefix ++ LpMetadataArgs ++ 3×u16 ++ Option<HookConfig>=None; fixed accounts; mints as remaining", () => {
    const p = base();
    const ix = buildInitializePoolIx(cfg, p);
    expect(disc(ix.data)).toBe(DISC.initPool);
    const meta = encodeLpMetadataArgs(LP_METADATA_GOOD);
    expect(ix.data.subarray(argsOffset, argsOffset + meta.length).equals(meta)).toBe(true);
    const o = argsOffset + meta.length;
    expect([ix.data.readUInt16LE(o), ix.data.readUInt16LE(o + 2), ix.data.readUInt16LE(o + 4), ix.data[o + 6]]).toEqual([0, 0, 0, 0]);
    expect(ix.data.length).toBe(o + 7);
    const [pool] = derivePoolPda(cfg.programs.cofferPool, p.configKey, p.poolId); const [lpMint] = deriveLpMint(cfg.programs.cofferPool, pool);
    expect(ix.keys.slice(0, 7).map((k) => k.pubkey.toBase58())).toEqual([p.configKey, pool, lpMint, p.payer, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId].map((k) => k.toBase58()));
    expect(ix.keys.slice(7).map((k) => k.pubkey.toBase58())).toEqual(p.tokens.map((k) => k.toBase58()));
  });
  test("[P12] fee bps and a hook config are encoded; the hook slice follows the mints", () => {
    const hookProgram = pk(); const caller = pk();
    const hookConfig = { program: hookProgram, flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin: 100, feeMax: 10_000, maxCu: 20_000, accountsLen: 2 };
    const hookAccounts = [{ pubkey: hookProgram, isSigner: false, isWritable: false }, { pubkey: caller, isSigner: false, isWritable: false }];
    const ix = buildInitializePoolIx(cfg, { ...base(), creatorFeeBps: 2500, depositFeeBps: 10, withdrawFeeBps: 20, hookConfig, hookAccounts });
    const o = argsOffset + encodeLpMetadataArgs(LP_METADATA_GOOD).length;
    expect([ix.data.readUInt16LE(o), ix.data.readUInt16LE(o + 2), ix.data.readUInt16LE(o + 4), ix.data[o + 6]]).toEqual([2500, 10, 20, 1]);
    expect(ix.data.subarray(o + 7).equals(encodeHookConfig(hookConfig))).toBe(true);
    expect(ix.keys.slice(9).map((k) => k.pubkey.toBase58())).toEqual([hookProgram, caller].map((k) => k.toBase58()));
    expect(buildDeployPoolTx(cfg, base()).instructions.length).toBe(2);
  });
  test("[P13] set_swaps_enabled direct pool-admin route: [config, pool w, authority s], data disc + bool", () => {
    const config = pk(), pool = pk(), auth = pk();
    const ix = buildSetSwapsEnabledIx(cfg, config, pool, auth, false);
    expect(disc(ix.data)).toBe(DISC.setSwaps); expect(ix.data.length).toBe(9); expect(ix.data[8]).toBe(0);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([[config.toBase58(), false, false], [pool.toBase58(), false, true], [auth.toBase58(), true, false]]);
  });
  test("[N08] LP mint must be Token-2022", () => {
    expect(() => buildInitializePoolIx(cfg, { ...base(), lpTokenProgram: TOKEN_PROGRAM_ID })).toThrow(/Token-2022/);
  });
  test("[N09] invalid LP metadata is refused with the program's error name", () => {
    expect(() => buildInitializePoolIx(cfg, { ...base(), lpMetadata: { name: "", symbol: "cLP", uri: "https://x" } })).toThrow(/LpNameInvalid/);
    expect(() => buildInitializePoolIx(cfg, { ...base(), lpMetadata: { name: "ok", symbol: "c LP", uri: "https://x" } })).toThrow(/LpSymbolInvalid/);
    expect(() => buildInitializePoolIx(cfg, { ...base(), lpMetadata: { name: "ok", symbol: "cLP", uri: "http://x" } })).toThrow(/LpUriInvalid/);
  });
  test("[N10] fee bps above 10_000 / non-integers are refused", () => {
    expect(() => buildInitializePoolIx(cfg, { ...base(), creatorFeeBps: 10_001 })).toThrow(/CreatorFeeBpsMaxExceeded/);
    expect(() => buildInitializePoolIx(cfg, { ...base(), depositFeeBps: 10_001 })).toThrow(/LiquidityFeeMaxExceeded/);
    expect(() => buildInitializePoolIx(cfg, { ...base(), withdrawFeeBps: -1 })).toThrow();
    expect(() => buildInitializePoolIx(cfg, { ...base(), withdrawFeeBps: 1.5 })).toThrow();
  });
  test("[N11] hook config / slice consistency", () => {
    const hookProgram = pk();
    const hookConfig = { program: hookProgram, flags: HOOK_FLAGS.BEFORE_SWAP, feeMin: 0, feeMax: 0, maxCu: 20_000, accountsLen: 2 };
    expect(() => buildInitializePoolIx(cfg, { ...base(), hookConfig })).toThrow(/HookAccountsInvalid/);
    expect(() => buildInitializePoolIx(cfg, { ...base(), hookConfig, hookAccounts: [{ pubkey: pk(), isSigner: false, isWritable: false }, { pubkey: pk(), isSigner: false, isWritable: false }] })).toThrow(/hookAccounts\[0\]/);
    expect(() => buildInitializePoolIx(cfg, { ...base(), hookAccounts: [{ pubkey: pk(), isSigner: false, isWritable: false }] })).toThrow(/without a hookConfig/);
    expect(() => buildInitializePoolIx(cfg, { ...base(), hookConfig: { ...hookConfig, program: cfg.programs.cofferPool }, hookAccounts: [{ pubkey: cfg.programs.cofferPool, isSigner: false, isWritable: false }, { pubkey: pk(), isSigner: false, isWritable: false }] })).toThrow(/HookProgramInvalid/);
    expect(() => buildInitializePoolIx(cfg, { ...base(), hookConfig: { ...hookConfig, flags: HOOK_FLAGS.DYNAMIC_FEE } , hookAccounts: [{ pubkey: hookProgram, isSigner: false, isWritable: false }, { pubkey: pk(), isSigner: false, isWritable: false }] })).toThrow(/HookInvalidConfig/);
  });
  test("[N12] token count / array lengths", () => {
    expect(() => buildInitializePoolIx(cfg, { ...base(), tokens: [pk()], weightsBps: [10_000], virtualBalances: [new BN(1)] })).toThrow(/InvalidTokenCount/);
    expect(() => buildInitializePoolIx(cfg, { ...base(), weightsBps: [10_000] })).toThrow(/same length/);
  });
});

describe("pool-admin setters (T3 / T6 / T7 / T14)", () => {
  const pool = pk(), auth = pk();
  const checkAuth = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) => {
    expect(ix.keys[0].pubkey.equals(pool) && ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(auth) && ix.keys[1].isSigner).toBe(true);
  };
  test("[P14] set_creator_fee_bps(u16)", () => {
    const ix = buildSetCreatorFeeBpsIx(cfg, pool, auth, 2500);
    expect(disc(ix.data)).toBe(DISC.setCreator); expect(ix.data.length).toBe(10); expect(ix.data.readUInt16LE(8)).toBe(2500); checkAuth(ix);
    expect(buildSetCreatorFeeBpsIx(cfg, pool, auth, 10_000).data.readUInt16LE(8)).toBe(10_000);
  });
  test("[P15] set_liquidity_fees(u16, u16)", () => {
    const ix = buildSetLiquidityFeesIx(cfg, pool, auth, 10, 20);
    expect(disc(ix.data)).toBe(DISC.setLiq); expect(ix.data.length).toBe(12); expect([ix.data.readUInt16LE(8), ix.data.readUInt16LE(10)]).toEqual([10, 20]); checkAuth(ix);
  });
  test("[P16] lock_liquidity_fees / lock_range_manager take no data", () => {
    const a = buildLockLiquidityFeesIx(cfg, pool, auth), b = buildLockRangeManagerIx(cfg, pool, auth);
    expect(disc(a.data)).toBe(DISC.lockLiq); expect(a.data.length).toBe(8); checkAuth(a);
    expect(disc(b.data)).toBe(DISC.lockRange); expect(b.data.length).toBe(8); checkAuth(b);
  });
  test("[P17] set_pool_admin_delay(u32) up to 30 days", () => {
    const ix = buildSetPoolAdminDelayIx(cfg, pool, auth, 86_400);
    expect(disc(ix.data)).toBe(DISC.setDelay); expect(ix.data.length).toBe(12); expect(ix.data.readUInt32LE(8)).toBe(86_400); checkAuth(ix);
    expect(buildSetPoolAdminDelayIx(cfg, pool, auth, 30 * 86_400).data.readUInt32LE(8)).toBe(2_592_000);
    expect(buildSetPoolAdminDelayIx(cfg, pool, auth, 0).data.readUInt32LE(8)).toBe(0);
  });
  test("[N13] bounds: creator > 10_000, liquidity > 10_000, delay > 30 d, negatives, fractions", () => {
    expect(() => buildSetCreatorFeeBpsIx(cfg, pool, auth, 10_001)).toThrow(/CreatorFeeBpsMaxExceeded/);
    expect(() => buildSetLiquidityFeesIx(cfg, pool, auth, 0, 10_001)).toThrow(/LiquidityFeeMaxExceeded/);
    expect(() => buildSetLiquidityFeesIx(cfg, pool, auth, 10_001, 0)).toThrow(/LiquidityFeeMaxExceeded/);
    expect(() => buildSetPoolAdminDelayIx(cfg, pool, auth, 30 * 86_400 + 1)).toThrow(/DelayTooLarge/);
    expect(() => buildSetPoolAdminDelayIx(cfg, pool, auth, -1)).toThrow(/DelayTooLarge/);
    expect(() => buildSetPoolAdminDelayIx(cfg, pool, auth, 1.5)).toThrow(/DelayTooLarge/);
    expect(() => buildSetCreatorFeeBpsIx(cfg, pool, auth, -1)).toThrow();
  });
});

describe("remove_liquidity_bypass_hooks (T9)", () => {
  const user = pk();
  const params = { user, lpAmount: new BN(1000), minimumTokenAmounts: [new BN(0), new BN(0)] };
  test("[P18] same accounts and data as remove_liquidity except the discriminator; no hook slice", () => {
    const pool = mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_REMOVE_LIQUIDITY, accountsLen: 2 } });
    const slice = hookAccountSliceFor(cfg, pool);
    const normal = buildRemoveLiquidityIx(cfg, pool, { ...params, hookAccounts: slice });
    const bypass = buildRemoveLiquidityBypassHooksIx(cfg, pool, params);
    expect(disc(normal.data)).toBe(DISC.remove); expect(disc(bypass.data)).toBe(DISC.bypass);
    expect(normal.data.subarray(8).equals(bypass.data.subarray(8))).toBe(true);
    expect(normal.keys.length).toBe(bypass.keys.length + 2);
    expect(bypass.keys.map((k) => k.pubkey.toBase58())).toEqual(normal.keys.slice(0, -2).map((k) => k.pubkey.toBase58()));
  });
  test("[P19] buildRemoveLiquidityTx with bypassHooks uses the bypass ix and the plain CU budget", () => {
    const pool = mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_REMOVE_LIQUIDITY | HOOK_FLAGS.AFTER_REMOVE_LIQUIDITY, accountsLen: 2 } });
    const tx = buildRemoveLiquidityTx(cfg, pool, { ...params, bypassHooks: true });
    expect(disc(tx.instructions[tx.instructions.length - 1].data)).toBe(DISC.bypass);
    expect(tx.suggestedCuLimit).toBe(cfg.defaults.cuLimit);
    const hooked = buildRemoveLiquidityTx(cfg, pool, { ...params, hookAccounts: hookAccountSliceFor(cfg, pool) });
    expect(disc(hooked.instructions[hooked.instructions.length - 1].data)).toBe(DISC.remove);
    expect(hooked.suggestedCuLimit).toBe(Math.min(1_400_000, cfg.defaults.cuLimit + 2 * 55_000));
  });
  test("[P20] the bypass works on an unhooked pool too (always available)", () => {
    expect(disc(buildRemoveLiquidityBypassHooksIx(cfg, mockPool(), params).data)).toBe(DISC.bypass);
  });
  test("[N14] a slice on the bypass is refused; a missing slice on the hooked normal path is refused", () => {
    const pool = mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_REMOVE_LIQUIDITY, accountsLen: 2 } });
    expect(() => buildRemoveLiquidityBypassHooksIx(cfg, pool, { ...params, hookAccounts: hookAccountSliceFor(cfg, pool) })).toThrow(/never takes a hook slice/);
    expect(() => buildRemoveLiquidityIx(cfg, pool, params)).toThrow(/HookAccountsInvalid/);
    expect(() => buildRemoveLiquidityTx(cfg, pool, { ...params, bypassHooks: true, hookAccounts: hookAccountSliceFor(cfg, pool) })).toThrow(/never takes a hook slice/);
  });
  test("[N15] sidelined output slot refuses a swap; the remove tx skips its ATA", () => {
    const pool = mockPool({ balances: [[1_000_000n, 1_000_000n], [0n, 1_000_000n]] });
    expect(() => buildSwapTx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1), minAmountOut: new BN(1) })).toThrow(/sidelined/);
    const tx = buildRemoveLiquidityTx(cfg, pool, params);
    expect(tx.instructions.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).length).toBe(1);
  });
});
