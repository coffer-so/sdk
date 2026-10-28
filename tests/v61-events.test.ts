/**
 * v6.1 (T4) event parsing: every append-only tail (T2 / T15 / T14 / T12 /
 * T7 / T3 / T9 / T5 / T1), the pre-upgrade log shapes (tails absent →
 * defaults), the new v6.1 events through the generic decoder, and the error
 * code map (6070–6103, protocol-admin 6010–6018).
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { IDLS } from "../src/idl";
import { parseCofferPoolEvents } from "../src/parsers/events";
import { parseContractEvents } from "../src/parsers/contracts";
import { describeProgramError, toSdkError, contractErrorMapForTests } from "../src/utils/errors";
import { eventLog, truncatedEventLog, normalize } from "./helpers/borshFixture";
import type { SwapEvent, LiquidityAddedEvent, LiquidityRemovedEvent, PoolInitializedEvent, PoolStateLogEvent, PoolInfoEvent, ProtocolFeesCollectedEvent } from "../src/types/events";

const idl = IDLS.cofferPool as any;
const pa = IDLS.protocolAdmin as any;
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const bn = (v: number | string | bigint) => new BN(v.toString());
const fieldsOf = (name: string): string[] => idl.types.find((t: any) => t.name === name).type.fields.map((f: any) => f.name);
const disc = (name: string, which: any = idl) => Buffer.from(which.events.find((e: any) => e.name === name).discriminator).toString("hex");

// ── idl/abi-pins.json (contracts v6.1 @ T9 merge), verbatim ─────────────────
const PINNED_EVENTS: Record<string, string> = {
  Swap: "516ce3becdd00ac4", LiquidityAdded: "9a1add6cee40d9a1", LiquidityRemoved: "e169d8277c74a9bd", PoolInitialized: "6476ad570cc6fee5",
  PoolStateLog: "3bfeed6fa30a8ce0", PoolInfo: "cf145761fbd4ea2d", ProtocolFeesCollected: "a5227d9b0f5663bf", PoolLayoutMigrated: "d76c54bce76b958b",
  SidelinedTokenFunded: "66b6f2f4a938371e", CreatorFeeBpsUpdated: "daac9f0e72c734f6", CreatorFeesClaimed: "bdb215b5abb38301", RangeManagerLocked: "0439dd3ab121b956",
  LiquidityFeesUpdated: "d416863ab8626d7a", LiquidityFeesLocked: "32ccabf97d4a7a00", PoolActionProposed: "643d9bd50da52d88", PoolActionExecuted: "9111bccbd7911a49",
  PoolActionCancelled: "41c24ba08a8df701", PoolAdminDelayChanged: "20543aa252b068a2", HookInvoked: "c911e873727c14a6", HookDisabledSet: "2fd46b429e9ded90",
};
const PINNED_PA_EVENTS: Record<string, string> = {
  PoolRangeManagerDisabled: "931705931347901b", ActionProposed: "d132e8dfcec20f43", ActionExecuted: "74659224a099b6e9", ActionCancelled: "79d5cd1de2b5e60d",
  TreasuryDelayChanged: "0f6da496a64677fd", TreasuryLayoutMigrated: "9b65b4d1089b0305", PoolHookDisabledSet: "31a23aae65056678",
};
const PINNED_ERRORS: Record<number, string> = {
  6070: "LayoutVersionMismatch", 6071: "AlreadyMigrated", 6072: "PinnedDecimalsMismatch", 6073: "PoolAlreadySeeded", 6074: "InitialLpSupplyTooLarge",
  6075: "TokenNotSidelined", 6076: "LpNameInvalid", 6077: "LpSymbolInvalid", 6078: "LpUriInvalid", 6079: "CreatorFeeBpsMaxExceeded", 6080: "CreatorFeesUnclaimed",
  6081: "RangeManagerLocked", 6082: "RangeManagerMustBeUnset", 6083: "LiquidityFeeMaxExceeded", 6084: "LiquidityFeesLocked", 6085: "LiquidityFeesAlreadyLocked",
  6086: "DepositFeeConsumesAll", 6087: "WithdrawFeeConsumesAll", 6088: "SurgeBucketOverflow", 6089: "CooldownRequired", 6090: "CooldownNotElapsed",
  6091: "NoPendingAction", 6092: "ActionExpired", 6093: "DelayTooLarge", 6094: "PendingPayloadMismatch", 6095: "HookDenied", 6096: "HookInvalidResponse",
  6097: "HookCuExceeded", 6098: "HookInvalidConfig", 6099: "HookAccountsInvalid", 6100: "HookProgramInvalid", 6101: "HookPaused", 6102: "HookRegisterRejected",
  6103: "HookFlagsMismatch",
};
const PINNED_PA_ERRORS: Record<number, string> = {
  6010: "CooldownRequired", 6011: "CooldownNotElapsed", 6012: "NoPendingAction", 6013: "ActionExpired", 6014: "DelayTooLarge", 6015: "PendingAccountsMismatch",
  6016: "BufferAuthorityMismatch", 6017: "AlreadyMigrated", 6018: "InvalidPendingAdmin",
};

const swapValue = () => ({
  pool: key(1), user: key(2), token_in: key(3), token_out: key(4), amount_in: bn("18446744073709551615"), amount_out: bn(990), fee_amount: bn(30),
  protocol_fee_amount: bn(3), timestamp: bn(-1700000000), surge_fee_amount: bn(10), transfer_fee_in: bn(1), transfer_fee_out: bn(2), swap_fee_rate: 3000,
  protocol_fee_rate: 1000, surge_protocol_fee_amount: bn(1), creator_fee_amount: bn(6), surge_creator_fee_amount: bn(2), creator_fee_bps: 2500,
  surge_fee_lp_amount: bn(7), effective_fee_rate: 2500,
});
const addedValue = () => ({
  pool: key(1), user: key(2), token_amounts: [bn(100), bn(0), bn(300)], lp_amount: bn(995), timestamp: bn(1700000000), is_seed: true,
  credited_amounts: [bn(99), bn(0), bn(297)], lp_supply_before: bn(0), lp_supply_after: bn(995), initial_lp_supply: bn(1_000_000_000), deposit_fee_lp: bn(5),
  deposit_fee_bps: 50, surge_buy_in: [bn(1), bn(0), bn(3)],
});
const removedValue = () => ({
  pool: key(1), user: key(2), lp_amount: bn(500), token_amounts: [bn(90), bn(0)], timestamp: bn(1700000001), withdraw_fee_amounts: [bn(10), bn(0)],
  withdraw_fee_bps: 1000, lp_supply_before: bn(1000), lp_supply_after: bn(500), surge_amounts: [bn(4), bn(0)],
});
const initValue = () => ({
  pool: key(1), config: key(2), token_count: 3, lp_mint: key(3), timestamp: bn(1700000002), banned_extensions: bn(0), pool_id: bn("9007199254740993"),
  lp_name: "USDC-USDT Coffer LP", lp_symbol: "cLP-USDX", lp_uri: "https://arweave.net/abc", lp_token_program: key(9), creator_fee_bps: 2500, deposit_fee_bps: 5,
  withdraw_fee_bps: 7, hook_program: key(41), hook_flags: 0b1110000, hook_fee_min: 100, hook_fee_max: 50000, hook_max_cu: 60000, hook_accounts_len: 4,
});
const stateLogValue = () => ({
  pool: key(1), virtual_balances: [bn(1), bn(2)], actual_balances: [bn(3), bn(4)], protocol_fees_owed: [bn(5), bn(6)], timestamp: bn(1700000003),
  creator_fees_owed: [bn(7), bn(8)], deposit_fee_bps: 5, withdraw_fee_bps: 7, liquidity_fee_lock: 1, surge_fees_owed: [bn(9), bn(10)],
  pool_admin_delay_secs: 86400, pool_admin_epoch: 3, pending_actions_mask: 0b101,
});
const infoValue = () => ({
  pool: key(1), config: key(2), lp_mint: key(3), token_count: 2, pool_id: bn(5), tokens: [key(10), key(11)], token_vaults: [key(20), key(21)],
  normalized_weights: [bn(5000), bn(5000)], virtual_balances: [bn(1), bn(2)], actual_balances: [bn(3), bn(4)], protocol_fees_owed: [bn(5), bn(6)],
  swap_fee_rate: 3000, protocol_fee_rate: 1000, pool_enabled: true, swaps_enabled: false, token_programs: [key(30), key(31)], timestamp: bn(1700000004),
  creator_fee_bps: 2500, creator_fees_owed: [bn(7), bn(8)], range_manager_locked: true, deposit_fee_bps: 5, withdraw_fee_bps: 7, liquidity_fee_lock: 1,
  surge_fees_owed: [bn(9), bn(10)], pool_admin_delay_secs: 86400, pool_admin_epoch: 3, pending_actions_mask: 0b11, pending_etas: [bn(1), bn(2), bn(0), bn(0), bn(0), bn(0), bn(0), bn(0), bn(0), bn(0), bn(-5)],
  hook_program: key(41), hook_flags: 0b1110000, hook_disabled: 1, hook_fee_min: 100, hook_fee_max: 50000, hook_max_cu: 60000, hook_accounts_len: 4,
});

const one = <T>(log: string): T => {
  const out = parseCofferPoolEvents([log]);
  expect(out).toHaveLength(1);
  return out[0] as unknown as T;
};

// ── positive ────────────────────────────────────────────────────────────────

describe("event discriminators and tails are pinned to idl/abi-pins.json", () => {
  test("[P01] every pinned coffer_pool / protocol_admin event discriminator matches the shipped IDL", () => {
    for (const [name, hex] of Object.entries(PINNED_EVENTS)) expect(disc(name)).toBe(hex);
    for (const [name, hex] of Object.entries(PINNED_PA_EVENTS)) expect(disc(name, pa)).toBe(hex);
  });
  test("[P02] appended tails sit in the documented order", () => {
    expect(fieldsOf("Swap").slice(-8)).toEqual(["swap_fee_rate", "protocol_fee_rate", "surge_protocol_fee_amount", "creator_fee_amount", "surge_creator_fee_amount", "creator_fee_bps", "surge_fee_lp_amount", "effective_fee_rate"]);
    expect(fieldsOf("LiquidityAdded").slice(5)).toEqual(["is_seed", "credited_amounts", "lp_supply_before", "lp_supply_after", "initial_lp_supply", "deposit_fee_lp", "deposit_fee_bps", "surge_buy_in"]);
    expect(fieldsOf("LiquidityRemoved").slice(5)).toEqual(["withdraw_fee_amounts", "withdraw_fee_bps", "lp_supply_before", "lp_supply_after", "surge_amounts"]);
    expect(fieldsOf("PoolInitialized").slice(7)).toEqual(["lp_name", "lp_symbol", "lp_uri", "lp_token_program", "creator_fee_bps", "deposit_fee_bps", "withdraw_fee_bps", "hook_program", "hook_flags", "hook_fee_min", "hook_fee_max", "hook_max_cu", "hook_accounts_len"]);
    expect(fieldsOf("PoolStateLog").slice(5)).toEqual(["creator_fees_owed", "deposit_fee_bps", "withdraw_fee_bps", "liquidity_fee_lock", "surge_fees_owed", "pool_admin_delay_secs", "pool_admin_epoch", "pending_actions_mask"]);
    expect(fieldsOf("PoolInfo").slice(17)).toEqual(["creator_fee_bps", "creator_fees_owed", "range_manager_locked", "deposit_fee_bps", "withdraw_fee_bps", "liquidity_fee_lock", "surge_fees_owed", "pool_admin_delay_secs", "pool_admin_epoch", "pending_actions_mask", "pending_etas", "hook_program", "hook_flags", "hook_disabled", "hook_fee_min", "hook_fee_max", "hook_max_cu", "hook_accounts_len"]);
    expect(fieldsOf("ProtocolFeesCollected").slice(-1)).toEqual(["recipients"]);
  });
});

describe("Swap", () => {
  test("[P03] full v6.1 log: every tail field is typed", () => {
    const e = one<SwapEvent>(eventLog(idl, "Swap", swapValue()));
    expect(e.kind).toBe("Swap"); expect(e.amountIn.toString()).toBe("18446744073709551615"); expect(e.timestamp).toBe(-1700000000);
    expect(e.surgeFeeAmount.toNumber()).toBe(10); expect(e.transferFeeIn.toNumber()).toBe(1); expect(e.transferFeeOut.toNumber()).toBe(2);
    expect(e.swapFeeRate).toBe(3000); expect(e.protocolFeeRate).toBe(1000); expect(e.surgeProtocolFeeAmount.toNumber()).toBe(1);
    expect(e.creatorFeeAmount.toNumber()).toBe(6); expect(e.surgeCreatorFeeAmount.toNumber()).toBe(2); expect(e.creatorFeeBps).toBe(2500);
    expect(e.surgeFeeLpAmount.toNumber()).toBe(7); expect(e.effectiveFeeRate).toBe(2500); expect(e.v61Tail).toBe(true);
  });
  test("[P04] the typed decoder agrees with the generic IDL decoder field by field", () => {
    const log = eventLog(idl, "Swap", swapValue());
    const generic = parseContractEvents([log], "cofferPool")[0].data as any;
    const typed = one<SwapEvent>(log) as any;
    for (const f of fieldsOf("Swap")) {
      const camel = f.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const expected = f === "timestamp" ? generic[f].toNumber() : generic[f];
      expect(normalize(typed[camel])).toEqual(normalize(expected));
    }
  });
  test("[P05] a v5 log (prefix + surge only) decodes with zero tails and v61Tail=false", () => {
    const e = one<SwapEvent>(truncatedEventLog(idl, "Swap", swapValue(), 10));
    expect(e.surgeFeeAmount.toNumber()).toBe(10); expect(e.transferFeeIn.isZero()).toBe(true); expect(e.swapFeeRate).toBe(0);
    expect(e.creatorFeeBps).toBe(0); expect(e.surgeFeeLpAmount.isZero()).toBe(true); expect(e.effectiveFeeRate).toBe(0); expect(e.v61Tail).toBe(false);
  });
  test("[P06] a v6 log (through transfer_fee_out) keeps the transfer fees and defaults the v6.1 tail", () => {
    const e = one<SwapEvent>(truncatedEventLog(idl, "Swap", swapValue(), 12));
    expect(e.transferFeeOut.toNumber()).toBe(2); expect(e.protocolFeeRate).toBe(0); expect(e.v61Tail).toBe(false);
  });
  test("[P07] a T15-era log (no T14/T12/T9 tails) reports effective_fee_rate = swap_fee_rate", () => {
    const e = one<SwapEvent>(truncatedEventLog(idl, "Swap", swapValue(), 15));
    expect(e.swapFeeRate).toBe(3000); expect(e.effectiveFeeRate).toBe(3000); expect(e.creatorFeeAmount.isZero()).toBe(true); expect(e.v61Tail).toBe(false);
  });
});

describe("LiquidityAdded / LiquidityRemoved", () => {
  test("[P08] full LiquidityAdded tail (T2 + T7 + T12)", () => {
    const e = one<LiquidityAddedEvent>(eventLog(idl, "LiquidityAdded", addedValue()));
    expect(e.isSeed).toBe(true); expect(e.creditedAmounts.map(Number)).toEqual([99, 0, 297]); expect(e.lpSupplyBefore.isZero()).toBe(true);
    expect(e.lpSupplyAfter.toNumber()).toBe(995); expect(e.initialLpSupply.toNumber()).toBe(1_000_000_000); expect(e.depositFeeLp.toNumber()).toBe(5);
    expect(e.depositFeeBps).toBe(50); expect(e.surgeBuyIn.map(Number)).toEqual([1, 0, 3]); expect(e.v61Tail).toBe(true);
  });
  test("[P09] pre-v6.1 LiquidityAdded (5 fields) decodes with defaults", () => {
    const e = one<LiquidityAddedEvent>(truncatedEventLog(idl, "LiquidityAdded", addedValue(), 5));
    expect(e.lpAmount.toNumber()).toBe(995); expect(e.isSeed).toBe(false); expect(e.creditedAmounts).toEqual([]); expect(e.surgeBuyIn).toEqual([]); expect(e.v61Tail).toBe(false);
  });
  test("[P10] a T2-era LiquidityAdded (10 fields) has the seed tail but no fee / buy-in", () => {
    const e = one<LiquidityAddedEvent>(truncatedEventLog(idl, "LiquidityAdded", addedValue(), 10));
    expect(e.initialLpSupply.toNumber()).toBe(1_000_000_000); expect(e.depositFeeBps).toBe(0); expect(e.surgeBuyIn).toEqual([]); expect(e.v61Tail).toBe(false);
  });
  test("[P11] full LiquidityRemoved tail (T7 + T12)", () => {
    const e = one<LiquidityRemovedEvent>(eventLog(idl, "LiquidityRemoved", removedValue()));
    expect(e.tokenAmounts.map(Number)).toEqual([90, 0]); expect(e.withdrawFeeAmounts.map(Number)).toEqual([10, 0]); expect(e.withdrawFeeBps).toBe(1000);
    expect(e.lpSupplyBefore.toNumber()).toBe(1000); expect(e.lpSupplyAfter.toNumber()).toBe(500); expect(e.surgeAmounts.map(Number)).toEqual([4, 0]); expect(e.v61Tail).toBe(true);
  });
  test("[P12] pre-v6.1 LiquidityRemoved decodes with defaults", () => {
    const e = one<LiquidityRemovedEvent>(truncatedEventLog(idl, "LiquidityRemoved", removedValue(), 5));
    expect(e.withdrawFeeAmounts).toEqual([]); expect(e.withdrawFeeBps).toBe(0); expect(e.surgeAmounts).toEqual([]); expect(e.v61Tail).toBe(false);
  });
  test("[P13] generic parity for LiquidityAdded / LiquidityRemoved", () => {
    for (const [name, value] of [["LiquidityAdded", addedValue()], ["LiquidityRemoved", removedValue()]] as const) {
      const log = eventLog(idl, name, value);
      const generic = parseContractEvents([log], "cofferPool")[0].data as any;
      const typed = one<any>(log);
      for (const f of fieldsOf(name)) {
        const camel = f.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        expect(normalize(typed[camel])).toEqual(normalize(f === "timestamp" ? generic[f].toNumber() : generic[f]));
      }
    }
  });
});

describe("PoolInitialized / PoolStateLog / PoolInfo / ProtocolFeesCollected", () => {
  test("[P14] full PoolInitialized tail (T1 strings, T14, T7, T9)", () => {
    const e = one<PoolInitializedEvent>(eventLog(idl, "PoolInitialized", initValue()));
    expect(e.poolId.toString()).toBe("9007199254740993"); expect(e.lpName).toBe("USDC-USDT Coffer LP"); expect(e.lpSymbol).toBe("cLP-USDX");
    expect(e.lpUri).toBe("https://arweave.net/abc"); expect(e.lpTokenProgram.equals(key(9))).toBe(true); expect(e.creatorFeeBps).toBe(2500);
    expect(e.depositFeeBps).toBe(5); expect(e.withdrawFeeBps).toBe(7); expect(e.hookProgram.equals(key(41))).toBe(true); expect(e.hookFlags).toBe(0b1110000);
    expect(e.hookFeeMin).toBe(100); expect(e.hookFeeMax).toBe(50000); expect(e.hookMaxCu).toBe(60000); expect(e.hookAccountsLen).toBe(4);
  });
  test("[P15] unicode LP names round-trip", () => {
    const v = initValue(); v.lp_name = "Café Пул LP";
    expect(one<PoolInitializedEvent>(eventLog(idl, "PoolInitialized", v)).lpName).toBe(v.lp_name);
  });
  test("[P16] a v6 PoolInitialized (through pool_id) defaults the v6.1 tail", () => {
    const e = one<PoolInitializedEvent>(truncatedEventLog(idl, "PoolInitialized", initValue(), 7));
    expect(e.poolId.toString()).toBe("9007199254740993"); expect(e.lpName).toBe(""); expect(e.lpTokenProgram.equals(PublicKey.default)).toBe(true);
    expect(e.hookProgram.equals(PublicKey.default)).toBe(true); expect(e.hookAccountsLen).toBe(0);
  });
  test("[P17] a v5 PoolInitialized (no pool_id) still decodes", () => {
    const e = one<PoolInitializedEvent>(truncatedEventLog(idl, "PoolInitialized", initValue(), 5));
    expect(e.poolId.isZero()).toBe(true); expect(e.deprecatedBannedExtensions.isZero()).toBe(true);
  });
  test("[P18] full PoolStateLog tail (T14, T7, T12, T3)", () => {
    const e = one<PoolStateLogEvent>(eventLog(idl, "PoolStateLog", stateLogValue()));
    expect(e.creatorFeesOwed.map(Number)).toEqual([7, 8]); expect(e.depositFeeBps).toBe(5); expect(e.withdrawFeeBps).toBe(7); expect(e.liquidityFeeLock).toBe(1);
    expect(e.surgeFeesOwed.map(Number)).toEqual([9, 10]); expect(e.poolAdminDelaySecs).toBe(86400); expect(e.poolAdminEpoch).toBe(3); expect(e.pendingActionsMask).toBe(0b101); expect(e.v61Tail).toBe(true);
  });
  test("[P19] pre-v6.1 PoolStateLog (5 fields) decodes with defaults", () => {
    const e = one<PoolStateLogEvent>(truncatedEventLog(idl, "PoolStateLog", stateLogValue(), 5));
    expect(e.protocolFeesOwed.map(Number)).toEqual([5, 6]); expect(e.creatorFeesOwed).toEqual([]); expect(e.surgeFeesOwed).toEqual([]); expect(e.pendingActionsMask).toBe(0); expect(e.v61Tail).toBe(false);
  });
  test("[P20] full PoolInfo tail incl. pending_etas (signed) and the hook block", () => {
    const e = one<PoolInfoEvent>(eventLog(idl, "PoolInfo", infoValue()));
    expect(e.kind).toBe("PoolInfo"); expect(e.tokens[1].equals(key(11))).toBe(true); expect(e.swapsEnabled).toBe(false);
    expect(e.creatorFeeBps).toBe(2500); expect(e.rangeManagerLocked).toBe(true); expect(e.liquidityFeeLock).toBe(1); expect(e.surgeFeesOwed.map(Number)).toEqual([9, 10]);
    expect(e.pendingEtas).toHaveLength(11); expect(e.pendingEtas[10].toString()).toBe("-5"); expect(e.pendingActionsMask).toBe(0b11);
    expect(e.hookProgram.equals(key(41))).toBe(true); expect(e.hookDisabled).toBe(1); expect(e.hookAccountsLen).toBe(4); expect(e.v61Tail).toBe(true);
  });
  test("[P21] pre-v6.1 PoolInfo (17 fields) decodes with defaults", () => {
    const e = one<PoolInfoEvent>(truncatedEventLog(idl, "PoolInfo", infoValue(), 17));
    expect(e.timestamp).toBe(1700000004); expect(e.creatorFeeBps).toBe(0); expect(e.pendingEtas).toEqual([]); expect(e.hookProgram.equals(PublicKey.default)).toBe(true); expect(e.v61Tail).toBe(false);
  });
  test("[P22] generic parity for PoolInitialized / PoolStateLog / PoolInfo", () => {
    for (const [name, value] of [["PoolInitialized", initValue()], ["PoolStateLog", stateLogValue()], ["PoolInfo", infoValue()]] as const) {
      const log = eventLog(idl, name, value);
      const generic = parseContractEvents([log], "cofferPool")[0].data as any;
      const typed = one<any>(log);
      for (const f of fieldsOf(name)) {
        const camel = f === "banned_extensions" ? "deprecatedBannedExtensions" : f.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        expect(normalize(typed[camel])).toEqual(normalize(f === "timestamp" ? generic[f].toNumber() : generic[f]));
      }
    }
  });
  test("[P23] ProtocolFeesCollected recipients (T5) and the pre-T5 shape", () => {
    const v = { pool: key(1), authority: key(2), token_amounts: [bn(1), bn(0)], timestamp: bn(5), recipients: [key(70), key(1)] };
    const e = one<ProtocolFeesCollectedEvent>(eventLog(idl, "ProtocolFeesCollected", v));
    expect(e.recipients.map((k) => k.toBase58())).toEqual([key(70).toBase58(), key(1).toBase58()]);
    expect(one<ProtocolFeesCollectedEvent>(truncatedEventLog(idl, "ProtocolFeesCollected", v, 4)).recipients).toEqual([]);
  });
});

describe("new v6.1 events decode through the generic IDL path", () => {
  const cases: Array<[string, any, (e: any) => void]> = [
    ["PoolLayoutMigrated", { pool: key(1), payer: key(2), old_len: 1683, new_len: 2304, layout_version: 1, timestamp: bn(9) }, (e) => { expect(e.oldLen).toBe(1683); expect(e.newLen).toBe(2304); expect(e.layoutVersion).toBe(1); expect(e.timestamp).toBe(9); }],
    ["SidelinedTokenFunded", { pool: key(1), authority: key(2), token_index: 2, amount_charged: bn(100), amount_credited: bn(99), actual_after: bn(99), virtual_balance: bn(5), lp_supply: bn(7), timestamp: bn(1) }, (e) => { expect(e.tokenIndex).toBe(2); expect(e.amountCredited.toNumber()).toBe(99); expect(e.virtualBalance.toNumber()).toBe(5); }],
    ["CreatorFeeBpsUpdated", { pool: key(1), authority: key(2), old_bps: 0, new_bps: 2500, timestamp: bn(1) }, (e) => { expect(e.oldBps).toBe(0); expect(e.newBps).toBe(2500); }],
    ["CreatorFeesClaimed", { pool: key(1), authority: key(2), token_amounts: [bn(1), bn(2)], timestamp: bn(1) }, (e) => expect(e.tokenAmounts.map(Number)).toEqual([1, 2])],
    ["RangeManagerLocked", { pool: key(1), authority: key(2), timestamp: bn(3) }, (e) => expect(e.authority.equals(key(2))).toBe(true)],
    ["LiquidityFeesUpdated", { pool: key(1), authority: key(2), old_deposit_fee_bps: 0, old_withdraw_fee_bps: 0, new_deposit_fee_bps: 5, new_withdraw_fee_bps: 7, timestamp: bn(1) }, (e) => { expect(e.newDepositFeeBps).toBe(5); expect(e.newWithdrawFeeBps).toBe(7); }],
    ["LiquidityFeesLocked", { pool: key(1), authority: key(2), deposit_fee_bps: 5, withdraw_fee_bps: 7, timestamp: bn(1) }, (e) => expect(e.withdrawFeeBps).toBe(7)],
    ["PoolActionProposed", { pool: key(1), authority: key(2), kind: 2, payload: Buffer.from([1, 0x88, 0x13, 0, 0]), eta: bn(1700000000), epoch: 3, timestamp: bn(1) }, (e) => { expect(e.kind).toBe("PoolActionProposed"); expect(e.actionKind).toBe(2); expect([...e.payload]).toEqual([1, 0x88, 0x13, 0, 0]); expect(e.eta.toNumber()).toBe(1700000000); expect(e.epoch).toBe(3); }],
    ["PoolActionExecuted", { pool: key(1), authority: key(2), kind: 9, eta: bn(5), epoch: 1, timestamp: bn(6) }, (e) => { expect(e.actionKind).toBe(9); expect(e.eta.toNumber()).toBe(5); }],
    ["PoolActionCancelled", { pool: key(1), authority: key(2), kind: 10, eta: bn(5), timestamp: bn(6) }, (e) => expect(e.actionKind).toBe(10)],
    ["PoolAdminDelayChanged", { pool: key(1), authority: key(2), old_delay_secs: 0, new_delay_secs: 86400, timestamp: bn(6) }, (e) => expect(e.newDelaySecs).toBe(86400)],
    ["HookInvoked", { pool: key(1), hook_program: key(41), callback: 1, verdict: 0, has_fee_override: true, fee_override: 123456, cu_used: 5340, timestamp: bn(6) }, (e) => { expect(e.callback).toBe(1); expect(e.hasFeeOverride).toBe(true); expect(e.feeOverride).toBe(123456); expect(e.cuUsed).toBe(5340); }],
    ["HookDisabledSet", { pool: key(1), authority: key(2), old_disabled: false, new_disabled: true, pause_when_disabled: true, timestamp: bn(6) }, (e) => { expect(e.newDisabled).toBe(true); expect(e.pauseWhenDisabled).toBe(true); }],
  ];
  test.each(cases)("[P24] %s", (name, value, check) => {
    const e = one<any>(eventLog(idl, name, value));
    expect(e.kind).toBe(name);
    check(e);
  });
  const paCases: Array<[string, any, (e: any) => void]> = [
    ["ActionProposed", { treasury: key(1), admin: key(2), kind: 11, payload: Buffer.from([10, 1, 2]), eta: bn(7), epoch: 2, timestamp: bn(8) }, (e) => { expect(e.actionKind).toBe(11); expect([...e.payload]).toEqual([10, 1, 2]); }],
    ["ActionExecuted", { treasury: key(1), admin: key(2), kind: 6, eta: bn(7), epoch: 2, timestamp: bn(8) }, (e) => expect(e.actionKind).toBe(6)],
    ["ActionCancelled", { treasury: key(1), authority: key(2), kind: 0, eta: bn(7), timestamp: bn(8) }, (e) => expect(e.actionKind).toBe(0)],
    ["TreasuryDelayChanged", { treasury: key(1), admin: key(2), old_delay_secs: 1, new_delay_secs: 2, timestamp: bn(8) }, (e) => expect(e.newDelaySecs).toBe(2)],
    ["TreasuryLayoutMigrated", { treasury: key(1), admin: key(2), old_len: 818, new_len: 1624, timestamp: bn(8) }, (e) => { expect(e.oldLen).toBe(818); expect(e.newLen).toBe(1624); }],
    ["PoolRangeManagerDisabled", { treasury: key(1), pool: key(2), authority: key(3), manager: key(4), old_enabled: true, timestamp: bn(8) }, (e) => expect(e.oldEnabled).toBe(true)],
    ["PoolHookDisabledSet", { treasury: key(1), pool: key(2), hook_program: key(41), old_disabled: false, new_disabled: true, admin: key(3), timestamp: bn(8) }, (e) => expect(e.hookProgram.equals(key(41))).toBe(true)],
    ["AdminTransferInitiated", { treasury: key(1), current_admin: key(2), pending_admin: key(3), timestamp: bn(8), eta: bn(99) }, (e) => expect(e.eta.toNumber()).toBe(99)],
    ["AdminTransferred", { treasury: key(1), old_admin: key(2), new_admin: key(3), timestamp: bn(8), new_epoch: 4 }, (e) => expect(e.newEpoch).toBe(4)],
  ];
  test.each(paCases)("[P25] protocol_admin %s", (name, value, check) => {
    const e = one<any>(eventLog(pa, name, value));
    expect(e.kind).toBe(name);
    check(e);
  });
  test("[P26] the T3 tails on PoolAdminTransferInitiated / Transferred / Disabled", () => {
    const a = one<any>(eventLog(idl, "PoolAdminTransferInitiated", { pool: key(1), current_admin: key(2), pending_admin: key(3), timestamp: bn(1), eta: bn(77) }));
    expect(a.eta.toNumber()).toBe(77);
    const b = one<any>(eventLog(idl, "PoolAdminTransferred", { pool: key(1), old_admin: key(2), new_admin: key(3), timestamp: bn(1), new_epoch: 5 }));
    expect(b.newEpoch).toBe(5);
    const c = one<any>(eventLog(idl, "PoolAdminDisabled", { pool: key(1), old_admin: key(2), timestamp: bn(1), new_epoch: 6 }));
    expect(c.newEpoch).toBe(6);
  });
});

describe("error code map (v6.1)", () => {
  test("[P27] coffer-pool 6070–6103 names and SDK codes", () => {
    for (const [code, name] of Object.entries(PINNED_ERRORS)) {
      const d = describeProgramError(Number(code), "cofferPool");
      expect(d?.name).toBe(name);
      expect(d?.sdkCode).not.toBe("unknown");
    }
    expect(describeProgramError(6070)?.sdkCode).toBe("pool_layout_outdated");
    expect(describeProgramError(6089)?.sdkCode).toBe("cooldown");
    expect(describeProgramError(6095)?.sdkCode).toBe("hook_rejected");
    expect(describeProgramError(6101)?.sdkCode).toBe("hook_rejected");
    expect(describeProgramError(6086)?.sdkCode).toBe("amount_too_small");
    expect(describeProgramError(6087)?.sdkCode).toBe("amount_too_small");
    expect(describeProgramError(6076)?.sdkCode).toBe("invalid_input");
  });
  test("[P28] protocol-admin 6010–6018", () => {
    for (const [code, name] of Object.entries(PINNED_PA_ERRORS)) expect(describeProgramError(Number(code), "protocolAdmin")?.name).toBe(name);
    expect(describeProgramError(6010, "protocolAdmin")?.sdkCode).toBe("cooldown");
    expect(describeProgramError(6017, "protocolAdmin")?.sdkCode).toBe("unsupported_pool_state");
  });
  test("[P29] toSdkError maps a raw custom program error from either format", () => {
    expect(toSdkError(new Error("custom program error: 0x17b6")).code).toBe("pool_layout_outdated"); // 6070
    expect(toSdkError(new Error("Error Number: 6095")).code).toBe("hook_rejected");
    expect(toSdkError(new Error("Error Number: 6010"), "protocolAdmin").code).toBe("cooldown");
    expect(toSdkError(new Error("Error Number: 6010")).code).toBe("invalid_input"); // coffer-pool 6010 = ProtocolFeeRateMaxExceeded
  });
  test("[P30] the error table is append-only: every code 6000..6103 is defined exactly once", () => {
    const table = contractErrorMapForTests("cofferPool");
    for (let c = 6000; c <= 6103; c++) expect(table[c]).toBeDefined();
    expect(Object.keys(table)).toHaveLength(104);
    expect(Object.keys(contractErrorMapForTests("protocolAdmin"))).toHaveLength(19);
  });
});

// ── negative ────────────────────────────────────────────────────────────────

describe("malformed / foreign logs", () => {
  test("[N01] a Swap log cut inside a field is reported as Unknown, never a half value", () => {
    const full = eventLog(idl, "Swap", swapValue());
    const bytes = Buffer.from(full.slice("Program data: ".length), "base64").subarray(0, 8 + 32 * 4 + 3);
    const out = parseCofferPoolEvents([`Program data: ${bytes.toString("base64")}`]);
    expect(out[0].kind).toBe("Unknown");
  });
  test("[N02] a Vec tail cut inside the vector is Unknown", () => {
    const full = Buffer.from(eventLog(idl, "LiquidityAdded", addedValue()).slice("Program data: ".length), "base64");
    const out = parseCofferPoolEvents([`Program data: ${full.subarray(0, full.length - 3).toString("base64")}`]);
    expect(out[0].kind).toBe("Unknown");
  });
  test("[N03] a PoolInitialized string longer than the buffer is Unknown", () => {
    const full = Buffer.from(eventLog(idl, "PoolInitialized", initValue()).slice("Program data: ".length), "base64");
    const cut = full.subarray(0, 8 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 4 + 3); // length prefix says 19 bytes, 3 present
    expect(parseCofferPoolEvents([`Program data: ${cut.toString("base64")}`])[0].kind).toBe("Unknown");
  });
  test("[N04] an unknown discriminator is Unknown with the raw payload", () => {
    const out = parseCofferPoolEvents([`Program data: ${Buffer.concat([Buffer.alloc(8, 0xaa), Buffer.alloc(40)]).toString("base64")}`]);
    expect(out[0].kind).toBe("Unknown"); expect((out[0] as any).name).toBe("unknown");
  });
  test("[N05] lines that are not `Program data:` are ignored", () => {
    expect(parseCofferPoolEvents(["Program log: hello", "Program 8iQt… invoke [1]", "Program data: AAAA"])).toHaveLength(0);
  });
  test("[N06] a non-canonical bool inside a tail (is_seed = 2) is Unknown", () => {
    const full = Buffer.from(eventLog(idl, "LiquidityAdded", addedValue()).slice("Program data: ".length), "base64");
    full[8 + 32 + 32 + 4 + 3 * 8 + 8 + 8] = 2;
    expect(parseCofferPoolEvents([`Program data: ${full.toString("base64")}`])[0].kind).toBe("Unknown");
  });
  test("[N07] a PoolInfo log with range_manager_locked = 3 is Unknown", () => {
    const full = Buffer.from(eventLog(idl, "PoolInfo", infoValue()).slice("Program data: ".length), "base64");
    const generic = parseContractEvents([`Program data: ${full.toString("base64")}`], "cofferPool");
    expect(generic[0].kind).toBe("PoolInfo");
    // locate the flag: after creator_fees_owed (4 + 2*8) which follows creator_fee_bps (2) which follows timestamp
    const prefixLen = (() => {
      const names = fieldsOf("PoolInfo"); const idx = names.indexOf("range_manager_locked");
      return 8 + Buffer.from(truncatedEventLog(idl, "PoolInfo", infoValue(), idx).slice("Program data: ".length), "base64").length - 8;
    })();
    full[prefixLen] = 3;
    expect(parseCofferPoolEvents([`Program data: ${full.toString("base64")}`])[0].kind).toBe("Unknown");
  });
  test("[N08] the generic decoder refuses a truncated v6.1 log (strict Borsh) while the typed one tolerates it", () => {
    const log = truncatedEventLog(idl, "Swap", swapValue(), 10);
    expect(parseContractEvents([log], "cofferPool")).toHaveLength(0);
    expect(parseCofferPoolEvents([log])[0].kind).toBe("Swap");
  });
  test("[N09] trailing garbage after a complete v6.1 Swap is ignored by the typed decoder (future append)", () => {
    const full = Buffer.from(eventLog(idl, "Swap", swapValue()).slice("Program data: ".length), "base64");
    const e = parseCofferPoolEvents([`Program data: ${Buffer.concat([full, Buffer.from([1, 2, 3])]).toString("base64")}`])[0] as SwapEvent;
    expect(e.kind).toBe("Swap"); expect(e.effectiveFeeRate).toBe(2500);
  });
  test("[N10] a protocol-admin log is not decoded with the coffer-pool table and vice versa", () => {
    const log = eventLog(pa, "TreasuryDelayChanged", { treasury: key(1), admin: key(2), old_delay_secs: 1, new_delay_secs: 2, timestamp: bn(8) });
    expect(parseContractEvents([log], "cofferPool")).toHaveLength(0);
    expect(parseContractEvents([log], "protocolAdmin")[0].kind).toBe("TreasuryDelayChanged");
  });
  test("[N11] unknown error codes map to undefined / unknown", () => {
    expect(describeProgramError(6104)).toBeUndefined();
    expect(describeProgramError(6019, "protocolAdmin")).toBeUndefined();
    expect(toSdkError(new Error("custom program error: 0x17d8")).code).toBe("unknown"); // 6104
  });
  test("[N12] the pre-T19 BannedExtension code 6025 is still defined but never a v6.1 error", () => {
    expect(describeProgramError(6025)?.name).toBe("BannedExtension");
  });
  test("[N13] cooldown events never shadow the discriminator with their kind field", () => {
    const e = one<any>(eventLog(idl, "PoolActionExecuted", { pool: key(1), authority: key(2), kind: 4, eta: bn(5), epoch: 1, timestamp: bn(6) }));
    expect(e.kind).toBe("PoolActionExecuted"); expect(e.actionKind).toBe(4);
  });
  test("[N14] PoolInfo pending_etas with a wrong length prefix is Unknown", () => {
    const full = Buffer.from(eventLog(idl, "PoolInfo", infoValue()).slice("Program data: ".length), "base64");
    const names = fieldsOf("PoolInfo"); const idx = names.indexOf("pending_etas");
    const off = Buffer.from(truncatedEventLog(idl, "PoolInfo", infoValue(), idx).slice("Program data: ".length), "base64").length;
    full.writeUInt32LE(1000, off);
    expect(parseCofferPoolEvents([`Program data: ${full.toString("base64")}`])[0].kind).toBe("Unknown");
  });
  test("[N15] every pinned name exists in the IDL (no silent rename)", () => {
    for (const name of Object.keys(PINNED_EVENTS)) expect(idl.events.some((e: any) => e.name === name)).toBe(true);
    for (const name of Object.keys(PINNED_PA_EVENTS)) expect(pa.events.some((e: any) => e.name === name)).toBe(true);
    for (const name of Object.values(PINNED_ERRORS)) expect(idl.errors.some((e: any) => e.name === name)).toBe(true);
  });
});
