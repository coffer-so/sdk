import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import cubicPoolIdl from "../src/idl/cubic_pool.json";
import stldIdl from "../src/idl/single_token_liquidity.json";
import { parseCubicPoolEvents } from "../src/parsers/events";
import { decodePoolAccount, POOL_V4_LEN } from "../src/parsers/poolAccount";
import {
  buildPoolInitializeConfigIx,
  buildRangeManagerUpdateIx,
} from "../src/clients/tx-builders";
import { getConfig } from "../src/config";

/**
 * Regression guards for the v5.1 wire-format changes that fail SILENTLY —
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

describe("Swap event field order (v5.1)", () => {
  // The trap: surge_fee_amount sits AFTER timestamp. A decoder using the
  // intuitive order returns the unix timestamp as the surge fee.
  test("IDL declares timestamp before surge_fee_amount (no-t22 build: no transfer fees)", () => {
    expect(idlFields(cubicPoolIdl as any, "Swap")).toEqual([
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

    const [ev] = parseCubicPoolEvents([
      programDataLog(discriminatorOf(cubicPoolIdl as any, "Swap"), payload),
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

  test("a pre-v5.1 log without the transfer fees decodes them as 0, not garbage", () => {
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
    const [ev] = parseCubicPoolEvents([
      programDataLog(discriminatorOf(cubicPoolIdl as any, "Swap"), payload),
    ]);
    if (ev.kind !== "Swap") throw new Error(`expected Swap, got ${ev.kind}`);
    expect(ev.timestamp).toBe(1_700_000_000);
    expect(ev.surgeFeeAmount.toNumber()).toBe(5);
    expect(ev.transferFeeIn.toNumber()).toBe(0);
    expect(ev.transferFeeOut.toNumber()).toBe(0);
  });
});

describe("SingleTokenDeposit event (v5.1)", () => {
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
      "bpt_received",
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
      u64(4_242), // bpt_received
      vecU64([1, 2, 3]), // dust_refunded — Vec, not scalar
      i64(1_700_000_123), // timestamp
    ]);
    const [ev] = parseCubicPoolEvents([
      programDataLog(discriminatorOf(stldIdl as any, "SingleTokenDeposit"), payload),
    ]);
    if (ev.kind !== "SingleTokenDeposit") throw new Error(`got ${ev.kind}`);
    expect(ev.tokenInIndex).toBe(1);
    expect(ev.amountIn.toNumber()).toBe(9_999);
    expect(ev.allocations.map((b) => b.toNumber())).toEqual([10, 20, 30]);
    expect(ev.depositedAmounts.map((b) => b.toNumber())).toEqual([11, 21, 31]);
    expect(ev.bptReceived.toNumber()).toBe(4_242);
    expect(ev.dustRefunded.map((b) => b.toNumber())).toEqual([1, 2, 3]);
    // If the phantom u32 slippage read came back, everything after amount_in
    // shifts by 4 bytes and this timestamp is wrong.
    expect(ev.timestamp).toBe(1_700_000_123);
  });
});

describe("TokenChange encoding (v5.1 compare-and-swap)", () => {
  test("IDL puts expected_current between index and new_value", () => {
    expect(idlFields(cubicPoolIdl as any, "TokenChange")).toEqual([
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
      (cubicPoolIdl.instructions as any[]).find((i) => i.name === "range_manager_update")
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

describe("CubicPool account layout (v5.1)", () => {
  test("IDL tail is leverage bounds then reserved[16]", () => {
    const fields = idlFields(cubicPoolIdl as any, "CubicPool");
    expect(fields.slice(-4)).toEqual([
      "banned_extensions",
      "range_manager_max_leverage_bps",
      "range_manager_min_leverage_bps",
      "reserved",
    ]);
    const t = (cubicPoolIdl as any).types.find((c: any) => c.name === "CubicPool");
    const reserved = t.type.fields.find((f: any) => f.name === "reserved");
    expect(reserved.type).toEqual({ array: ["u8", 16] });
  });

  test("AssetConfig replaced reserved[3] with slope_mid + kink, slot still 88", () => {
    const fields = idlFields(cubicPoolIdl as any, "AssetConfig");
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
      Buffer.alloc(8), // discriminator
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
      u64(6), // banned_extensions
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
    expect(raw.bannedExtensions.toNumber()).toBe(6);
    expect(raw.rangeManagerMaxLeverageBps).toBe(30_000);
    expect(raw.rangeManagerMinLeverageBps).toBe(5_000);
  });
});

describe("CubicPoolConfig layout (v5.1)", () => {
  test("hard_banned_extensions precedes a reserved[112]", () => {
    const fields = idlFields(cubicPoolIdl as any, "CubicPoolConfig");
    expect(fields).toEqual([
      "protocol_admin",
      "pending_protocol_admin",
      "default_protocol_fee_rate",
      "banned_extensions",
      "hard_banned_extensions",
      "reserved",
    ]);
    const t = (cubicPoolIdl as any).types.find((c: any) => c.name === "CubicPoolConfig");
    const reserved = t.type.fields.find((f: any) => f.name === "reserved");
    expect(reserved.type).toEqual({ array: ["u8", 112] });
    // 8 disc + 32 + 32 + 2 + 8 + 8 + 112 = 202, unchanged.
    expect(8 + 32 + 32 + 2 + 8 + 8 + 112).toBe(202);
  });
});

describe("instruction signatures the SDK encodes by hand", () => {
  const ix = (name: string) =>
    (cubicPoolIdl.instructions as any[]).find((candidate) => candidate.name === name);

  test("initialize_cubic_pool has no tokens arg", () => {
    expect(ix("initialize_cubic_pool").args.map((a: any) => a.name)).toEqual([
      "normalized_weights",
      "initial_virtual_balances",
      "swap_fee_rate",
      "pool_id",
      "banned_extensions_override",
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
  // `cubic_pool::initialize_config` takes the Treasury PDA as a Signer after
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

  it("targets protocol_admin, not cubic_pool", () => {
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
