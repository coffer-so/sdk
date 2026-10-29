/**
 * T9 hooks against the FINAL v6.1 ABI (contracts 409067d): the slice on every
 * hooked builder, `hook_config` last in `initialize_pool`, the bypass twin,
 * `set_hook_disabled` (raw + protocol-admin wrapper), the dynamic-fee quote
 * path (`clamp_fee_override`) versus `SwapV2.effective_fee_rate` /
 * `HookInvoked.fee_override`, and the hook events on the re-cut wire.
 */
import { createHash } from "crypto";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { IDLS } from "../src/idl";
import { HOOK_CALLBACKS, HOOK_FLAGS } from "../src/config";
import {
  buildSwapIx, buildSwapTx, buildAddLiquidityIx, buildAddLiquidityTx, buildSeedLiquidityIx, buildRemoveLiquidityIx, buildRemoveLiquidityBypassHooksIx,
  buildRemoveLiquidityTx, buildInitializePoolIx, buildSetHookDisabledIx,
} from "../src/clients/tx-builders";
import { AdminClient } from "../src/clients/AdminClient";
import { CofferPoolClient } from "../src/clients/CofferPoolClient";
import { clampHookFeeOverride, effectiveSwapFeeRate } from "../src/math/swapSim";
import { hookAccountSliceFor, hookCallerPda, hookCuBudget, encodeHookConfig, HOOK_CONFIG_LEN, HOOK_CALLBACK_OVERHEAD_CU } from "../src/utils/hooks";
import { parseCofferPoolEvents } from "../src/parsers/events";
import { LP_METADATA_GOOD, encodeLpMetadataArgs } from "../src/utils/lpMetadata";
import { eventLog } from "./helpers/borshFixture";
import { mockPool, cfg, pk } from "./helpers/poolFixture";
import type { PoolInfo } from "../src/types/pool";
import type { HookInvokedEvent, LiquidityRemovedV2Event, SwapV2Event } from "../src/types/events";

