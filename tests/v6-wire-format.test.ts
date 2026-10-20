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

describe("Swap event field order (v6)", () => {
  // The trap: surge_fee_amount sits AFTER timestamp. A decoder using the
  // intuitive order returns the unix timestamp as the surge fee. v6 appends
  // the two Token-2022 transfer-fee legs after it.
  test("IDL declares timestamp, surge_fee_amount, then the v6 transfer-fee tail", () => {
    expect(idlFields(cofferPoolIdl as any, "Swap")).toEqual([
      "pool",
      "user",
      "token_in",
      "token_out",
      "amount_in",
      "amount_out",
      "fee_amount",
      "protocol_fee_amount",
      "timestamp",
      "surge_fee_amount",
      "transfer_fee_in",
      "transfer_fee_out",
    ]);
  });

  test("decoder reads each field from the slot the IDL puts it in", () => {
    const pool = Keypair.generate().publicKey;
    const user = Keypair.generate().publicKey;
    const tokenIn = Keypair.generate().publicKey;
    const tokenOut = Keypair.generate().publicKey;

    // Distinct sentinel values so a shifted read cannot coincidentally pass.
    const payload = Buffer.concat([
      pool.toBuffer(),
      user.toBuffer(),
      tokenIn.toBuffer(),
      tokenOut.toBuffer(),
      u64(1_000), // amount_in
      u64(2_000), // amount_out
      u64(3_000), // fee_amount
      u64(4_000), // protocol_fee_amount
      i64(1_700_000_000), // timestamp  ← precedes surge on the wire
      u64(5_000), // surge_fee_amount
      u64(6_000), // transfer_fee_in
      u64(7_000), // transfer_fee_out
    ]);

    const [ev] = parseCofferPoolEvents([
      programDataLog(discriminatorOf(cofferPoolIdl as any, "Swap"), payload),
    ]);

    expect(ev.kind).toBe("Swap");
    if (ev.kind !== "Swap") throw new Error("unreachable");
    expect(ev.amountIn.toNumber()).toBe(1_000);
    expect(ev.amountOut.toNumber()).toBe(2_000);
    expect(ev.feeAmount.toNumber()).toBe(3_000);
    expect(ev.protocolFeeAmount.toNumber()).toBe(4_000);
    // The two that swap places — the whole point of this test.
    expect(ev.timestamp).toBe(1_700_000_000);
    expect(ev.surgeFeeAmount.toNumber()).toBe(5_000);
    expect(ev.transferFeeIn.toNumber()).toBe(6_000);
    expect(ev.transferFeeOut.toNumber()).toBe(7_000);
  });

  test("a v5 log without the transfer-fee tail decodes them as 0, not garbage", () => {
    const pk = () => Keypair.generate().publicKey.toBuffer();
    const payload = Buffer.concat([
      pk(),
      pk(),
      pk(),
      pk(),
      u64(1),
      u64(2),
      u64(3),
      u64(4),
      i64(1_700_000_000),
      u64(5),
      // no transfer_fee_in / transfer_fee_out
    ]);
    const [ev] = parseCofferPoolEvents([
      programDataLog(discriminatorOf(cofferPoolIdl as any, "Swap"), payload),
    ]);
    if (ev.kind !== "Swap") throw new Error(`expected Swap, got ${ev.kind}`);
    expect(ev.timestamp).toBe(1_700_000_000);
    expect(ev.surgeFeeAmount.toNumber()).toBe(5);
    expect(ev.transferFeeIn.toNumber()).toBe(0);
    expect(ev.transferFeeOut.toNumber()).toBe(0);
  });
});

