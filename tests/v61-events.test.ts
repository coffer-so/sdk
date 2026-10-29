/**
 * v6.1 (T11) events: the re-cut `…V2` wire (before / after state,
 * `actor_kind`, `SwapV2` with `SlotState` pairs + `Option<SelloffWindow>`),
 * the retired / legacy discriminators (→ `Unknown`), decoder round-trips
 * against the IDL-generated fixtures, CPI attribution, and the error map
 * (coffer_pool 6070–6106, protocol_admin 6010–6018).
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { IDLS } from "../src/idl";
import { EVENT_TABLES, TYPED_EVENT_NAMES, applySwapToVectors, decodeEventLine, eventProgramOf, logTruncated, parseCofferPoolEvents, parseTransactionEvents, swapSlotDeltas, swapSurgeLpAmount } from "../src/parsers/events";
import { LEGACY_EVENT_DISCRIMINATORS, RECUT_EVENTS, RETIRED_EVENTS } from "../src/parsers/eventPins";
import { parseContractEvents } from "../src/parsers/contracts";
import { ACTOR_KIND, actorKindName } from "../src/types/events";
import { describeProgramError, toSdkError, contractErrorMapForTests } from "../src/utils/errors";
import { eventLog, encodeFields, normalize, truncatedEventLog } from "./helpers/borshFixture";
import type { SwapV2Event, LiquidityAddedV2Event, LiquidityRemovedV2Event, PoolInitializedV2Event, PoolInfoV2Event, SingleTokenDepositDirectV2Event, RangeManagerUpdatedV2Event, MaxSelloffSetV2Event } from "../src/types/events";
import type { ContractProgram } from "../src/types/contracts";
import cofferFixtures from "./fixtures/events/coffer_pool.json";
import adminFixtures from "./fixtures/events/protocol_admin.json";
import stldFixtures from "./fixtures/events/single_token_liquidity.json";

const idl = IDLS.cofferPool as any;
const pa = IDLS.protocolAdmin as any;
const stld = IDLS.singleTokenLiquidity as any;
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const bn = (v: number | string | bigint) => new BN(v.toString());
const fieldsOf = (name: string, which: any = idl): any[] => which.types.find((t: any) => t.name === name).type.fields;
const disc = (name: string, which: any = idl) => Buffer.from(which.events.find((e: any) => e.name === name).discriminator).toString("hex");
const log = (bytes: Buffer) => `Program data: ${bytes.toString("base64")}`;

type Fixture = { name: string; variant: string; discriminator: string; base64: string; value: any };
const FIXTURES: Array<[ContractProgram, any, Fixture]> = [
  ...(cofferFixtures.events as Fixture[]).map((f) => ["cofferPool", idl, f] as [ContractProgram, any, Fixture]),
  ...(adminFixtures.events as Fixture[]).map((f) => ["protocolAdmin", pa, f] as [ContractProgram, any, Fixture]),
  ...(stldFixtures.events as Fixture[]).map((f) => ["singleTokenLiquidity", stld, f] as [ContractProgram, any, Fixture]),
];

/** Fixture value (IDL names, strings for wide ints) → what the camelCase API returns, normalised. */
const SMALL_I64 = new Set(["timestamp", "plan_quoted_at", "window_start_timestamp"]);
function camelExpected(value: any, key?: string): any {
  if (Array.isArray(value)) return value.map((v) => camelExpected(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k === "kind" ? "actionKind" : k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()), camelExpected(v, k)]));
  }
  if (typeof value === "string" && key && SMALL_I64.has(key) && /^-?\d+$/.test(value)) return Number(value);
  return value;
}
/** Fixture value → the `parseContractEvents` shape (BN / PublicKey / Buffer), for the re-encode round trip. */
function revive(value: any, type: any, which: any): any {
  if (type === "pubkey") return new PublicKey(value);
  if (type === "bytes") return Buffer.from(value);
  if (typeof type === "string") return /^[ui](64|128|256)$/.test(type) ? new BN(value) : value;
  if (type.vec) return value.map((v: any) => revive(v, type.vec, which));
  if (type.array) return value.map((v: any) => revive(v, type.array[0], which));
  if (type.option) return value === null ? null : revive(value, type.option, which);
  if (type.defined) {
    const def = which.types.find((x: any) => x.name === type.defined.name).type;
    return Object.fromEntries(def.fields.map((f: any) => [f.name, revive(value[f.name], f.type, which)]));
  }
  throw new Error(JSON.stringify(type));
}

const one = <T>(line: string): T => {
  const out = parseCofferPoolEvents([line]);
  expect(out).toHaveLength(1);
  return out[0] as unknown as T;
};

// ── positive ────────────────────────────────────────────────────────────────