const idl = IDLS.cofferPool as any, pa = IDLS.protocolAdmin as any;
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const disc = (data: Buffer) => data.subarray(0, 8).toString("hex");
const DISC = { swap: "f8c69e91e17587c8", add: "b59d59438fb63448", seed: "b4395e2349300d0b", remove: "5055d14818ceb16c", bypass: "6182e9862d4f6f24", init: "5fb40aac54aee828", setHookDisabled: "f78c7bef72feba57", paSetHookDisabled: "c8dce304b8f7a24a" };
const clientFor = (pool: PoolInfo) => { const c = new CofferPoolClient({ config: cfg, poolAddress: pool.address }); (c as unknown as { cache: PoolInfo }).cache = pool; return c; };
const unwrap = <T>(r: { ok: true; data: T } | { ok: false; error: { code: string; humanMessage: string } }): T => { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.humanMessage}`); return r.data; };
const fail = <T>(r: { ok: true; data: T } | { ok: false; error: { code: string; humanMessage: string } }) => { if (r.ok) throw new Error("expected a failure"); return r.error; };
const memo = pk();
const tail = [{ pubkey: memo, isSigner: false, isWritable: false }];
const hooked = (extra = {}) => mockPool({ hook: { program: key(41), flags: HOOK_FLAGS.ALL_CALLBACKS, accountsLen: 3, maxCu: 60_000 }, poolAdmin: key(3), ...extra });
const sliceOf = (pool: PoolInfo) => hookAccountSliceFor(cfg, pool, [{ pubkey: key(42), isSigner: false, isWritable: true }]);
const keysOf = (ix: { keys: { pubkey: PublicKey }[] }) => ix.keys.map((k) => k.pubkey.toBase58());

// ── positive ────────────────────────────────────────────────────────────────

describe("T9 on the final ABI — builders", () => {
  test("[P01] swap / add / seed / remove carry the slice right after the per-token layout and before the Token-2022 tail", () => {
    const pool = hooked(), user = pk(), slice = sliceOf(pool), n = pool.tokenCount;
    const expectSlice = (ix: { keys: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] }, fixed: number, perToken: number) => {
      const start = fixed + perToken * n;
      expect(keysOf(ix).slice(start, start + 3)).toEqual([key(41).toBase58(), hookCallerPda(cfg.programs.cofferPool)[0].toBase58(), key(42).toBase58()]);
      expect(ix.keys[start].isWritable).toBe(false); expect(ix.keys[start + 1].isWritable).toBe(false); expect(ix.keys[start + 2].isWritable).toBe(true);
      expect(ix.keys.every((k, i) => i < fixed || !k.isSigner)).toBe(true);
      expect(keysOf(ix).at(-1)).toBe(memo.toBase58());
    };
    const swap = buildSwapIx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1_000), minAmountOut: new BN(1), hookAccounts: slice, extraAccounts: tail });
    expect(disc(swap.data)).toBe(DISC.swap); expect(keysOf(swap).indexOf(key(41).toBase58())).toBeGreaterThan(0); expect(keysOf(swap).indexOf(key(41).toBase58())).toBe(swap.keys.length - 4);
    const add = buildAddLiquidityIx(cfg, pool, { user, tokenAmounts: [new BN(1_000), new BN(1_000)], minimumLpAmount: new BN(1), hookAccounts: slice, extraAccounts: tail });
    expect(disc(add.data)).toBe(DISC.add); expectSlice(add, 5, 4);
    const unseeded = hooked({ lpSupply: 0n, balances: [[0n, 1_000n], [0n, 1_000n]] });
    const seed = buildSeedLiquidityIx(cfg, unseeded, { user: key(3), tokenAmounts: [new BN(10), new BN(10)], lpAmount: new BN("1000000000"), hookAccounts: sliceOf(unseeded), extraAccounts: tail });
    expect(disc(seed.data)).toBe(DISC.seed); expectSlice(seed, 5, 4);
    const remove = buildRemoveLiquidityIx(cfg, pool, { user, lpAmount: new BN(1_000), minimumTokenAmounts: [new BN(0), new BN(0)], hookAccounts: slice, extraAccounts: tail });
    expect(disc(remove.data)).toBe(DISC.remove); expectSlice(remove, 5, 4);
  });
  test("[P02] remove_liquidity_bypass_hooks: same data after the discriminator, no slice, tail kept", () => {
    const pool = hooked(), user = pk();
    const remove = buildRemoveLiquidityIx(cfg, pool, { user, lpAmount: new BN(1_000), minimumTokenAmounts: [new BN(0), new BN(0)], hookAccounts: sliceOf(pool), extraAccounts: tail });
    const bypass = buildRemoveLiquidityBypassHooksIx(cfg, pool, { user, lpAmount: new BN(1_000), minimumTokenAmounts: [new BN(0), new BN(0)], extraAccounts: tail });
    expect(disc(bypass.data)).toBe(DISC.bypass); expect(bypass.data.subarray(8).equals(remove.data.subarray(8))).toBe(true);
    expect(bypass.keys.length).toBe(remove.keys.length - 3); expect(keysOf(bypass)).not.toContain(key(41).toBase58()); expect(keysOf(bypass).at(-1)).toBe(memo.toBase58());
    const tx = buildRemoveLiquidityTx(cfg, pool, { user, lpAmount: new BN(1_000), minimumTokenAmounts: [new BN(0), new BN(0)], bypassHooks: true });
    expect(disc(tx.instructions.at(-1)!.data)).toBe(DISC.bypass); expect(tx.suggestedCuLimit).toBe(cfg.defaults.cuLimit);
  });
  test("[P03] initialize_pool: hook_config is the LAST argument (Option tag + 47 B after the three u16), the slice follows the mints", () => {
    const cfgHook = { program: key(41), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin: 100, feeMax: 50_000, maxCu: 60_000, accountsLen: 3 };
    const mints = [pk(), pk()];
    const slice = [{ pubkey: key(41), isSigner: false, isWritable: false }, { pubkey: hookCallerPda(cfg.programs.cofferPool)[0], isSigner: false, isWritable: false }, { pubkey: key(42), isSigner: false, isWritable: true }];
    const base = { payer: pk(), configKey: pk(), poolId: new BN(1), tokens: mints, weightsBps: [5000, 5000], virtualBalances: [new BN(1_000_000_000), new BN(1_000_000_000)], swapFeeRate: 3000, lpMetadata: LP_METADATA_GOOD, creatorFeeBps: 100, depositFeeBps: 5, withdrawFeeBps: 7 };
    const plain = buildInitializePoolIx(cfg, base);
    const withHook = buildInitializePoolIx(cfg, { ...base, hookConfig: cfgHook, hookAccounts: slice });
    expect(disc(withHook.data)).toBe(DISC.init);
    expect(withHook.data.length).toBe(plain.data.length + HOOK_CONFIG_LEN); expect(plain.data.at(-1)).toBe(0);
    const prefixLen = 8 + 4 + 16 + 4 + 16 + 4 + 8 + encodeLpMetadataArgs(LP_METADATA_GOOD).length + 6;
    expect(plain.data.length).toBe(prefixLen + 1);
    expect(withHook.data[prefixLen]).toBe(1); expect(withHook.data.subarray(prefixLen + 1).equals(encodeHookConfig(cfgHook))).toBe(true);
    expect(idl.instructions.find((i: any) => i.name === "initialize_pool").args.at(-1)).toEqual({ name: "hook_config", type: { option: { defined: { name: "HookConfig" } } } });
    expect(keysOf(withHook).slice(7)).toEqual([...mints.map((m) => m.toBase58()), ...slice.map((m) => m.pubkey.toBase58())]);
    expect(withHook.keys.at(-1)!.isWritable).toBe(true);
  });
  test("[P04] set_hook_disabled: raw coffer_pool builder and the protocol-admin wrapper, both pinned", async () => {
    const config = pk(), pool = pk();
    const raw = buildSetHookDisabledIx(cfg, config, pool, pk(), false);
    expect(disc(raw.data)).toBe(DISC.setHookDisabled); expect([...raw.data.subarray(8)]).toEqual([0]);
    const admin = Keypair.generate();
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(admin), {}) });
    const ix = await client.setHookDisabledIx(admin.publicKey, config, pool, true);
    expect(disc(ix.data)).toBe(DISC.paSetHookDisabled); expect([...ix.data.subarray(8)]).toEqual([1]);
    expect(keysOf(ix)).toEqual([client.treasuryPda, admin.publicKey, config, pool, cfg.programs.cofferPool].map((k) => k.toBase58()));
    expect(ix.keys[1].isSigner).toBe(true); expect(ix.keys[3].isWritable).toBe(true);
    // no cooldown kind exists for it (instant emergency switch): neither action enum has a variant
    expect(pa.types.find((t: any) => t.name === "ProtocolAction").type.variants.some((v: any) => /Hook/.test(v.name))).toBe(false);
    expect(idl.types.find((t: any) => t.name === "PoolAction").type.variants.some((v: any) => /Hook/.test(v.name))).toBe(false);
  });
  test("[P05] the CU heuristic feeds the tx builders: base + callbacks × (max_cu + 5k)", () => {
    const pool = hooked(), user = pk(), slice = sliceOf(pool);
    expect(hookCuBudget(pool, "swap")).toBe(400_000 + 2 * (60_000 + HOOK_CALLBACK_OVERHEAD_CU));
    expect(buildSwapTx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1_000), minAmountOut: new BN(1), hookAccounts: slice }).suggestedCuLimit).toBe(hookCuBudget(pool, "swap"));
    expect(buildAddLiquidityTx(cfg, pool, { user, tokenAmounts: [new BN(1_000), new BN(1_000)], minimumLpAmount: new BN(1), hookAccounts: slice }).suggestedCuLimit).toBe(600_000 + 2 * 65_000);
    expect(buildRemoveLiquidityTx(cfg, pool, { user, lpAmount: new BN(1_000), minimumTokenAmounts: [new BN(0), new BN(0)], hookAccounts: slice }).suggestedCuLimit).toBe(cfg.defaults.cuLimit);
  });
  test("[P06] HOOK_CALLBACKS discriminators are sha256(\"coffer-hook-interface:<name>\")[..8] in callback-index order", () => {
    HOOK_CALLBACKS.forEach((cb, i) => {
      expect(cb.index).toBe(i);
      expect(createHash("sha256").update(`coffer-hook-interface:${cb.name}`).digest().subarray(0, 8).toString("hex")).toBe(cb.discriminator);
    });
  });
});

describe("T9 on the final ABI — dynamic fee quotes vs SwapV2 / HookInvoked", () => {
  const dynamic = (feeMin: number, feeMax: number) => hooked({ swapFeeRate: 3000, hook: { program: key(41), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMin, feeMax, accountsLen: 2, maxCu: 50_000 } });
  test("[P07] hookFeeOverride is clamped like hooks::clamp_fee_override and the quote equals a plain pool at the clamped rate", () => {
    for (const [raw, min, max, want] of [[999_999, 100, 50_000, 50_000], [1, 100, 50_000, 100], [2_500, 100, 50_000, 2_500], [0, 0, 0, 0]] as const) {
      expect(clampHookFeeOverride(raw, min, max)).toBe(want);
      expect(effectiveSwapFeeRate({ swapFeeRate: 3000, hookFeeOverride: raw, hookFeeMin: min, hookFeeMax: max })).toBe(want);
      const q = unwrap(clientFor(dynamic(min, max)).quoteSwap(0, 1, new BN(1_000_000), { hookFeeOverride: raw }));
      expect(q.effectiveFeeRate).toBe(want); expect(q.feeSource).toBe("hook_override");
      const plain = unwrap(clientFor(mockPool({ swapFeeRate: want })).quoteSwap(0, 1, new BN(1_000_000)));
      expect(q.amountOut.toString()).toBe(plain.amountOut.toString()); expect(q.feeAmount.toString()).toBe(plain.feeAmount.toString());
    }
    expect(effectiveSwapFeeRate({ swapFeeRate: 3000, hookFeeMin: 100, hookFeeMax: 50_000 })).toBe(3000);
  });
  test("[P08] SwapV2.effective_fee_rate is the clamped rate the quote predicts; swap_fee_rate stays the configured one", () => {
    expect(idl.types.find((t: any) => t.name === "SwapV2").type.fields.filter((f: any) => /fee_rate/.test(f.name)).map((f: any) => `${f.name}:${f.type}`)).toEqual(["swap_fee_rate:u32", "effective_fee_rate:u32", "protocol_fee_rate:u16"]);
    const q = unwrap(clientFor(dynamic(100, 50_000)).quoteSwap(0, 1, new BN(1_000_000), { hookFeeOverride: 999_999 }));
    const slot = (v: number) => ({ virtual_balance: new BN(v), actual_balance: new BN(v - 1), protocol_fees_owed: new BN(0), creator_fees_owed: new BN(0), surge_fees_owed: new BN(0) });
    const e = parseCofferPoolEvents([eventLog(idl, "SwapV2", {
      pool: key(1), user: key(2), token_in_index: 0, token_out_index: 1, amount_in: new BN(1_000_000), transfer_fee_in: new BN(0), amount_in_net: new BN(1_000_000),
      swap_fee_rate: 3000, effective_fee_rate: 50_000, protocol_fee_rate: 1000, creator_fee_bps: 0, fee_amount: q.feeAmount, protocol_fee_amount: q.protocolFeeAmount, creator_fee_amount: new BN(0),
      amount_out_gross: q.grossAmountOut, surge_fee_amount: new BN(0), surge_protocol_fee_amount: new BN(0), surge_creator_fee_amount: new BN(0), amount_out: q.amountOut, transfer_fee_out: new BN(0),
      in_before: slot(10), in_after: slot(11), out_before: slot(10), out_after: slot(9), timestamp: new BN(1), selloff_window: null,
    })])[0] as SwapV2Event;
    expect(e.kind).toBe("SwapV2"); expect(e.effectiveFeeRate).toBe(q.effectiveFeeRate); expect(e.swapFeeRate).toBe(3000); expect(e.feeAmount.toString()).toBe(q.feeAmount.toString());
  });
  test("[P09] HookInvoked.fee_override is the RAW value; the clamp is what SwapV2 reports", () => {
    const h = parseCofferPoolEvents([eventLog(idl, "HookInvoked", { pool: key(1), hook_program: key(41), callback: 1, verdict: 0, has_fee_override: true, fee_override: 999_999, cu_used: 5_340, timestamp: new BN(1) })])[0] as HookInvokedEvent;
    expect(h.kind).toBe("HookInvoked"); expect(h.feeOverride).toBe(999_999); expect(h.callback).toBe(HOOK_CALLBACKS[1].index); expect(HOOK_CALLBACKS[h.callback].name).toBe("before-swap");
    expect(clampHookFeeOverride(h.feeOverride, 100, 50_000)).toBe(50_000);
  });
  test("[P10] the bypass receipt is LiquidityRemovedV2 { hooks_bypassed: true }; PoolHookDisabledSet (PA) decodes with the hook program", () => {
    const v2 = (x: number) => [new BN(x), new BN(x)];
    const e = parseCofferPoolEvents([eventLog(idl, "LiquidityRemovedV2", {
      pool: key(1), user: key(2), requested_lp: new BN(9), lp_amount: new BN(9), token_amounts: v2(1), surge_amounts: v2(0), withdraw_fee_amounts: v2(0), withdraw_fee_bps: 0, transfer_fees_out: v2(0),
      hooks_bypassed: true, lp_supply_before: new BN(100), lp_supply_after: new BN(91), virtual_balances_before: v2(20), virtual_balances_after: v2(19), actual_balances_before: v2(10), actual_balances_after: v2(9),
      surge_fees_owed_before: v2(0), surge_fees_owed_after: v2(0), timestamp: new BN(1),
    })])[0] as LiquidityRemovedV2Event;
    expect(e.hooksBypassed).toBe(true);
    const d = parseCofferPoolEvents([eventLog(pa, "PoolHookDisabledSet", { treasury: key(1), pool: key(2), hook_program: key(41), old_disabled: false, new_disabled: true, admin: key(3), timestamp: new BN(1) })])[0] as any;
    expect(d.kind).toBe("PoolHookDisabledSet"); expect(d.hookProgram.equals(key(41))).toBe(true); expect(d.newDisabled).toBe(true);
  });
});

// ── negative ────────────────────────────────────────────────────────────────

describe("T9 on the final ABI — refusals", () => {
  test("[N01] a hooked pool refuses a missing / short / mis-ordered / signer / writable-program slice on every op", () => {
    const pool = hooked(), user = pk(), slice = sliceOf(pool);
    const ops: Array<[string, (hookAccounts?: typeof slice) => unknown]> = [
      ["swap", (h) => buildSwapIx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1_000), minAmountOut: new BN(1), hookAccounts: h })],
      ["add_liquidity", (h) => buildAddLiquidityIx(cfg, pool, { user, tokenAmounts: [new BN(1_000), new BN(1_000)], minimumLpAmount: new BN(1), hookAccounts: h })],
      ["remove_liquidity", (h) => buildRemoveLiquidityIx(cfg, pool, { user, lpAmount: new BN(1_000), minimumTokenAmounts: [new BN(0), new BN(0)], hookAccounts: h })],
    ];
    for (const [name, build] of ops) {
      expect(() => build(undefined)).toThrow(new RegExp(`${name}.*HookAccountsInvalid`));
      expect(() => build(slice.slice(0, 2))).toThrow(/HookAccountsInvalid/);
      expect(() => build([slice[1], slice[0], slice[2]])).toThrow(/hookAccounts\[0\] must be the hook program/);
      expect(() => build([slice[0], { ...slice[1], pubkey: pk() }, slice[2]])).toThrow(/HOOK_CALLER/);
      expect(() => build([slice[0], slice[1], { ...slice[2], isSigner: true }])).toThrow(/cannot be signers/);
      expect(() => build([{ ...slice[0], isWritable: true }, slice[1], slice[2]])).toThrow(/read-only/);
    }
  });
  test("[N02] a disabled hook takes no slice; the bypass never takes one", () => {
    const disabled = hooked({ hook: { program: key(41), flags: HOOK_FLAGS.ALL_CALLBACKS, accountsLen: 3, disabled: true } }), user = pk();
    const slice = [{ pubkey: key(41), isSigner: false, isWritable: false }, { pubkey: hookCallerPda(cfg.programs.cofferPool)[0], isSigner: false, isWritable: false }, { pubkey: key(42), isSigner: false, isWritable: true }];
    expect(() => buildSwapIx(cfg, disabled, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1_000), minAmountOut: new BN(1), hookAccounts: slice })).toThrow(/disabled.*slice must be absent/);
    expect(() => buildSwapIx(cfg, disabled, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1_000), minAmountOut: new BN(1) })).not.toThrow();
    expect(() => buildRemoveLiquidityBypassHooksIx(cfg, hooked(), { user, lpAmount: new BN(1_000), minimumTokenAmounts: [new BN(0), new BN(0)], hookAccounts: slice })).toThrow(/never takes a hook slice/);
    expect(() => hookAccountSliceFor(cfg, mockPool(), [{ pubkey: key(42), isSigner: false, isWritable: true }])).toThrow(/no active hook/);
  });
  test("[N03] initialize_pool: slice without config, wrong slice length, wrong program first, a signer in the slice", () => {
    const base = { payer: pk(), configKey: pk(), poolId: new BN(1), tokens: [pk(), pk()], weightsBps: [5000, 5000], virtualBalances: [new BN(1_000_000_000), new BN(1_000_000_000)], swapFeeRate: 3000, lpMetadata: LP_METADATA_GOOD };
    const cfgHook = { program: key(41), flags: HOOK_FLAGS.BEFORE_SWAP, feeMin: 0, feeMax: 0, maxCu: 50_000, accountsLen: 2 };
    const slice = [{ pubkey: key(41), isSigner: false, isWritable: false }, { pubkey: hookCallerPda(cfg.programs.cofferPool)[0], isSigner: false, isWritable: false }];
    expect(() => buildInitializePoolIx(cfg, { ...base, hookAccounts: slice })).toThrow(/without a hookConfig/);
    expect(() => buildInitializePoolIx(cfg, { ...base, hookConfig: cfgHook, hookAccounts: slice.slice(0, 1) })).toThrow(/HookAccountsInvalid/);
    expect(() => buildInitializePoolIx(cfg, { ...base, hookConfig: cfgHook, hookAccounts: [slice[1], slice[0]] })).toThrow(/hookAccounts\[0\] must be the hook program/);
    expect(() => buildInitializePoolIx(cfg, { ...base, hookConfig: cfgHook, hookAccounts: [slice[0], { ...slice[1], isSigner: true }] })).toThrow(/cannot be signers/);
    expect(() => buildInitializePoolIx(cfg, { ...base, hookConfig: { ...cfgHook, flags: HOOK_FLAGS.DYNAMIC_FEE } })).toThrow(/HookInvalidConfig/);
  });
  test("[N04] hookFeeOverride: refused without an active DYNAMIC_FEE hook, out of range, or with feeMin > feeMax", () => {
    expect(fail(clientFor(hooked({ hook: { program: key(41), flags: HOOK_FLAGS.BEFORE_SWAP, accountsLen: 2 } })).quoteSwap(0, 1, new BN(1_000), { hookFeeOverride: 100 })).code).toBe("invalid_input");
    expect(fail(clientFor(hooked({ hook: { program: key(41), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMax: 100, accountsLen: 2, disabled: true } })).quoteSwap(0, 1, new BN(1_000), { hookFeeOverride: 100 })).code).toBe("invalid_input");
    for (const v of [-1, 1_000_001, 0.5, NaN]) expect(fail(clientFor(hooked({ hook: { program: key(41), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.DYNAMIC_FEE, feeMax: 100, accountsLen: 2 } })).quoteSwap(0, 1, new BN(1_000), { hookFeeOverride: v })).code).toBe("invalid_input");
    expect(() => clampHookFeeOverride(5, 10, 1)).toThrow(/InvalidHookConfig/);
    expect(() => clampHookFeeOverride(1_000_001, 0, 1_000_000)).toThrow(/outside/);
  });
  test("[N05] PAUSE_WHEN_DISABLED + disabled: swaps and deposits are hook_rejected (HookPaused), exits still quote", () => {
    const paused = hooked({ hook: { program: key(41), flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.PAUSE_WHEN_DISABLED, accountsLen: 2, disabled: true } });
    const c = clientFor(paused);
    expect(fail(c.quoteSwap(0, 1, new BN(1_000))).code).toBe("hook_rejected");
    expect(fail(c.quoteAddLiquidity([new BN(1_000), new BN(1_000)])).code).toBe("hook_rejected");
    expect(fail(c.quoteSeedDeposit(key(3), [new BN(1), new BN(1)])).code).not.toBe("hook_rejected"); // already seeded: a different refusal first
    expect(c.quoteRemove(new BN(1_000_000)).ok).toBe(true);
    expect(fail(c.buildSwapTx({ user: pk(), tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1_000) })).code).toBe("hook_rejected");
  });
  test("[N06] hook events cut inside a field or with a non-canonical bool are Unknown, never half values", () => {
    const full = Buffer.from(eventLog(idl, "HookInvoked", { pool: key(1), hook_program: key(41), callback: 1, verdict: 0, has_fee_override: true, fee_override: 7, cu_used: 5, timestamp: new BN(1) }).slice("Program data: ".length), "base64");
    expect(parseCofferPoolEvents([`Program data: ${full.subarray(0, full.length - 3).toString("base64")}`])[0].kind).toBe("Unknown");
    const bad = Buffer.from(full); bad[8 + 64 + 2] = 2; // has_fee_override = 2
    expect(parseCofferPoolEvents([`Program data: ${bad.toString("base64")}`])[0].kind).toBe("Unknown");
    const set = Buffer.from(eventLog(idl, "HookDisabledSet", { pool: key(1), authority: key(2), old_disabled: false, new_disabled: true, pause_when_disabled: true, timestamp: new BN(1) }).slice("Program data: ".length), "base64");
    set[8 + 64 + 1] = 9;
    expect(parseCofferPoolEvents([`Program data: ${set.toString("base64")}`])[0].kind).toBe("Unknown");
  });
  test("[N07] set_hook_disabled refuses a non-boolean; the PA wrapper refuses a stray account through the IDL coder", async () => {
    expect(() => buildSetHookDisabledIx(cfg, pk(), pk(), pk(), "yes" as unknown as boolean)).toThrow(/boolean/);
    const admin = Keypair.generate();
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(admin), {}) });
    expect(() => client.setHookDisabledIx(admin.publicKey, pk(), pk(), 1 as unknown as boolean)).toThrow(/must be boolean/);
  });
});
