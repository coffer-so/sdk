/**
 * T9 hooks (client side): HookConfig validation / encoding, HOOK_CALLER PDA,
 * the account slice, requireHookSlice on every op, the fixture resolver and
 * the CU heuristic.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  HOOK_CONFIG_LEN, hookCallerPda, HOOK_CALLER_LOCALNET, validateHookConfig, encodeHookConfig, encodeOptionHookConfig, hookConfigArg,
  hookAccountSlice, hookAccountSliceFor, requireHookSlice, HOOK_FIXTURE_PROGRAM_ID, hookFixtureCfgAddress, hookFixtureKycAddress,
  fixtureHookExtras, resolveHookSlice, hookOpFlags, hookCallbackCount, HOOK_BASE_CU, HOOK_CALLBACK_OVERHEAD_CU, hookCuBudget, readonlyMeta, writableMeta,
} from "../src/utils/hooks";
import { HOOK_FLAGS, HOOK_MIN_CU, HOOK_MAX_CU_CAP, HOOK_MIN_ACCOUNTS, HOOK_MAX_ACCOUNTS, MAX_SWAP_FEE_RATE, NETWORK_PROGRAMS } from "../src/config";
import { buildSwapIx, buildAddLiquidityIx, buildSwapTx, buildAddLiquidityTx } from "../src/clients/tx-builders";
import { mockPool, cfg } from "./helpers/poolFixture";

const pk = (): PublicKey => Keypair.generate().publicKey;
const good = () => ({ program: pk(), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.AFTER_SWAP, feeMin: 0, feeMax: 0, maxCu: 50_000, accountsLen: 3 });

describe("HookConfig", () => {
  test("[P01] encode = pubkey ++ u16 ++ u32×3 ++ u8 (47 B); Option = tag + body", () => {
    const c = { ...good(), flags: 0x31, feeMin: 1, feeMax: 2, maxCu: 3, accountsLen: 4 };
    const b = encodeHookConfig(c);
    expect(b.length).toBe(47); expect(HOOK_CONFIG_LEN).toBe(47);
    expect(new PublicKey(b.subarray(0, 32)).equals(c.program)).toBe(true);
    expect(b.readUInt16LE(32)).toBe(0x31); expect(b.readUInt32LE(34)).toBe(1); expect(b.readUInt32LE(38)).toBe(2); expect(b.readUInt32LE(42)).toBe(3); expect(b[46]).toBe(4);
    expect(encodeOptionHookConfig(null)).toEqual(Buffer.from([0])); expect(encodeOptionHookConfig(undefined)).toEqual(Buffer.from([0]));
    const opt = encodeOptionHookConfig(c); expect(opt[0]).toBe(1); expect(opt.subarray(1).equals(b)).toBe(true);
    expect(hookConfigArg(c)).toEqual({ program: c.program, flags: 0x31, fee_min: 1, fee_max: 2, max_cu: 3, accounts_len: 4 }); expect(hookConfigArg(null)).toBeNull();
  });
  test("[P02] valid configs: every single callback, dynamic fee with a clamp, min/max bounds, PAUSE_WHEN_DISABLED", () => {
    for (const bit of [0, 1, 2, 3, 4, 5]) validateHookConfig({ ...good(), flags: 1 << bit });
    validateHookConfig({ ...good(), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin: 100, feeMax: MAX_SWAP_FEE_RATE });
    validateHookConfig({ ...good(), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin: 0, feeMax: 0 });
    validateHookConfig({ ...good(), maxCu: HOOK_MIN_CU, accountsLen: HOOK_MIN_ACCOUNTS });
    validateHookConfig({ ...good(), maxCu: HOOK_MAX_CU_CAP, accountsLen: HOOK_MAX_ACCOUNTS });
    validateHookConfig({ ...good(), flags: HOOK_FLAGS.ALL_CALLBACKS | HOOK_FLAGS.PAUSE_WHEN_DISABLED });
  });
  test("[N01] program: default / coffer-pool itself / not a PublicKey", () => {
    expect(() => validateHookConfig({ ...good(), program: PublicKey.default })).toThrow(/HookProgramInvalid/);
    expect(() => validateHookConfig({ ...good(), program: cfg.programs.cofferPool }, cfg.programs.cofferPool)).toThrow(/HookProgramInvalid/);
    expect(() => validateHookConfig({ ...good(), program: "x" as any })).toThrow(/PublicKey/);
    expect(() => validateHookConfig(null as any)).toThrow();
  });
  test("[N02] flags: none / reserved bits / DYNAMIC_FEE without BEFORE_SWAP / only PAUSE_WHEN_DISABLED", () => {
    expect(() => validateHookConfig({ ...good(), flags: 0 })).toThrow(/at least one callback/);
    expect(() => validateHookConfig({ ...good(), flags: 0x100 | HOOK_FLAGS.BEFORE_SWAP })).toThrow(/reserved bits/);
    expect(() => validateHookConfig({ ...good(), flags: HOOK_FLAGS.AFTER_SWAP | HOOK_FLAGS.DYNAMIC_FEE })).toThrow(/DYNAMIC_FEE requires BEFORE_SWAP/);
    expect(() => validateHookConfig({ ...good(), flags: HOOK_FLAGS.PAUSE_WHEN_DISABLED })).toThrow(/at least one callback/);
  });
  test("[N03] fee clamp: non-zero without DYNAMIC_FEE, min > max, max > 100 %", () => {
    expect(() => validateHookConfig({ ...good(), feeMax: 1 })).toThrow(/must be 0 without DYNAMIC_FEE/);
    expect(() => validateHookConfig({ ...good(), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin: 2, feeMax: 1 })).toThrow(/feeMin ≤ feeMax/);
    expect(() => validateHookConfig({ ...good(), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin: 0, feeMax: MAX_SWAP_FEE_RATE + 1 })).toThrow(/feeMin ≤ feeMax/);
  });
  test("[N04] maxCu / accountsLen bounds and integer-ness", () => {
    expect(() => validateHookConfig({ ...good(), maxCu: HOOK_MIN_CU - 1 })).toThrow(/maxCu/);
    expect(() => validateHookConfig({ ...good(), maxCu: HOOK_MAX_CU_CAP + 1 })).toThrow(/maxCu/);
    expect(() => validateHookConfig({ ...good(), accountsLen: HOOK_MIN_ACCOUNTS - 1 })).toThrow(/accountsLen/);
    expect(() => validateHookConfig({ ...good(), accountsLen: HOOK_MAX_ACCOUNTS + 1 })).toThrow(/accountsLen/);
    expect(() => validateHookConfig({ ...good(), accountsLen: 256 })).toThrow(/8-bit/);
    expect(() => validateHookConfig({ ...good(), flags: 70_000 })).toThrow(/16-bit/);
    expect(() => validateHookConfig({ ...good(), maxCu: 1.5 })).toThrow(/32-bit/);
    expect(() => validateHookConfig({ ...good(), feeMin: -1 })).toThrow(/32-bit/);
  });
});

describe("HOOK_CALLER and the slice", () => {
  test("[P03] HOOK_CALLER = PDA [\"coffer_hook_caller\"] of coffer-pool", () => {
    const [pda, bump] = hookCallerPda(cfg.programs.cofferPool);
    expect(pda.equals(PublicKey.findProgramAddressSync([Buffer.from("coffer_hook_caller")], cfg.programs.cofferPool)[0])).toBe(true);
    expect(bump).toBeLessThanOrEqual(255);
    expect(HOOK_CALLER_LOCALNET.equals(hookCallerPda(NETWORK_PROGRAMS.localnet.cofferPool)[0])).toBe(true);
    expect(hookCallerPda(pk())[0].equals(pda)).toBe(false);
  });
  test("[P04] slice = [program ro, caller ro, ...extras] of exactly accountsLen; [] for no / disabled hook", () => {
    const pool = mockPool({ hook: { accountsLen: 4 } });
    const a = pk(), b = pk();
    const slice = hookAccountSlice(pool, [writableMeta(a), readonlyMeta(b)], cfg.programs.cofferPool);
    expect(slice.map((m) => [m.pubkey.toBase58(), m.isWritable, m.isSigner])).toEqual([[pool.hook!.program.toBase58(), false, false], [hookCallerPda(cfg.programs.cofferPool)[0].toBase58(), false, false], [a.toBase58(), true, false], [b.toBase58(), false, false]]);
    expect(hookAccountSliceFor(cfg, pool, [writableMeta(a), readonlyMeta(b)])).toEqual(slice);
    expect(hookAccountSlice(mockPool())).toEqual([]);
    expect(hookAccountSlice(mockPool({ hook: { disabled: true } }))).toEqual([]);
    expect(hookAccountSlice(mockPool({ hook: { accountsLen: 2 } }), [], cfg.programs.cofferPool).length).toBe(2);
  });
  test("[P05] requireHookSlice normalises a correct slice and returns [] without a hook / on bypass", () => {
    const pool = mockPool({ hook: { accountsLen: 3 } });
    const slice = hookAccountSliceFor(cfg, pool, [writableMeta(pk())]);
    const out = requireHookSlice(cfg, pool, slice.map((m) => ({ ...m, isSigner: false })), "swap");
    expect(out).toEqual(slice);
    expect(requireHookSlice(cfg, mockPool(), undefined, "swap")).toEqual([]);
    expect(requireHookSlice(cfg, mockPool(), [], "swap")).toEqual([]);
    expect(requireHookSlice(cfg, pool, undefined, "remove", true)).toEqual([]);
    expect(requireHookSlice(cfg, mockPool({ hook: { disabled: true, accountsLen: 2 } }), undefined, "swap")).toEqual([]);
  });
  test("[P06] the fixture resolver: cfg(pool) writable, kyc(user) read-only when requested", () => {
    const pool = mockPool({ hook: { program: HOOK_FIXTURE_PROGRAM_ID, accountsLen: 4 } }); const user = pk();
    const slice = resolveHookSlice(cfg, pool, user, "swap", fixtureHookExtras(true));
    expect(slice.length).toBe(4);
    expect(slice[2].pubkey.equals(hookFixtureCfgAddress(pool.address)) && slice[2].isWritable).toBe(true);
    expect(slice[3].pubkey.equals(hookFixtureKycAddress(user)) && !slice[3].isWritable).toBe(true);
    expect(hookFixtureCfgAddress(pool.address).equals(PublicKey.findProgramAddressSync([Buffer.from("hook-cfg"), pool.address.toBuffer()], HOOK_FIXTURE_PROGRAM_ID)[0])).toBe(true);
    const noKyc = resolveHookSlice(cfg, mockPool({ hook: { program: HOOK_FIXTURE_PROGRAM_ID, accountsLen: 3 } }), user, "add", fixtureHookExtras());
    expect(noKyc.length).toBe(3);
    expect(resolveHookSlice(cfg, mockPool(), user, "swap", fixtureHookExtras())).toEqual([]);
  });
  test("[P07] swap / add builders put the slice BEFORE the Token-2022 tail", () => {
    const pool = mockPool({ hook: { accountsLen: 2 } }); const user = pk(); const memo = pk();
    const slice = hookAccountSliceFor(cfg, pool);
    const swap = buildSwapIx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1), minAmountOut: new BN(1), hookAccounts: slice, extraAccounts: [readonlyMeta(memo)] });
    expect(swap.keys.slice(10).map((k) => k.pubkey.toBase58())).toEqual([slice[0].pubkey, slice[1].pubkey, memo].map((k) => k.toBase58()));
    const add = buildAddLiquidityIx(cfg, pool, { user, tokenAmounts: [new BN(1000), new BN(1000)], minimumLpAmount: new BN(1), hookAccounts: slice, extraAccounts: [readonlyMeta(memo)] });
    expect(add.keys.slice(5 + 8).map((k) => k.pubkey.toBase58())).toEqual([slice[0].pubkey, slice[1].pubkey, memo].map((k) => k.toBase58()));
  });
  test("[N05] slice construction: wrong length, signer extras, extras without a hook", () => {
    const pool = mockPool({ hook: { accountsLen: 3 } });
    expect(() => hookAccountSlice(pool, [], cfg.programs.cofferPool)).toThrow(/HookAccountsInvalid/);
    expect(() => hookAccountSlice(pool, [readonlyMeta(pk()), readonlyMeta(pk())], cfg.programs.cofferPool)).toThrow(/HookAccountsInvalid/);
    expect(() => hookAccountSlice(pool, [{ pubkey: pk(), isSigner: true, isWritable: false }], cfg.programs.cofferPool)).toThrow(/signers/);
    expect(() => hookAccountSlice(mockPool(), [readonlyMeta(pk())])).toThrow(/no active hook/);
  });
  test("[N06] requireHookSlice: missing, wrong length, wrong program, wrong caller, signer, writable head, slice on unhooked, slice on bypass", () => {
    const pool = mockPool({ hook: { accountsLen: 3 } });
    const slice = hookAccountSliceFor(cfg, pool, [writableMeta(pk())]);
    expect(() => requireHookSlice(cfg, pool, undefined, "swap")).toThrow(/HookAccountsInvalid/);
    expect(() => requireHookSlice(cfg, pool, [], "swap")).toThrow(/HookAccountsInvalid/);
    expect(() => requireHookSlice(cfg, pool, slice.slice(0, 2), "swap")).toThrow(/length/);
    expect(() => requireHookSlice(cfg, pool, [readonlyMeta(pk()), slice[1], slice[2]], "swap")).toThrow(/hookAccounts\[0\]/);
    expect(() => requireHookSlice(cfg, pool, [slice[0], readonlyMeta(pk()), slice[2]], "swap")).toThrow(/HOOK_CALLER/);
    expect(() => requireHookSlice(cfg, pool, [slice[0], slice[1], { ...slice[2], isSigner: true }], "swap")).toThrow(/signers/);
    expect(() => requireHookSlice(cfg, pool, [{ ...slice[0], isWritable: true }, slice[1], slice[2]], "swap")).toThrow(/read-only/);
    expect(() => requireHookSlice(cfg, mockPool(), slice, "swap")).toThrow(/no active hook \(none\)/);
    expect(() => requireHookSlice(cfg, mockPool({ hook: { disabled: true, accountsLen: 3 } }), slice, "swap")).toThrow(/no active hook \(disabled\)/);
    expect(() => requireHookSlice(cfg, pool, slice, "remove", true)).toThrow(/never takes a hook slice/);
  });
  test("[N07] builders refuse a hooked swap / add without the slice", () => {
    const pool = mockPool({ hook: { accountsLen: 2 } }); const user = pk();
    expect(() => buildSwapIx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1), minAmountOut: new BN(1) })).toThrow(/HookAccountsInvalid/);
    expect(() => buildAddLiquidityIx(cfg, pool, { user, tokenAmounts: [new BN(1000), new BN(1000)], minimumLpAmount: new BN(1) })).toThrow(/HookAccountsInvalid/);
  });
});

describe("CU heuristic", () => {
  test("[P08] op flags and callback counts", () => {
    expect(hookOpFlags("swap")).toBe(HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.AFTER_SWAP);
    expect(hookOpFlags("add")).toBe(hookOpFlags("seed"));
    expect(hookOpFlags("remove")).toBe(HOOK_FLAGS.BEFORE_REMOVE_LIQUIDITY | HOOK_FLAGS.AFTER_REMOVE_LIQUIDITY);
    const hook = mockPool({ hook: { flags: HOOK_FLAGS.ALL_CALLBACKS } }).hook;
    expect(hookCallbackCount(hook, "swap")).toBe(2); expect(hookCallbackCount(hook, "add")).toBe(2); expect(hookCallbackCount(hook, "remove")).toBe(2);
    expect(hookCallbackCount(mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE } }).hook, "swap")).toBe(1);
    expect(hookCallbackCount(mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP } }).hook, "add")).toBe(0);
    expect(hookCallbackCount(null, "swap")).toBe(0);
    expect(hookCallbackCount(mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP, disabled: true } }).hook, "swap")).toBe(0);
  });
  test("[P09] budget = base + callbacks × (maxCu + 5_000), capped at 1.4M; base without a hook", () => {
    expect(hookCuBudget(mockPool(), "swap")).toBe(HOOK_BASE_CU.swap);
    expect(hookCuBudget(mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.AFTER_SWAP, maxCu: 50_000 } }), "swap")).toBe(400_000 + 2 * (50_000 + HOOK_CALLBACK_OVERHEAD_CU));
    expect(hookCuBudget(mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP, maxCu: 200_000 } }), "swap", 1_300_000)).toBe(1_400_000);
    expect(hookCuBudget(mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP, maxCu: 50_000 } }), "add")).toBe(HOOK_BASE_CU.add);
    expect(hookCuBudget(mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP, disabled: true } }), "swap")).toBe(HOOK_BASE_CU.swap);
  });
  test("[P10] the build*Tx helpers put the budget into the ComputeBudget ix", () => {
    const pool = mockPool({ hook: { flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.AFTER_SWAP | HOOK_FLAGS.BEFORE_ADD_LIQUIDITY, maxCu: 20_000, accountsLen: 2 } }); const user = pk();
    const slice = hookAccountSliceFor(cfg, pool);
    const swap = buildSwapTx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1), minAmountOut: new BN(1), hookAccounts: slice });
    expect(swap.suggestedCuLimit).toBe(400_000 + 2 * 25_000); expect(swap.instructions[0].data.readUInt32LE(1)).toBe(450_000);
    const add = buildAddLiquidityTx(cfg, pool, { user, tokenAmounts: [new BN(1000), new BN(1000)], minimumLpAmount: new BN(1), hookAccounts: slice });
    expect(add.suggestedCuLimit).toBe(600_000 + 25_000);
  });
});