describe("SingleTokenDepositDirect event (v6 planned zap)", () => {
  test("IDL field order: no helper, dust_remaining is a vec", () => {
    expect(idlFields(stldIdl as any, "SingleTokenDepositDirect")).toEqual([
      "pool", "user", "token_in_index", "amount_in", "allocations", "deposited_amounts", "lp_received", "dust_remaining", "timestamp",
    ]);
  });

  test("decoder returns the plan, measured debits and per-token dust", () => {
    const pk = () => Keypair.generate().publicKey.toBuffer();
    const payload = Buffer.concat([
      pk(), // pool
      pk(), // user
      Buffer.from([2]), // token_in_index
      u64(300), // amount_in
      vecU64([200, 100, 0]), // allocations (sum = amount_in)
      vecU64([200, 87, 0]), // deposited_amounts
      u64(95), // lp_received
      vecU64([0, 3, 0]), // dust_remaining
      i64(1_700_000_321), // timestamp
    ]);
    const [ev] = parseCofferPoolEvents([
      programDataLog(discriminatorOf(stldIdl as any, "SingleTokenDepositDirect"), payload),
    ]);
    if (ev.kind !== "SingleTokenDepositDirect") throw new Error(`got ${ev.kind}`);
    expect(ev.tokenInIndex).toBe(2);
    expect(ev.amountIn.toNumber()).toBe(300);
    expect(ev.allocations.map((b) => b.toNumber())).toEqual([200, 100, 0]);
    expect(ev.depositedAmounts.map((b) => b.toNumber())).toEqual([200, 87, 0]);
    expect(ev.lpReceived.toNumber()).toBe(95);
    expect(ev.dustRemaining.map((b) => b.toNumber())).toEqual([0, 3, 0]);
    expect(ev.timestamp).toBe(1_700_000_321);
  });
});

describe("SingleTokenDeposit event (legacy v5 helper route, kept for history)", () => {
  test("IDL has no slippage field and dust_refunded is a vec", () => {
    const fields = idlFields(stldIdl as any, "SingleTokenDeposit");
    expect(fields).toEqual([
      "helper",
      "pool",
      "user",
      "token_in_index",
      "amount_in",
      "allocations",
      "deposited_amounts",
      "lp_received",
      "dust_refunded",
      "timestamp",
    ]);
    const t = (stldIdl as any).types.find((c: any) => c.name === "SingleTokenDeposit");
    const dust = t.type.fields.find((f: any) => f.name === "dust_refunded");
    expect(dust.type).toEqual({ vec: "u64" });
  });

  test("decoder returns per-token dust and a correct timestamp", () => {
    const pk = () => Keypair.generate().publicKey.toBuffer();
    const payload = Buffer.concat([
      pk(), // helper
      pk(), // pool
      pk(), // user
      Buffer.from([1]), // token_in_index
      u64(9_999), // amount_in
      vecU64([10, 20, 30]), // allocations
      vecU64([11, 21, 31]), // deposited_amounts
      u64(4_242), // lp_received
      vecU64([1, 2, 3]), // dust_refunded — Vec, not scalar
      i64(1_700_000_123), // timestamp
    ]);
    const [ev] = parseCofferPoolEvents([
      programDataLog(discriminatorOf(stldIdl as any, "SingleTokenDeposit"), payload),
    ]);
    if (ev.kind !== "SingleTokenDeposit") throw new Error(`got ${ev.kind}`);
    expect(ev.tokenInIndex).toBe(1);
    expect(ev.amountIn.toNumber()).toBe(9_999);
    expect(ev.allocations.map((b) => b.toNumber())).toEqual([10, 20, 30]);
    expect(ev.depositedAmounts.map((b) => b.toNumber())).toEqual([11, 21, 31]);
    expect(ev.lpReceived.toNumber()).toBe(4_242);
    expect(ev.dustRefunded.map((b) => b.toNumber())).toEqual([1, 2, 3]);
    // If the phantom u32 slippage read came back, everything after amount_in
    // shifts by 4 bytes and this timestamp is wrong.
    expect(ev.timestamp).toBe(1_700_000_123);
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
  test("IDL tail is leverage bounds then reserved[16]", () => {
    const fields = idlFields(cofferPoolIdl as any, "CofferPool");
    expect(fields.slice(-4)).toEqual([
      "_deprecated_banned_extensions",
      "range_manager_max_leverage_bps",
      "range_manager_min_leverage_bps",
      "reserved",
    ]);
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

  test("initialize_pool has no tokens arg and (v6.1/T19) no banned_extensions_override", () => {
    expect(ix("initialize_pool").args.map((a: any) => a.name)).toEqual([
      "normalized_weights",
      "initial_virtual_balances",
      "swap_fee_rate",
      "pool_id",
    ]);
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
