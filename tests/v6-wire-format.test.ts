import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import cofferPoolIdl from "../src/idl/coffer_pool.json";
import stldIdl from "../src/idl/single_token_liquidity.json";
import { parseCofferPoolEvents } from "../src/parsers/events";
import { decodePoolAccount, POOL_V4_LEN } from "../src/parsers/poolAccount";
import {
  buildPoolInitializeConfigIx,
  buildRangeManagerUpdateIx,
} from "../src/clients/tx-builders";
import { getConfig } from "../src/config";

/**
 * Regression guards for the v5.1/v6 wire-format changes that fail SILENTLY —
 * no length error, no exception, just wrong numbers. Each test pins the
 * decoder/encoder against the field order declared in the shipped IDL
 * rather than against the previous hand-written code.
 */

function idlFields(idl: { types: any[] }, name: string): string[] {
  const t = idl.types.find((candidate: any) => candidate.name === name);
  if (!t) throw new Error(`type ${name} missing from IDL`);
  return t.type.fields.map((f: any) => f.name);
}

function discriminatorOf(idl: { events?: any[] }, name: string): Buffer {
  const e = (idl.events ?? []).find((candidate: any) => candidate.name === name);
  if (!e) throw new Error(`event ${name} missing from IDL`);
  return Buffer.from(e.discriminator);
}

/** Wrap an event payload the way the runtime emits it in program logs. */
function programDataLog(disc: Buffer, payload: Buffer): string {
  return `Program data: ${Buffer.concat([disc, payload]).toString("base64")}`;
}

const u64 = (v: number | BN) => new BN(v).toArrayLike(Buffer, "le", 8);
const i64 = u64;
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
};
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
};
const vecU64 = (vs: number[]) => Buffer.concat([u32(vs.length), ...vs.map((v) => u64(v))]);