describe("event pins (idl/abi-pins.json @ 409067d)", () => {
  test("[P01] every re-cut event's NEW discriminator matches the shipped IDL, and the legacy one is gone from it", () => {
    for (const [program, which] of [["cofferPool", idl], ["protocolAdmin", pa], ["singleTokenLiquidity", stld]] as const) {
      for (const [name, pin] of Object.entries(RECUT_EVENTS[program])) {
        expect(disc(name, which)).toBe(pin.discriminator);
        expect(which.events.some((e: any) => e.name === pin.legacyName)).toBe(false);
        expect(EVENT_TABLES[program].get(pin.legacyDiscriminator)).toBeUndefined();
      }
      for (const [name, hex] of Object.entries(RETIRED_EVENTS[program])) {
        expect(which.events.some((e: any) => e.name === name)).toBe(false);
        expect(EVENT_TABLES[program].get(hex)).toBeUndefined();
      }
    }
  });
  test("[P02] the tables hold 41 / 36 / 2 events, no discriminator is shared and every one is sha256(event:<Name>)", () => {
    expect(EVENT_TABLES.cofferPool.size).toBe(41); expect(EVENT_TABLES.protocolAdmin.size).toBe(36); expect(EVENT_TABLES.singleTokenLiquidity.size).toBe(2);
    const all = [...EVENT_TABLES.cofferPool.keys(), ...EVENT_TABLES.protocolAdmin.keys(), ...EVENT_TABLES.singleTokenLiquidity.keys()];
    expect(new Set(all).size).toBe(79);
    expect(LEGACY_EVENT_DISCRIMINATORS.size).toBe(19 + 24 + 2 + 3);
    for (const hex of all) expect(LEGACY_EVENT_DISCRIMINATORS.has(hex)).toBe(false);
    expect(eventProgramOf(disc("SwapV2"))).toEqual({ program: "cofferPool", name: "SwapV2" });
    expect(eventProgramOf(disc("PoolsFrozenV2", pa))).toEqual({ program: "protocolAdmin", name: "PoolsFrozenV2" });
    expect(eventProgramOf("00".repeat(8))).toBeNull();
  });
  test("[P03] SwapV2 is laid out as documented: 343-byte payload without a window, 399 with one, tag byte @342", () => {
    const some = (cofferFixtures.events as Fixture[]).find((f) => f.name === "SwapV2" && f.variant === "some")!;
    const none = (cofferFixtures.events as Fixture[]).find((f) => f.name === "SwapV2" && f.variant === "none")!;
    expect(Buffer.from(some.base64, "base64").length - 8).toBe(399);
    expect(Buffer.from(none.base64, "base64").length - 8).toBe(343);
    expect(Buffer.from(none.base64, "base64")[8 + 342]).toBe(0);
    expect(Buffer.from(some.base64, "base64")[8 + 342]).toBe(1);
    expect(fieldsOf("SwapV2").map((f) => f.name).slice(-6)).toEqual(["in_before", "in_after", "out_before", "out_after", "timestamp", "selloff_window"]);
    expect(fieldsOf("SlotState").map((f) => f.name)).toEqual(["virtual_balance", "actual_balance", "protocol_fees_owed", "creator_fees_owed", "surge_fees_owed"]);
    expect(fieldsOf("SelloffWindow").map((f) => f.name)).toEqual(["effective_selloff_before", "effective_selloff", "max_selloff_cap", "vb_snapshot", "previous_selloff", "current_selloff", "window_start_timestamp"]);
  });
  test("[P04] the typed decoder set covers the trading / liquidity / admin events a backend indexes", () => {
    for (const name of ["SwapV2", "LiquidityAddedV2", "LiquidityRemovedV2", "PoolInitializedV2", "PoolInfoV2", "SingleTokenDepositDirectV2", "VirtualBalancesRescaled", "HookInvoked"]) {
      expect(TYPED_EVENT_NAMES).toContain(name);
    }
    for (const name of TYPED_EVENT_NAMES) expect(eventProgramOf(disc(name, name === "SingleTokenDepositDirectV2" ? stld : idl))?.name).toBe(name);
  });
});

describe("decoder round trips against the IDL-generated fixtures", () => {
  test.each(FIXTURES.map(([program, which, f]) => [`${program}.${f.name}#${f.variant}`, program, which, f] as const))("[P05] %s", (_label, program, which, f) => {
    const line = `Program data: ${f.base64}`;
    expect(f.discriminator).toBe(disc(f.name, which));
    // generic (IDL names, BN) — exact
    const generic = parseContractEvents([line], program);
    expect(generic).toHaveLength(1);
    expect(generic[0].kind).toBe(f.name);
    expect(normalize(generic[0].data)).toEqual(f.value);
    // camelCase API — typed or generic path, same values
    const camel = one<any>(line);
    expect(camel.kind).toBe(f.name);
    const { kind: _k, ...rest } = camel;
    expect(normalize(rest)).toEqual(camelExpected(f.value));
    // round trip: decoded (generic) → independent encoder → the fixture bytes
    const reencoded = Buffer.concat([Buffer.from(f.discriminator, "hex"), encodeFields(revive(f.value, { defined: { name: f.name } }, which), fieldsOf(f.name, which), which)]);
    expect(reencoded.toString("base64")).toBe(f.base64);
    // attribution: the flat lookup names the right program
    expect(decodeEventLine(f.base64).program).toBe(program);
  });
  test("[P06] every program's whole event set is fixtured (41 + 36 + 2 names)", () => {
    const names = (p: ContractProgram) => new Set(FIXTURES.filter(([x]) => x === p).map(([, , f]) => f.name));
    expect(names("cofferPool").size).toBe(41); expect(names("protocolAdmin").size).toBe(36); expect(names("singleTokenLiquidity").size).toBe(2);
  });
});