describe("SwapV2 event field order (v6.1, T11 re-cut)", () => {
  // v6 trap, kept as history: `surge_fee_amount` sat AFTER `timestamp` and
  // the v6.1 tails were appended. T11 re-cut the payload under a NEW
  // discriminator: indices instead of mints, the cascade in order, the two
  // touched slots before / after, `timestamp`, then an `Option<SelloffWindow>`.
  test("IDL declares the re-cut order with timestamp before the trailing Option", () => {
    expect(idlFields(cofferPoolIdl as any, "SwapV2")).toEqual([
      "pool", "user", "token_in_index", "token_out_index", "amount_in", "transfer_fee_in", "amount_in_net",
      "swap_fee_rate", "effective_fee_rate", "protocol_fee_rate", "creator_fee_bps",
      "fee_amount", "protocol_fee_amount", "creator_fee_amount", "amount_out_gross",
      "surge_fee_amount", "surge_protocol_fee_amount", "surge_creator_fee_amount", "amount_out", "transfer_fee_out",
      "in_before", "in_after", "out_before", "out_after", "timestamp", "selloff_window",
    ]);
    expect((cofferPoolIdl as any).types.some((t: any) => t.name === "Swap")).toBe(false);
  });

  test("decoder reads each field from the slot the IDL puts it in (distinct sentinels, window absent)", () => {
    const pool = Keypair.generate().publicKey;
    const user = Keypair.generate().publicKey;
    const slot = (base: number) => Buffer.concat([u64(base + 1), u64(base + 2), u64(base + 3), u64(base + 4), u64(base + 5)]);
    const payload = Buffer.concat([
      pool.toBuffer(), user.toBuffer(), Buffer.from([2]), Buffer.from([0]),
      u64(1_000), u64(10), u64(990), u32(3_000), u32(2_500), u16(1_000), u16(2_500),
      u64(3_000), u64(300), u64(600), u64(2_000), u64(5_000), u64(500), u64(1_100), u64(1_900), u64(7_000),
      slot(100), slot(200), slot(300), slot(400), i64(1_700_000_000), Buffer.from([0]),
    ]);
    const [ev] = parseCofferPoolEvents([programDataLog(discriminatorOf(cofferPoolIdl as any, "SwapV2"), payload)]);
    expect(ev.kind).toBe("SwapV2");
    if (ev.kind !== "SwapV2") throw new Error("unreachable");
    expect(ev.tokenInIndex).toBe(2); expect(ev.tokenOutIndex).toBe(0);
    expect(ev.amountIn.toNumber()).toBe(1_000); expect(ev.transferFeeIn.toNumber()).toBe(10); expect(ev.amountInNet.toNumber()).toBe(990);
    expect(ev.swapFeeRate).toBe(3_000); expect(ev.effectiveFeeRate).toBe(2_500); expect(ev.protocolFeeRate).toBe(1_000); expect(ev.creatorFeeBps).toBe(2_500);
    expect(ev.feeAmount.toNumber()).toBe(3_000); expect(ev.protocolFeeAmount.toNumber()).toBe(300); expect(ev.creatorFeeAmount.toNumber()).toBe(600);
    expect(ev.amountOutGross.toNumber()).toBe(2_000); expect(ev.surgeFeeAmount.toNumber()).toBe(5_000); expect(ev.surgeProtocolFeeAmount.toNumber()).toBe(500);
    expect(ev.surgeCreatorFeeAmount.toNumber()).toBe(1_100); expect(ev.amountOut.toNumber()).toBe(1_900); expect(ev.transferFeeOut.toNumber()).toBe(7_000);
    expect(ev.inBefore.virtualBalance.toNumber()).toBe(101); expect(ev.inAfter.surgeFeesOwed.toNumber()).toBe(205);
    expect(ev.outBefore.actualBalance.toNumber()).toBe(302); expect(ev.outAfter.creatorFeesOwed.toNumber()).toBe(404);
    expect(ev.timestamp).toBe(1_700_000_000);
    expect(ev.selloffWindow).toBeNull();
  });

  test("a v6 Swap log (legacy discriminator) is Unknown, never a shifted SwapV2", () => {
    const pk = () => Keypair.generate().publicKey.toBuffer();
    const payload = Buffer.concat([pk(), pk(), pk(), pk(), u64(1), u64(2), u64(3), u64(4), i64(1_700_000_000), u64(5), u64(6), u64(7)]);
    const [ev] = parseCofferPoolEvents([programDataLog(Buffer.from("516ce3becdd00ac4", "hex"), payload)]);
    expect(ev.kind).toBe("Unknown");
    if (ev.kind !== "Unknown") throw new Error("unreachable");
    expect(ev.name).toBe("Swap"); expect(ev.data.replacedBy).toBe("SwapV2");
  });
});

describe("SingleTokenDepositDirectV2 event (v6.1 planned zap receipt)", () => {
  test("IDL field order: plan hash + validity, inner_swap_count, dust_remaining is a vec, supply before / after", () => {
    expect(idlFields(stldIdl as any, "SingleTokenDepositDirectV2")).toEqual([
      "pool", "user", "token_in_index", "amount_in", "minimum_lp_amount", "allocations", "plan_expected_state", "plan_quoted_at", "plan_valid_until_slot",
      "inner_swap_count", "deposited_amounts", "lp_received", "dust_remaining", "lp_supply_before", "lp_supply_after", "timestamp",
    ]);
    const t = (stldIdl as any).types.find((c: any) => c.name === "SingleTokenDepositDirectV2");
    expect(t.type.fields.find((f: any) => f.name === "dust_remaining").type).toEqual({ vec: "u64" });
    expect(t.type.fields.find((f: any) => f.name === "plan_expected_state").type).toEqual({ array: ["u8", 32] });
  });

  test("decoder returns the plan, measured debits, per-token dust and the supply delta", () => {
    const pk = () => Keypair.generate().publicKey.toBuffer();
    const payload = Buffer.concat([
      pk(), pk(), Buffer.from([2]), u64(300), u64(90), vecU64([200, 100, 0]), Buffer.alloc(32, 7), i64(1_700_000_000), u64(1_000_123), Buffer.from([2]),
      vecU64([200, 87, 0]), u64(95), vecU64([0, 3, 0]), u64(1_000), u64(1_095), i64(1_700_000_321),
    ]);
    const [ev] = parseCofferPoolEvents([programDataLog(discriminatorOf(stldIdl as any, "SingleTokenDepositDirectV2"), payload)]);
    if (ev.kind !== "SingleTokenDepositDirectV2") throw new Error(`got ${ev.kind}`);
    expect(ev.tokenInIndex).toBe(2); expect(ev.amountIn.toNumber()).toBe(300); expect(ev.minimumLpAmount.toNumber()).toBe(90);
    expect(ev.allocations.map((b) => b.toNumber())).toEqual([200, 100, 0]); expect([...ev.planExpectedState]).toEqual(Array(32).fill(7));
    expect(ev.planQuotedAt).toBe(1_700_000_000); expect(ev.planValidUntilSlot.toNumber()).toBe(1_000_123); expect(ev.innerSwapCount).toBe(2);
    expect(ev.depositedAmounts.map((b) => b.toNumber())).toEqual([200, 87, 0]); expect(ev.lpReceived.toNumber()).toBe(95);
    expect(ev.dustRemaining.map((b) => b.toNumber())).toEqual([0, 3, 0]); expect(ev.lpSupplyAfter.sub(ev.lpSupplyBefore).toNumber()).toBe(95);
    expect(ev.timestamp).toBe(1_700_000_321);
  });
});

describe("SingleTokenDeposit event (legacy v5 helper route, retired in v6.1)", () => {
  test("the struct is gone from the IDL and its discriminator decodes as Unknown { retired }", () => {
    expect((stldIdl as any).types.some((c: any) => c.name === "SingleTokenDeposit")).toBe(false);
    expect((stldIdl as any).events.some((c: any) => c.name === "SingleTokenDeposit")).toBe(false);
    const pk = () => Keypair.generate().publicKey.toBuffer();
    const payload = Buffer.concat([pk(), pk(), pk(), Buffer.from([1]), u64(9_999), vecU64([10, 20, 30]), vecU64([11, 21, 31]), u64(4_242), vecU64([1, 2, 3]), i64(1_700_000_123)]);
    const [ev] = parseCofferPoolEvents([programDataLog(Buffer.from("d7368968db27a4eb", "hex"), payload)]);
    if (ev.kind !== "Unknown") throw new Error(`got ${ev.kind}`);
    expect(ev.name).toBe("SingleTokenDeposit"); expect(ev.data.retired).toBe(true);
  });
});

describe("TokenChange encoding (v5.1 compare-and-swap)", () => {
  test("IDL puts expected_current between index and new_value", () => {
    expect(idlFields(cofferPoolIdl as any, "TokenChange")).toEqual([
      "index",
      "expected_current",
      "new_value",
    ]);
  });

  test("builder encodes index, expected_current, new_value in that order", () => {
    const cfg = getConfig("devnet");
    const pool = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;

    const ix = buildRangeManagerUpdateIx(cfg, pool, {
      authority,
      vbChanges: [{ index: 2, expectedCurrent: new BN(111), newValue: new BN(222) }],
      weightChanges: [],
    });

    const disc = Buffer.from(
      (cofferPoolIdl.instructions as any[]).find((i) => i.name === "range_manager_update")
        .discriminator,
    );
    expect(ix.data.slice(0, 8).equals(disc)).toBe(true);

    let off = 8;
    expect(ix.data.readUInt32LE(off)).toBe(1); // vb_changes len
    off += 4;
    expect(ix.data.readUInt8(off)).toBe(2); // index
    off += 1;
    expect(new BN(ix.data.slice(off, off + 8), "le").toNumber()).toBe(111); // expected_current
    off += 8;
    expect(new BN(ix.data.slice(off, off + 8), "le").toNumber()).toBe(222); // new_value
    off += 8;
    expect(ix.data.readUInt32LE(off)).toBe(0); // weight_changes len
    off += 4;
    expect(off).toBe(ix.data.length);
  });

  test("account list is [pool, authority] with authority signing", () => {
    const cfg = getConfig("devnet");
    const pool = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const ix = buildRangeManagerUpdateIx(cfg, pool, {
      authority,
      vbChanges: [{ index: 0, expectedCurrent: new BN(1), newValue: new BN(2) }],
    });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      pool.toBase58(),
      authority.toBase58(),
    ]);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
  });

  test("rejects an empty update instead of paying for a guaranteed revert", () => {
    const cfg = getConfig("devnet");
    expect(() =>
      buildRangeManagerUpdateIx(cfg, Keypair.generate().publicKey, {
        authority: Keypair.generate().publicKey,
      }),
    ).toThrow(/at least one/i);
  });
});