describe("SwapV2", () => {
  const swapValue = (window: any) => ({
    pool: key(1), user: key(2), token_in_index: 0, token_out_index: 1, amount_in: bn(1_000_000), transfer_fee_in: bn(1_000), amount_in_net: bn(999_000),
    swap_fee_rate: 3000, effective_fee_rate: 2500, protocol_fee_rate: 1000, creator_fee_bps: 2500, fee_amount: bn(2_498), protocol_fee_amount: bn(250),
    creator_fee_amount: bn(562), amount_out_gross: bn(990_000), surge_fee_amount: bn(10_000), surge_protocol_fee_amount: bn(1_000), surge_creator_fee_amount: bn(2_250),
    amount_out: bn(980_000), transfer_fee_out: bn(980),
    in_before: { virtual_balance: bn(2_000_000_000), actual_balance: bn(1_000_000_000), protocol_fees_owed: bn(5), creator_fees_owed: bn(6), surge_fees_owed: bn(7) },
    in_after: { virtual_balance: bn(2_000_998_188), actual_balance: bn(1_000_998_188), protocol_fees_owed: bn(255), creator_fees_owed: bn(568), surge_fees_owed: bn(7) },
    out_before: { virtual_balance: bn(3_000_000_000), actual_balance: bn(1_500_000_000), protocol_fees_owed: bn(0), creator_fees_owed: bn(0), surge_fees_owed: bn(100) },
    out_after: { virtual_balance: bn(2_999_010_000), actual_balance: bn(1_499_010_000), protocol_fees_owed: bn(1_000), creator_fees_owed: bn(2_250), surge_fees_owed: bn(6_850) },
    timestamp: bn(-1_700_000_000), selloff_window: window,
  });
  const window = { effective_selloff_before: bn(10), effective_selloff: bn(1_000_010), max_selloff_cap: bn(300_000_000), vb_snapshot: bn(3_000_000_000), previous_selloff: bn(10), current_selloff: bn(1_000_000), window_start_timestamp: bn(1_699_999_000) };
  test("[P07] a capped out-token carries its window inline; before / after slots are typed; the timestamp is signed", () => {
    const e = one<SwapV2Event>(eventLog(idl, "SwapV2", swapValue(window)));
    expect(e.kind).toBe("SwapV2"); expect(e.tokenInIndex).toBe(0); expect(e.tokenOutIndex).toBe(1); expect(e.timestamp).toBe(-1_700_000_000);
    expect(e.effectiveFeeRate).toBe(2500); expect(e.swapFeeRate).toBe(3000); expect(e.amountInNet.toNumber()).toBe(999_000); expect(e.amountOutGross.toNumber()).toBe(990_000);
    expect(e.inAfter.actualBalance.toString()).toBe("1000998188"); expect(e.outAfter.surgeFeesOwed.toNumber()).toBe(6_850);
    expect(e.selloffWindow).not.toBeNull(); expect(e.selloffWindow!.effectiveSelloffBefore.toNumber()).toBe(10); expect(e.selloffWindow!.windowStartTimestamp).toBe(1_699_999_000);
  });
  test("[P08] an uncapped out-token has selloffWindow = null (343-byte payload)", () => {
    const line = eventLog(idl, "SwapV2", swapValue(null));
    expect(Buffer.from(line.slice("Program data: ".length), "base64").length).toBe(8 + 343);
    expect(one<SwapV2Event>(line).selloffWindow).toBeNull();
  });
  test("[P09] the cascade is replayable from the event alone: in.actual += net − protocol − creator; out.actual −= gross; out.surge += LP share", () => {
    const e = one<SwapV2Event>(eventLog(idl, "SwapV2", swapValue(null)));
    const d = swapSlotDeltas(e);
    expect(d.in.actualBalance.toString()).toBe(e.amountInNet.sub(e.protocolFeeAmount).sub(e.creatorFeeAmount).toString());
    expect(d.in.virtualBalance.toString()).toBe(d.in.actualBalance.toString());
    expect(d.in.protocolFeesOwed.toString()).toBe(e.protocolFeeAmount.toString()); expect(d.in.creatorFeesOwed.toString()).toBe(e.creatorFeeAmount.toString());
    expect(d.out.actualBalance.toString()).toBe(e.amountOutGross.neg().toString()); expect(d.out.virtualBalance.toString()).toBe(e.amountOutGross.neg().toString());
    expect(d.out.protocolFeesOwed.toString()).toBe(e.surgeProtocolFeeAmount.toString()); expect(d.out.creatorFeesOwed.toString()).toBe(e.surgeCreatorFeeAmount.toString());
    expect(swapSurgeLpAmount(e).toNumber()).toBe(10_000 - 1_000 - 2_250); expect(d.out.surgeFeesOwed.toString()).toBe(swapSurgeLpAmount(e).toString());
    expect(e.amountOut.toString()).toBe(e.amountOutGross.sub(e.surgeFeeAmount).toString());
  });
  test("[P10] applySwapToVectors patches exactly the two touched slots", () => {
    const e = one<SwapV2Event>(eventLog(idl, "SwapV2", { ...swapValue(null), token_in_index: 2, token_out_index: 0 }));
    const vectors = { virtualBalances: [bn(1), bn(2), bn(3)], actualBalances: [bn(1), bn(2), bn(3)], protocolFeesOwed: [bn(1), bn(2), bn(3)], creatorFeesOwed: [bn(1), bn(2), bn(3)], surgeFeesOwed: [bn(1), bn(2), bn(3)] };
    const after = applySwapToVectors(e, vectors);
    expect(after.virtualBalances.map(String)).toEqual([e.outAfter.virtualBalance.toString(), "2", e.inAfter.virtualBalance.toString()]);
    expect(after.surgeFeesOwed.map(String)).toEqual([e.outAfter.surgeFeesOwed.toString(), "2", e.inAfter.surgeFeesOwed.toString()]);
    expect(vectors.virtualBalances.map(String)).toEqual(["1", "2", "3"]);
  });
});