describe("CofferPool account layout (v5.1)", () => {
  test("IDL legacy tail is leverage bounds then reserved[16], followed by the v6.1 block", () => {
    const fields = idlFields(cofferPoolIdl as any, "CofferPool");
    const legacyEnd = fields.indexOf("reserved");
    expect(fields.slice(legacyEnd - 3, legacyEnd + 1)).toEqual([
      "_deprecated_banned_extensions",
      "range_manager_max_leverage_bps",
      "range_manager_min_leverage_bps",
      "reserved",
    ]);
    expect(fields[legacyEnd + 1]).toBe("layout_version");
    expect(fields[fields.length - 1]).toBe("reserved_v61");
    const t = (cofferPoolIdl as any).types.find((c: any) => c.name === "CofferPool");
    const reserved = t.type.fields.find((f: any) => f.name === "reserved");
    expect(reserved.type).toEqual({ array: ["u8", 16] });
  });

  test("AssetConfig replaced reserved[3] with slope_mid + kink, slot still 88", () => {
    const fields = idlFields(cofferPoolIdl as any, "AssetConfig");
    expect(fields).toEqual([
      "mint",
      "token_program",
      "normalized_weight",
      "max_selloff_pct",
      "max_selloff_period_length",
      "variable_fee_threshold_pct",
      "variable_fee_slope_low_pct",
      "variable_fee_slope_high_pct",
      "is_active",
      "variable_fee_slope_mid_pct",
      "variable_fee_kink_pct",
    ]);
    expect(fields).not.toContain("reserved");
    // 32+32+8 +2+4 +2+2+2 +1 +2+1 = 88
    expect(32 + 32 + 8 + 2 + 4 + 2 + 2 + 2 + 1 + 2 + 1).toBe(88);
  });

  test("decoder reads the new per-token and pool-level fields at the right offsets", () => {
    const MAX_TOKENS = 10;
    const mint0 = Keypair.generate().publicKey;
    const tp0 = Keypair.generate().publicKey;

    const slots: Buffer[] = [];
    for (let i = 0; i < MAX_TOKENS; i++) {
      const isFirst = i === 0;
      const assetConfig = Buffer.concat([
        isFirst ? mint0.toBuffer() : PublicKey.default.toBuffer(),
        isFirst ? tp0.toBuffer() : PublicKey.default.toBuffer(),
        u64(isFirst ? 10_000 : 0), // normalized_weight
        u16(isFirst ? 1_500 : 0), // max_selloff_pct
        u32(isFirst ? 3_600 : 0), // max_selloff_period_length
        u16(isFirst ? 8_000 : 0), // variable_fee_threshold_pct
        u16(isFirst ? 100 : 0), // variable_fee_slope_low_pct
        u16(isFirst ? 900 : 0), // variable_fee_slope_high_pct
        Buffer.from([isFirst ? 1 : 0]), // is_active
        u16(isFirst ? 400 : 0), // variable_fee_slope_mid_pct  ← was reserved[0..2]
        Buffer.from([isFirst ? 90 : 0]), // variable_fee_kink_pct ← was reserved[2]
      ]);
      expect(assetConfig.length).toBe(88);
      const assetDynamics = Buffer.concat([
        u64(isFirst ? 111 : 0), // virtual_balance
        u64(isFirst ? 222 : 0), // actual_balance
        u64(0),
        u64(0),
        u64(0),
        i64(0),
        u64(0),
      ]);
      expect(assetDynamics.length).toBe(56);
      slots.push(assetConfig, assetDynamics);
    }

    const buf = Buffer.concat([
      Buffer.from([137, 210, 42, 22, 209, 156, 43, 78]), // CofferPool discriminator
      Keypair.generate().publicKey.toBuffer(), // config
      Buffer.from([255]), // bump
      Buffer.from([1]), // token_count
      u64(7), // pool_id
      u32(3_000), // swap_fee_rate
      u16(1_000), // protocol_fee_rate
      i64(1_600_000_000), // created_at
      Buffer.from([1]), // pool_enabled
      Buffer.from([1]), // swaps_enabled
      Keypair.generate().publicKey.toBuffer(), // pool_admin
      PublicKey.default.toBuffer(), // pending_pool_admin
      Keypair.generate().publicKey.toBuffer(), // range_manager
      Buffer.from([1]), // range_manager_enabled
      u16(500), // range_manager_max_vb_change_pct
      u16(300), // range_manager_max_weight_change_pct
      u32(60), // range_manager_min_update_interval_secs
      i64(1_650_000_000), // range_manager_last_updated
      ...slots,
      PublicKey.default.toBuffer(), // lookup_table
      u64(6), // _deprecated_banned_extensions (policy removed in v6.1/T19; bytes kept)
      u32(30_000), // range_manager_max_leverage_bps  ← new
      u32(5_000), // range_manager_min_leverage_bps   ← new
      Buffer.alloc(16), // reserved[16] (was [24])
    ]);

    // The layout change was designed to keep the account size identical, so
    // size alone can never be the thing that catches a bad offset.
    expect(buf.length).toBe(POOL_V4_LEN);

    const raw = decodePoolAccount(buf);
    expect(raw.tokenCount).toBe(1);
    expect(raw.tokenMints[0].toBase58()).toBe(mint0.toBase58());
    expect(raw.normalizedWeights[0].toNumber()).toBe(10_000);
    expect(raw.variableFeeSlopeLowPct[0]).toBe(100);
    expect(raw.variableFeeSlopeHighPct[0]).toBe(900);
    expect(raw.variableFeeSlopeMidPct[0]).toBe(400);
    expect(raw.variableFeeKinkPct[0]).toBe(90);
    expect(raw.isActive[0]).toBe(true);
    // Reading these correctly proves every one of the 10 slots consumed
    // exactly 144 bytes — a wrong AssetConfig size would slide them.
    expect(raw.virtualBalances[0].toNumber()).toBe(111);
    expect(raw.actualBalances[0].toNumber()).toBe(222);
    expect(raw.deprecatedBannedExtensions.toNumber()).toBe(6);
    expect(raw.rangeManagerMaxLeverageBps).toBe(30_000);
    expect(raw.rangeManagerMinLeverageBps).toBe(5_000);
  });
});