describe("LiquidityAddedV2 / LiquidityRemovedV2 / receipts", () => {
  test("[P11] LiquidityAddedV2 surfaces lp_supply_before/after and the six vectors; a seed has supply 0 → lp_amount", () => {
    const v = {
      pool: key(1), user: key(2), is_seed: true, token_amounts: [bn(100), bn(0), bn(300)], credited_amounts: [bn(99), bn(0), bn(297)], surge_buy_in: [bn(0), bn(0), bn(0)],
      lp_amount: bn("1000000000000"), deposit_fee_lp: bn(0), deposit_fee_bps: 0, lp_supply_before: bn(0), lp_supply_after: bn("1000000000000"),
      virtual_balances_before: [bn(1000), bn(1000), bn(1000)], virtual_balances_after: [bn(1000), bn(1000), bn(1000)], actual_balances_before: [bn(0), bn(0), bn(0)],
      actual_balances_after: [bn(99), bn(0), bn(297)], surge_fees_owed_before: [bn(0), bn(0), bn(0)], surge_fees_owed_after: [bn(0), bn(0), bn(0)], timestamp: bn(1_700_000_000),
    };
    const e = one<LiquidityAddedV2Event>(eventLog(idl, "LiquidityAddedV2", v));
    expect(e.isSeed).toBe(true); expect(e.lpSupplyBefore.isZero()).toBe(true); expect(e.lpSupplyAfter.toString()).toBe("1000000000000");
    expect(e.lpSupplyAfter.toString()).toBe(e.lpSupplyBefore.add(e.lpAmount).toString());
    expect(e.actualBalancesAfter.map(Number)).toEqual([99, 0, 297]); expect(e.creditedAmounts.map(Number)).toEqual([99, 0, 297]); expect(e.depositFeeBps).toBe(0);
    e.creditedAmounts.forEach((c, i) => expect(c.toString()).toBe(e.actualBalancesAfter[i].sub(e.actualBalancesBefore[i]).add(e.surgeFeesOwedAfter[i].sub(e.surgeFeesOwedBefore[i])).toString()));
  });
  test("[P12] LiquidityRemovedV2: effective burn ≤ requested, hooks_bypassed, per-leg transfer fees, supply after = before − burn", () => {
    const v = {
      pool: key(1), user: key(2), requested_lp: bn(600), lp_amount: bn(500), token_amounts: [bn(90), bn(0)], surge_amounts: [bn(4), bn(0)], withdraw_fee_amounts: [bn(10), bn(0)],
      withdraw_fee_bps: 1000, transfer_fees_out: [bn(1), bn(0)], hooks_bypassed: true, lp_supply_before: bn(1000), lp_supply_after: bn(500),
      virtual_balances_before: [bn(200), bn(300)], virtual_balances_after: [bn(110), bn(300)], actual_balances_before: [bn(190), bn(0)], actual_balances_after: [bn(100), bn(0)],
      surge_fees_owed_before: [bn(8), bn(0)], surge_fees_owed_after: [bn(4), bn(0)], timestamp: bn(1_700_000_001),
    };
    const e = one<LiquidityRemovedV2Event>(eventLog(idl, "LiquidityRemovedV2", v));
    expect(e.requestedLp.toNumber()).toBe(600); expect(e.lpAmount.toNumber()).toBe(500); expect(e.hooksBypassed).toBe(true);
    expect(e.lpSupplyAfter.toString()).toBe(e.lpSupplyBefore.sub(e.lpAmount).toString());
    expect(e.actualBalancesBefore[0].sub(e.actualBalancesAfter[0]).toNumber()).toBe(90); expect(e.surgeFeesOwedBefore[0].sub(e.surgeFeesOwedAfter[0]).toNumber()).toBe(4);
    expect(e.transferFeesOut.map(Number)).toEqual([1, 0]); expect(e.virtualBalancesAfter[0].gt(e.actualBalancesAfter[0])).toBe(true);
  });
  test("[P13] SingleTokenDepositDirectV2 is self-contained: plan hash, quoted_at, valid_until_slot, inner_swap_count, supply before / after", () => {
    const v = {
      pool: key(1), user: key(2), token_in_index: 2, amount_in: bn(300), minimum_lp_amount: bn(90), allocations: [bn(200), bn(100), bn(0)],
      plan_expected_state: Array.from({ length: 32 }, (_, i) => i), plan_quoted_at: bn(1_700_000_000), plan_valid_until_slot: bn(1_000_123), inner_swap_count: 2,
      deposited_amounts: [bn(200), bn(87), bn(0)], lp_received: bn(95), dust_remaining: [bn(0), bn(3), bn(0)], lp_supply_before: bn(1_000), lp_supply_after: bn(1_095), timestamp: bn(1_700_000_321),
    };
    const e = one<SingleTokenDepositDirectV2Event>(eventLog(stld, "SingleTokenDepositDirectV2", v));
    expect(e.kind).toBe("SingleTokenDepositDirectV2"); expect([...e.planExpectedState]).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(e.planQuotedAt).toBe(1_700_000_000); expect(e.planValidUntilSlot.toNumber()).toBe(1_000_123); expect(e.innerSwapCount).toBe(2);
    expect(e.lpReceived.toNumber()).toBe(95); expect(e.lpSupplyAfter.sub(e.lpSupplyBefore).toString()).toBe(e.lpReceived.toString()); expect(e.dustRemaining.map(Number)).toEqual([0, 3, 0]);
  });
  test("[P14] PoolInitializedV2 is the whole creation record (mints, programs, decimals, weights, vbs, rates, LP metadata, hook block)", () => {
    const v = {
      pool: key(1), config: key(2), pool_id: bn("9007199254740993"), pool_admin: key(3), lp_mint: key(4), lp_token_program: key(5), token_count: 2, mints: [key(10), key(11)],
      token_programs: [key(20), key(21)], decimals: Buffer.from([6, 9]), normalized_weights: [bn(5000), bn(5000)], initial_virtual_balances: [bn(1_000_000), bn(1_000_000_000)],
      swap_fee_rate: 3000, protocol_fee_rate: 1000, creator_fee_bps: 2500, deposit_fee_bps: 5, withdraw_fee_bps: 7, lp_name: "Café Пул LP", lp_symbol: "cLP", lp_uri: "https://x",
      hook_program: key(41), hook_flags: 0b1110000, hook_fee_min: 100, hook_fee_max: 50_000, hook_max_cu: 60_000, hook_accounts_len: 4, timestamp: bn(1_700_000_002),
    };
    const e = one<PoolInitializedV2Event>(eventLog(idl, "PoolInitializedV2", v));
    expect(e.poolId.toString()).toBe("9007199254740993"); expect(e.mints[1].equals(key(11))).toBe(true); expect(e.decimals).toEqual([6, 9]); expect(e.lpName).toBe("Café Пул LP");
    expect(e.initialVirtualBalances.map(String)).toEqual(["1000000", "1000000000"]); expect(e.hookFlags).toBe(0b1110000); expect(e.hookAccountsLen).toBe(4); expect(e.poolAdmin.equals(key(3))).toBe(true);
  });
  test("[P15] PoolInfoV2: full view incl. is_active, selloff_policy (7 fields), range-manager block, cooldown summary, hook block, timestamp LAST", () => {
    const policy = { max_selloff_pct: 300, period_length: 60, fee_threshold_pct: 100, fee_slope_low_pct: 10, fee_slope_high_pct: 900, fee_slope_mid_pct: 700, fee_kink_pct: 80 };
    const v = {
      pool: key(1), config: key(2), pool_id: bn(5), layout_version: 1, pool_admin: key(3), pending_pool_admin: key(4), pending_pool_admin_eta: bn(-5), lp_mint: key(6), token_count: 2,
      tokens: [key(10), key(11)], token_vaults: [key(20), key(21)], token_programs: [key(30), key(31)], decimals: Buffer.from([9, 6]), normalized_weights: [bn(5000), bn(5000)],
      virtual_balances: [bn(2), bn(4)], actual_balances: [bn(1), bn(3)], protocol_fees_owed: [bn(5), bn(6)], creator_fees_owed: [bn(7), bn(8)], surge_fees_owed: [bn(9), bn(10)],
      is_active: [true, false], selloff_policy: [policy, { ...policy, fee_kinkPct: undefined, fee_kink_pct: 0 }], swap_fee_rate: 3000, protocol_fee_rate: 1000, creator_fee_bps: 2500,
      deposit_fee_bps: 5, withdraw_fee_bps: 7, liquidity_fee_lock: 1, pool_enabled: true, swaps_enabled: false, range_manager: key(50), range_manager_enabled: true, range_manager_locked: false,
      range_manager_max_vb_change_pct: 500, range_manager_max_weight_change_pct: 600, range_manager_min_update_interval_secs: 60, range_manager_max_leverage_bps: 30_000,
      range_manager_min_leverage_bps: 11_000, range_manager_last_updated: bn(1_699_999_999), lookup_table: key(60), pool_admin_delay_secs: 86_400, pool_admin_epoch: 3,
      pending_actions_mask: 0b11, pending_etas: [bn(1), bn(2), bn(0), bn(0), bn(0), bn(0), bn(0), bn(0), bn(0), bn(0), bn(-5)], hook_program: key(41), hook_flags: 0b1110000,
      hook_disabled: 1, hook_fee_min: 100, hook_fee_max: 50_000, hook_max_cu: 60_000, hook_accounts_len: 4, timestamp: bn(1_700_000_004),
    };
    const e = one<PoolInfoV2Event>(eventLog(idl, "PoolInfoV2", v));
    expect(e.layoutVersion).toBe(1); expect(e.pendingPoolAdminEta.toString()).toBe("-5"); expect(e.isActive).toEqual([true, false]); expect(e.selloffPolicy[0].feeKinkPct).toBe(80);
    expect(e.selloffPolicy[1].feeKinkPct).toBe(0); expect(e.rangeManagerMinLeverageBps).toBe(11_000); expect(e.pendingEtas).toHaveLength(11); expect(e.pendingEtas[10].toString()).toBe("-5");
    expect(e.hookDisabled).toBe(1); expect(e.timestamp).toBe(1_700_000_004); expect(e.decimals).toEqual([9, 6]);
  });
});

describe("admin / before-after events", () => {
  test("[P16] actor_kind is typed on SwapsEnabledUpdatedV2 / TokenActiveSetV2 and named by actorKindName", () => {
    const a = one<any>(eventLog(idl, "SwapsEnabledUpdatedV2", { pool: key(1), authority: key(2), actor_kind: 2, old_value: true, new_value: false, timestamp: bn(1) }));
    expect(a.kind).toBe("SwapsEnabledUpdatedV2"); expect(a.actorKind).toBe(ACTOR_KIND.PROTOCOL_ADMIN); expect(actorKindName(a.actorKind)).toBe("PROTOCOL_ADMIN");
    const t = one<any>(eventLog(idl, "TokenActiveSetV2", { pool: key(1), authority: key(2), actor_kind: 3, token_index: 4, old_value: true, new_value: false, timestamp: bn(1) }));
    expect(t.tokenIndex).toBe(4); expect(actorKindName(t.actorKind)).toBe("SUPERVISOR"); expect(actorKindName(9)).toBe("UNKNOWN(9)");
  });
  test("[P17] RangeManagerUpdatedV2 is sparse: indices as numbers, old (CAS) / new per touched slot", () => {
    const e = one<RangeManagerUpdatedV2Event>(eventLog(idl, "RangeManagerUpdatedV2", {
      pool: key(1), manager: key(2), vb_indices: Buffer.from([0, 3]), vb_old_values: [bn(100), bn(200)], vb_new_values: [bn(110), bn(190)], weight_indices: Buffer.from([1]),
      weight_old_values: [bn(5000)], weight_new_values: [bn(5100)], timestamp: bn(7),
    }));
    expect(e.vbIndices).toEqual([0, 3]); expect(e.vbNewValues.map(Number)).toEqual([110, 190]); expect(e.weightIndices).toEqual([1]); expect(e.weightNewValues.map(Number)).toEqual([5100]);
  });
  test("[P18] MaxSelloffSetV2 carries both policies in full (old and new, all 7 fields)", () => {
    const p = (k: number) => ({ max_selloff_pct: 300, period_length: 60, fee_threshold_pct: 100, fee_slope_low_pct: 10, fee_slope_high_pct: 900, fee_slope_mid_pct: 700, fee_kink_pct: k });
    const e = one<MaxSelloffSetV2Event>(eventLog(idl, "MaxSelloffSetV2", { pool: key(1), authority: key(2), old_params: [p(0), p(1)], new_params: [p(80), p(81)], timestamp: bn(7) }));
    expect(e.oldParams.map((x) => x.feeKinkPct)).toEqual([0, 1]); expect(e.newParams.map((x) => x.feeKinkPct)).toEqual([80, 81]); expect(e.newParams[0].periodLength).toBe(60);
  });
  test("[P19] VirtualBalancesRescaled (T22) and HookInvoked / HookDisabledSet (T9)", () => {
    const r = one<any>(eventLog(idl, "VirtualBalancesRescaled", { pool: key(1), authority: key(2), multiplier: bn(1_000_000_000), old_virtual_balances: [bn(1), bn(13_099)], new_virtual_balances: [bn(1_000_000_000), bn("13099000000000")], timestamp: bn(7) }));
    expect(r.kind).toBe("VirtualBalancesRescaled"); expect(r.multiplier.toString()).toBe("1000000000"); expect(r.newVirtualBalances[1].toString()).toBe("13099000000000");
    const h = one<any>(eventLog(idl, "HookInvoked", { pool: key(1), hook_program: key(41), callback: 1, verdict: 0, has_fee_override: true, fee_override: 123_456, cu_used: 5_340, timestamp: bn(6) }));
    expect(h.callback).toBe(1); expect(h.hasFeeOverride).toBe(true); expect(h.feeOverride).toBe(123_456); expect(h.cuUsed).toBe(5_340);
    const d = one<any>(eventLog(idl, "HookDisabledSet", { pool: key(1), authority: key(2), old_disabled: false, new_disabled: true, pause_when_disabled: true, timestamp: bn(6) }));
    expect(d.newDisabled).toBe(true); expect(d.pauseWhenDisabled).toBe(true);
  });
  test("[P20] generic-path events decode with camelCase keys recursively and `kind` → `actionKind`", () => {
    const e = one<any>(eventLog(pa, "ActionCancelledV2", { treasury: key(1), authority: key(2), actor_kind: 3, kind: 2, eta: bn(7), timestamp: bn(8) }));
    expect(e.kind).toBe("ActionCancelledV2"); expect(e.actionKind).toBe(2); expect(e.actorKind).toBe(3); expect(e.eta.toNumber()).toBe(7); expect(e.timestamp).toBe(8);
    const f = one<any>(eventLog(pa, "PoolsFrozenV2", { treasury: key(1), authority: key(2), actor_kind: 3, pools: [key(5), key(6)], old_enabled: [true, false], timestamp: bn(8) }));
    expect(f.pools.map((k: PublicKey) => k.toBase58())).toEqual([key(5).toBase58(), key(6).toBase58()]); expect(f.oldEnabled).toEqual([true, false]);
    const m = one<any>(eventLog(idl, "PoolMigrationV5Applied", { pool: key(1), authority: key(2), actor_kind: 2, reactivate_tokens: true, token_count: 3, reactivated: 2, timestamp: bn(8) }));
    expect(m.kind).toBe("PoolMigrationV5Applied"); expect(m.reactivated).toBe(2);
    const w = one<any>(eventLog(pa, "FundsWithdrawnV2", { treasury: key(1), admin: key(2), mint: key(3), vault: key(4), recipient: key(5), amount: bn(9), vault_balance_before: bn(10), vault_balance_after: bn(1), timestamp: bn(8) }));
    expect(w.vaultBalanceBefore.toNumber()).toBe(10); expect(w.vaultBalanceAfter.toNumber()).toBe(1);
  });
  test("[P21] parseTransactionEvents attributes every line to the program on top of the invoke stack", () => {
    const coffer = key(100).toBase58(), stldId = key(101).toBase58();
    const swap = eventLog(idl, "SwapV2", (cofferFixtures.events as Fixture[]).find((f) => f.name === "SwapV2" && f.variant === "none")!.value && revive((cofferFixtures.events as Fixture[]).find((f) => f.name === "SwapV2" && f.variant === "none")!.value, { defined: { name: "SwapV2" } }, idl));
    const receipt = `Program data: ${(stldFixtures.events as Fixture[]).find((f) => f.name === "SingleTokenDepositDirectV2")!.base64}`;
    const logs = [
      `Program ${stldId} invoke [1]`, "Program log: Instruction: DepositSingleTokenPlanned",
      `Program ${coffer} invoke [2]`, "Program log: Instruction: Swap", swap, `Program ${coffer} success`,
      `Program ${coffer} invoke [2]`, swap, `Program ${coffer} success`,
      receipt, `Program ${stldId} success`,
    ];
    const out = parseTransactionEvents(logs, { cofferPool: key(100), singleTokenLiquidity: key(101) });
    expect(out.map((e) => [e.event.kind, e.program, e.depth, e.programId === coffer ? "coffer" : "stld"])).toEqual([
      ["SwapV2", "cofferPool", 2, "coffer"], ["SwapV2", "cofferPool", 2, "coffer"], ["SingleTokenDepositDirectV2", "singleTokenLiquidity", 1, "stld"],
    ]);
    expect(out[0].lineIndex).toBe(4); expect(out[2].lineIndex).toBe(9);
    // without ids the flat lookup still decodes everything, at the right depth
    const flat = parseTransactionEvents(logs);
    expect(flat.map((e) => e.event.kind)).toEqual(["SwapV2", "SwapV2", "SingleTokenDepositDirectV2"]); expect(flat.map((e) => e.depth)).toEqual([2, 2, 1]);
    expect(logTruncated(logs)).toBe(false); expect(logTruncated([...logs, "Log truncated"])).toBe(true);
  });
});