describe("CofferPoolConfig layout (v6.1)", () => {
  test("the two former policy bitmaps are a 16-byte deprecated blob before reserved[112]", () => {
    const fields = idlFields(cofferPoolIdl as any, "CofferPoolConfig");
    expect(fields).toEqual([
      "protocol_admin",
      "pending_protocol_admin",
      "default_protocol_fee_rate",
      "_deprecated_extension_policy",
      "reserved",
    ]);
    const t = (cofferPoolIdl as any).types.find((c: any) => c.name === "CofferPoolConfig");
    const deprecated = t.type.fields.find((f: any) => f.name === "_deprecated_extension_policy");
    expect(deprecated.type).toEqual({ array: ["u8", 16] });
    const reserved = t.type.fields.find((f: any) => f.name === "reserved");
    expect(reserved.type).toEqual({ array: ["u8", 112] });
    // 8 disc + 32 + 32 + 2 + 16 + 112 = 202, unchanged.
    expect(8 + 32 + 32 + 2 + 16 + 112).toBe(202);
  });
});

describe("instruction signatures the SDK encodes by hand", () => {
  const ix = (name: string) =>
    (cofferPoolIdl.instructions as any[]).find((candidate) => candidate.name === name);

  test("initialize_pool has no tokens arg, no banned_extensions_override (T19) and the v6.1 tail (T1 lp_metadata, T14, T7, T9 hook_config LAST)", () => {
    expect(ix("initialize_pool").args.map((a: any) => a.name)).toEqual([
      "normalized_weights",
      "initial_virtual_balances",
      "swap_fee_rate",
      "pool_id",
      "lp_metadata",
      "creator_fee_bps",
      "deposit_fee_bps",
      "withdraw_fee_bps",
      "hook_config",
    ]);
    expect(ix("initialize_pool").args[8].type).toEqual({ option: { defined: { name: "HookConfig" } } });
  });

  test("initialize_config dropped protocol_admin and made the treasury a signer", () => {
    expect(ix("initialize_config").args.map((a: any) => a.name)).toEqual([
      "default_protocol_fee_rate",
    ]);
    const treasury = ix("initialize_config").accounts.find(
      (a: any) => a.name === "protocol_admin_treasury",
    );
    expect(treasury.signer).toBe(true);
  });

  test("set_range_manager prepends config before pool", () => {
    expect(ix("set_range_manager").accounts.map((a: any) => a.name)).toEqual([
      "config",
      "pool",
      "authority",
    ]);
  });

  test("set_range_manager_config appends the leverage band args", () => {
    expect(ix("set_range_manager_config").args.map((a: any) => a.name)).toEqual([
      "max_vb_change_pct",
      "max_weight_change_pct",
      "min_update_interval_secs",
      "max_leverage_bps",
      "min_leverage_bps",
    ]);
  });
});

describe("pool_initialize_config is reachable from a wallet", () => {
  // `coffer_pool::initialize_config` takes the Treasury PDA as a Signer after
  // H-01, so it can only be reached through protocol-admin's CPI. The SDK must
  // build the WRAPPER, or the create-pool flow produces a transaction that can
  // never be signed.
  const idl = require("../src/idl/protocol_admin.json");
  const CFG = getConfig("devnet");
  const CONFIG_KEY = Keypair.generate().publicKey;
  const ADMIN = Keypair.generate().publicKey;
  const spec = idl.instructions.find(
    (i: any) => i.name === "pool_initialize_config",
  );

  it("targets protocol_admin, not coffer_pool", () => {
    const ix = buildPoolInitializeConfigIx(CFG, {
      config: CONFIG_KEY,
      admin: ADMIN,
      defaultProtocolFeeRate: 2000,
    });
    expect(ix.programId.equals(CFG.programs.protocolAdmin)).toBe(true);
  });

  it("account order and signer/writable flags match the IDL exactly", () => {
    const ix = buildPoolInitializeConfigIx(CFG, {
      config: CONFIG_KEY,
      admin: ADMIN,
      defaultProtocolFeeRate: 2000,
    });
    expect(ix.keys.length).toBe(spec.accounts.length);
    spec.accounts.forEach((want: any, i: number) => {
      expect([want.name, ix.keys[i].isSigner]).toEqual([
        want.name,
        !!want.signer,
      ]);
      expect([want.name, ix.keys[i].isWritable]).toEqual([
        want.name,
        !!want.writable,
      ]);
    });
  });

  it("encodes discriminator + u16 fee rate and nothing else", () => {
    const ix = buildPoolInitializeConfigIx(CFG, {
      config: CONFIG_KEY,
      admin: ADMIN,
      defaultProtocolFeeRate: 2000,
    });
    expect(ix.data.length).toBe(8 + 2);
    expect(ix.data.subarray(0, 8)).toEqual(Buffer.from(spec.discriminator));
    expect(ix.data.readUInt16LE(8)).toBe(2000);
  });
});