describe("error code map (v6.1 incl. T22)", () => {
  test("[P22] coffer-pool 6104–6106 have user-facing messages and non-generic SDK codes", () => {
    expect(describeProgramError(6104)).toMatchObject({ name: "VirtualBalanceNotAboveActual", sdkCode: "leverage_invariant" });
    expect(describeProgramError(6105)).toMatchObject({ name: "VirtualBalanceBelowFloor", sdkCode: "leverage_invariant" });
    expect(describeProgramError(6106)).toMatchObject({ name: "InvalidVirtualRescale", sdkCode: "invalid_input" });
    expect(describeProgramError(6104)!.message).toMatch(/rescale_virtual_balances/);
    expect(describeProgramError(6105)!.message).toMatch(/one whole token/);
    expect(describeProgramError(6106)!.message).toMatch(/≥ 2/);
    expect(toSdkError(new Error("custom program error: 0x17d8")).code).toBe("leverage_invariant"); // 6104
    expect(toSdkError(new Error("Error Number: 6105")).humanMessage).toMatch(/one whole token/);
  });
  test("[P23] the table is append-only: every code 6000..6106 defined once; protocol-admin still 6010–6018", () => {
    const table = contractErrorMapForTests("cofferPool");
    for (let c = 6000; c <= 6106; c++) expect(table[c]).toBeDefined();
    expect(Object.keys(table)).toHaveLength(107);
    expect(Object.keys(contractErrorMapForTests("protocolAdmin"))).toHaveLength(19);
    expect(describeProgramError(6095)?.sdkCode).toBe("hook_rejected"); expect(describeProgramError(6089)?.sdkCode).toBe("cooldown"); expect(describeProgramError(6070)?.sdkCode).toBe("pool_layout_outdated");
    expect(describeProgramError(6010, "protocolAdmin")?.sdkCode).toBe("cooldown"); expect(describeProgramError(6018, "protocolAdmin")?.name).toBe("InvalidPendingAdmin");
  });
});

// ── negative ────────────────────────────────────────────────────────────────

describe("legacy / retired / malformed logs", () => {
  test("[N01] every legacy discriminator of a re-cut event is Unknown with the legacy name and its successor", () => {
    for (const [program, pins] of Object.entries(RECUT_EVENTS) as Array<[ContractProgram, any]>) {
      for (const [name, pin] of Object.entries<any>(pins)) {
        const [e] = parseCofferPoolEvents([log(Buffer.concat([Buffer.from(pin.legacyDiscriminator, "hex"), Buffer.alloc(64, 1)]))]);
        expect(e.kind).toBe("Unknown"); expect((e as any).name).toBe(pin.legacyName);
        expect((e as any).data).toMatchObject({ legacy: true, retired: false, replacedBy: name, program });
      }
    }
  });
  test("[N02] the retired PoolStateLog / MaxSelloffWindowAdvanced / SingleTokenDeposit discriminators are Unknown { retired: true }", () => {
    for (const [name, hex] of [["PoolStateLog", "3bfeed6fa30a8ce0"], ["MaxSelloffWindowAdvanced", "e5e3a31e16b74e39"], ["SingleTokenDeposit", "d7368968db27a4eb"]]) {
      const [e] = parseCofferPoolEvents([log(Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(100)]))]);
      expect(e.kind).toBe("Unknown"); expect((e as any).name).toBe(name); expect((e as any).data.retired).toBe(true); expect((e as any).data.replacedBy).toBeNull();
      expect(parseContractEvents([log(Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(100)]))])).toHaveLength(0);
    }
  });
  test("[N03] a v6 Swap log (legacy discriminator + a valid v6 payload) never decodes as SwapV2", () => {
    const v6 = Buffer.concat([Buffer.from("516ce3becdd00ac4", "hex"), key(1).toBuffer(), key(2).toBuffer(), key(3).toBuffer(), key(4).toBuffer(), Buffer.alloc(8 * 6)]);
    const [e] = parseCofferPoolEvents([log(v6)]);
    expect(e.kind).toBe("Unknown"); expect((e as any).name).toBe("Swap"); expect((e as any).data.replacedBy).toBe("SwapV2");
  });
  test("[N04] a SwapV2 cut inside a slot or inside the window is Unknown, never a half value", () => {
    const full = Buffer.from((cofferFixtures.events as Fixture[]).find((f) => f.name === "SwapV2" && f.variant === "some")!.base64, "base64");
    for (const cut of [8 + 32 * 2 + 1, 8 + 150, 8 + 342, 8 + 343 + 10, full.length - 1]) {
      const [e] = parseCofferPoolEvents([log(full.subarray(0, cut))]);
      expect(e.kind).toBe("Unknown"); expect((e as any).name).toBe("SwapV2"); expect((e as any).data.error).toMatch(/BorshReader|bytes/);
    }
  });
  test("[N05] a SwapV2 whose Option tag is neither 0 nor 1 is Unknown", () => {
    const full = Buffer.from((cofferFixtures.events as Fixture[]).find((f) => f.name === "SwapV2" && f.variant === "none")!.base64, "base64");
    full[8 + 342] = 2;
    const [e] = parseCofferPoolEvents([log(full)]);
    expect(e.kind).toBe("Unknown"); expect((e as any).data.error).toMatch(/Option tag/);
  });
  test("[N06] trailing bytes after a complete typed payload are ignored (the IDL coder behaves the same)", () => {
    const full = Buffer.from((cofferFixtures.events as Fixture[]).find((f) => f.name === "LiquidityAddedV2")!.base64, "base64");
    const padded = Buffer.concat([full, Buffer.from([1, 2, 3])]);
    expect(parseCofferPoolEvents([log(padded)])[0].kind).toBe("LiquidityAddedV2");
    expect(parseContractEvents([log(padded)], "cofferPool")[0]?.kind).toBe("LiquidityAddedV2");
  });
  test("[N07] a Vec length prefix past the buffer is Unknown (LiquidityRemovedV2, PoolInfoV2 pending_etas)", () => {
    const removed = Buffer.from((cofferFixtures.events as Fixture[]).find((f) => f.name === "LiquidityRemovedV2")!.base64, "base64");
    removed.writeUInt32LE(1_000_000, 8 + 32 * 2 + 16);
    expect(parseCofferPoolEvents([log(removed)])[0].kind).toBe("Unknown");
    const info = (cofferFixtures.events as Fixture[]).find((f) => f.name === "PoolInfoV2")!;
    const names = fieldsOf("PoolInfoV2").map((f) => f.name);
    const off = 8 + Buffer.from(truncatedEventLog(idl, "PoolInfoV2", revive(info.value, { defined: { name: "PoolInfoV2" } }, idl), names.indexOf("pending_etas")).slice("Program data: ".length), "base64").length - 8;
    const buf = Buffer.from(info.base64, "base64"); buf.writeUInt32LE(1_000, off);
    expect(parseCofferPoolEvents([log(buf)])[0].kind).toBe("Unknown");
  });
  test("[N08] a non-canonical bool (is_seed = 2, hooks_bypassed = 7) is Unknown", () => {
    const added = Buffer.from((cofferFixtures.events as Fixture[]).find((f) => f.name === "LiquidityAddedV2")!.base64, "base64");
    added[8 + 64] = 2;
    expect(parseCofferPoolEvents([log(added)])[0].kind).toBe("Unknown");
    const removed = (cofferFixtures.events as Fixture[]).find((f) => f.name === "LiquidityRemovedV2")!;
    const names = fieldsOf("LiquidityRemovedV2").map((f) => f.name);
    const off = Buffer.from(truncatedEventLog(idl, "LiquidityRemovedV2", revive(removed.value, { defined: { name: "LiquidityRemovedV2" } }, idl), names.indexOf("hooks_bypassed")).slice("Program data: ".length), "base64").length;
    const buf = Buffer.from(removed.base64, "base64"); buf[off] = 7;
    expect(parseCofferPoolEvents([log(buf)])[0].kind).toBe("Unknown");
  });
  test("[N09] a PoolInitializedV2 string longer than the buffer is Unknown; a bad UTF-8 length still refuses", () => {
    const init = (cofferFixtures.events as Fixture[]).find((f) => f.name === "PoolInitializedV2")!;
    const names = fieldsOf("PoolInitializedV2").map((f) => f.name);
    const off = Buffer.from(truncatedEventLog(idl, "PoolInitializedV2", revive(init.value, { defined: { name: "PoolInitializedV2" } }, idl), names.indexOf("lp_name")).slice("Program data: ".length), "base64").length;
    const buf = Buffer.from(init.base64, "base64"); buf.writeUInt32LE(100_000, off);
    expect(parseCofferPoolEvents([log(buf)])[0].kind).toBe("Unknown");
  });
  test("[N10] unknown discriminators / non-`Program data:` lines / short payloads", () => {
    const [u] = parseCofferPoolEvents([log(Buffer.concat([Buffer.alloc(8, 0xaa), Buffer.alloc(40)]))]);
    expect(u.kind).toBe("Unknown"); expect((u as any).name).toBe("unknown"); expect((u as any).data.disc).toBe("aa".repeat(8));
    expect(parseCofferPoolEvents(["Program log: hello", "Program 8iQt… invoke [1]"])).toHaveLength(0);
    expect(parseCofferPoolEvents(["Program data: AAAA"])[0].kind).toBe("Unknown");
  });
  test("[N11] a timestamp outside the safe-integer range is Unknown on the camelCase API (BN on the IDL API)", () => {
    const v = { pool: key(1), authority: key(2), old_value: true, new_value: false, timestamp: new BN(1).shln(62) };
    const line = eventLog(idl, "PoolEnabledUpdated", v);
    expect(parseContractEvents([line], "cofferPool")[0].kind).toBe("PoolEnabledUpdated");
    expect(parseCofferPoolEvents([line])[0].kind).toBe("Unknown");
  });
  test("[N12] with program ids, a coffer-pool event logged under the STLD id is Unknown (foreign payload), and vice versa", () => {
    const stldId = key(101).toBase58();
    const swap = `Program data: ${(cofferFixtures.events as Fixture[]).find((f) => f.name === "SwapV2" && f.variant === "none")!.base64}`;
    const out = parseTransactionEvents([`Program ${stldId} invoke [1]`, swap, `Program ${stldId} success`], { singleTokenLiquidity: key(101) });
    expect(out[0].event.kind).toBe("Unknown"); expect(out[0].program).toBeNull(); expect((out[0].event as any).data.program).toBe("singleTokenLiquidity");
    const receipt = `Program data: ${(stldFixtures.events as Fixture[]).find((f) => f.name === "SingleTokenDepositDirectV2")!.base64}`;
    const out2 = parseTransactionEvents([`Program ${key(100).toBase58()} invoke [1]`, receipt, `Program ${key(100).toBase58()} success`], { cofferPool: key(100) });
    expect(out2[0].event.kind).toBe("Unknown");
  });
  test("[N13] a protocol-admin log is not decoded with the coffer-pool table and vice versa", () => {
    const line = eventLog(pa, "TreasuryDelayChanged", { treasury: key(1), admin: key(2), old_delay_secs: 1, new_delay_secs: 2, timestamp: bn(8) });
    expect(parseContractEvents([line], "cofferPool")).toHaveLength(0);
    expect(parseContractEvents([line], "protocolAdmin")[0].kind).toBe("TreasuryDelayChanged");
    expect(decodeEventLine(line.slice("Program data: ".length), "cofferPool").event.kind).toBe("Unknown");
  });
  test("[N14] no fixture decodes under another program's table; both decoders refuse a payload cut by one byte (Anchor's reader would zero-fill it)", () => {
    for (const [program, , f] of FIXTURES) {
      for (const other of ["cofferPool", "protocolAdmin", "singleTokenLiquidity"] as ContractProgram[]) {
        if (other === program) continue;
        expect(parseContractEvents([`Program data: ${f.base64}`], other)).toHaveLength(0);
      }
      const cut = Buffer.from(f.base64, "base64").subarray(0, -1);
      expect(parseContractEvents([log(cut)], program)).toHaveLength(0);
      const [camel] = parseCofferPoolEvents([log(cut)]);
      expect(camel.kind).toBe("Unknown"); expect((camel as any).name).toBe(f.name);
    }
  });
  test("[N15] unknown error codes map to undefined / unknown (6107, PA 6019)", () => {
    expect(describeProgramError(6107)).toBeUndefined();
    expect(describeProgramError(6019, "protocolAdmin")).toBeUndefined();
    expect(toSdkError(new Error("custom program error: 0x17db")).code).toBe("unknown"); // 6107
  });
  test("[N16] every pinned legacy name is absent from the IDLs and every typed name is present", () => {
    for (const pin of LEGACY_EVENT_DISCRIMINATORS.values()) {
      const which = pin.program === "cofferPool" ? idl : pin.program === "protocolAdmin" ? pa : stld;
      expect(which.events.some((e: any) => e.name === pin.legacyName)).toBe(false);
    }
    for (const name of TYPED_EVENT_NAMES) expect([...idl.events, ...stld.events].some((e: any) => e.name === name)).toBe(true);
  });
});
