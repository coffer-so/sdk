/**
 * Parser unit tests: verify decodePoolAccount handles the v4 (AoS) layout
 * exactly as the on-chain Rust struct lays it out.
 *
 * Cross-validates against:
 *   contracts/programs/cubic-pool/src/state/cubic_pool.rs
 *
 * Layout (1683 bytes total, 8-byte disc + 1675 payload):
 *
 *   header (122):
 *     32 config + 1 bump + 1 token_count + 8 pool_id
 *     + 4 swap_fee_rate + 2 protocol_fee_rate + 8 created_at
 *     + 1 pool_enabled + 1 swaps_enabled
 *     + 32 pool_admin + 32 pending_pool_admin
 *
 *   range manager (49):
 *     32 range_manager + 1 enabled + 2 max_vb_change_bps
 *     + 2 max_weight_change_bps + 4 min_interval + 8 last_updated
 *
 *   tokens (1440 = 10 * 144):
 *     per slot:
 *       AssetConfig (88): 32 mint + 32 token_program + 8 weight
 *                         + 8 max_selloff + 4 period_length + 4 reserved
 *       AssetDynamics (56): 8 virt + 8 actual + 8 fees_owed
 *                         + 8 prev_selloff + 8 cur_selloff + 8 ts + 8 reserved
 *
 *   lookup_table (32) + reserved (32)
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { decodePoolAccount, POOL_V4_LEN } from "../src/parsers/poolAccount";

const ANCHOR_POOL_DISC = Buffer.from([137, 210, 42, 22, 209, 156, 43, 78]); // CubicPool disc

function pk(): PublicKey {
  return Keypair.generate().publicKey;
}

function writeU64LE(buf: Buffer, off: number, v: bigint | number) {
  buf.writeBigUInt64LE(typeof v === "bigint" ? v : BigInt(v), off);
}

function buildSyntheticV4Pool(opts: {
  config: PublicKey;
  bump: number;
  tokenCount: number;
  poolId: bigint;
  swapFeeRate: number;
  protocolFeeRate: number;
  createdAt: number;
  poolEnabled: boolean;
  swapsEnabled: boolean;
  poolAdmin: PublicKey;
  lookupTable: PublicKey;
  tokens: Array<{ mint: PublicKey; tokenProgram: PublicKey; weightBps: bigint; actualBalance: bigint }>;
}): Buffer {
  const buf = Buffer.alloc(POOL_V4_LEN);
  ANCHOR_POOL_DISC.copy(buf, 0);
  let off = 8;
  opts.config.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(opts.bump, off); off += 1;
  buf.writeUInt8(opts.tokenCount, off); off += 1;
  writeU64LE(buf, off, opts.poolId); off += 8;
  buf.writeUInt32LE(opts.swapFeeRate, off); off += 4;
  buf.writeUInt16LE(opts.protocolFeeRate, off); off += 2;
  writeU64LE(buf, off, BigInt(opts.createdAt)); off += 8;
  buf.writeUInt8(opts.poolEnabled ? 1 : 0, off); off += 1;
  buf.writeUInt8(opts.swapsEnabled ? 1 : 0, off); off += 1;
  opts.poolAdmin.toBuffer().copy(buf, off); off += 32;
  PublicKey.default.toBuffer().copy(buf, off); off += 32; // pending
  // range manager block (49) — zeros
  PublicKey.default.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(0, off); off += 1;
  buf.writeUInt16LE(0, off); off += 2;
  buf.writeUInt16LE(0, off); off += 2;
  buf.writeUInt32LE(0, off); off += 4;
  writeU64LE(buf, off, 0n); off += 8;
  // tokens AoS — 10 slots of 144 bytes
  for (let i = 0; i < 10; i++) {
    const slot = opts.tokens[i];
    if (slot) {
      slot.mint.toBuffer().copy(buf, off); off += 32;
      slot.tokenProgram.toBuffer().copy(buf, off); off += 32;
      writeU64LE(buf, off, slot.weightBps); off += 8;
      writeU64LE(buf, off, 0n); off += 8; // max_selloff
      buf.writeUInt32LE(0, off); off += 4; // period
      off += 4; // reserved
      writeU64LE(buf, off, 0n); off += 8; // virtual
      writeU64LE(buf, off, slot.actualBalance); off += 8;
      writeU64LE(buf, off, 0n); off += 8; // fees_owed
      writeU64LE(buf, off, 0n); off += 8; // prev
      writeU64LE(buf, off, 0n); off += 8; // cur
      writeU64LE(buf, off, 0n); off += 8; // window_start
      off += 8; // reserved
    } else {
      off += 144;
    }
  }
  // lookup_table
  opts.lookupTable.toBuffer().copy(buf, off); off += 32;
  // reserved[32] — left zero
  return buf;
}

describe("poolAccount.decode — v4 (AoS) layout", () => {
  it("round-trips a synthetic 7-token v4 pool with non-default lookup_table", () => {
    const config = pk();
    const poolAdmin = pk();
    const lookupTable = pk();
    const tokens = Array.from({ length: 7 }, () => ({
      mint: pk(),
      tokenProgram: pk(),
      weightBps: 10000n / 7n,
      actualBalance: 1_000_000_000n,
    }));

    const data = buildSyntheticV4Pool({
      config,
      bump: 254,
      tokenCount: 7,
      poolId: 42n,
      swapFeeRate: 3000,
      protocolFeeRate: 1500,
      createdAt: 1_700_000_000,
      poolEnabled: true,
      swapsEnabled: true,
      poolAdmin,
      lookupTable,
      tokens,
    });

    expect(data.length).toBe(POOL_V4_LEN);

    const parsed = decodePoolAccount(data);

    expect(parsed.config.toBase58()).toBe(config.toBase58());
    expect(parsed.bump).toBe(254);
    expect(parsed.tokenCount).toBe(7);
    expect(parsed.poolId.toString()).toBe("42");
    expect(parsed.swapFeeRate).toBe(3000);
    expect(parsed.protocolFeeRate).toBe(1500);
    expect(parsed.createdAt.toString()).toBe("1700000000");
    expect(parsed.poolEnabled).toBe(true);
    expect(parsed.swapsEnabled).toBe(true);
    expect(parsed.poolAdmin.toBase58()).toBe(poolAdmin.toBase58());
    expect(parsed.lookupTable.toBase58()).toBe(lookupTable.toBase58());

    for (let i = 0; i < 7; i++) {
      expect(parsed.tokenMints[i].toBase58()).toBe(tokens[i].mint.toBase58());
      expect(parsed.tokenPrograms[i].toBase58()).toBe(tokens[i].tokenProgram.toBase58());
      expect(parsed.actualBalances[i].toString()).toBe(tokens[i].actualBalance.toString());
    }
    // padded slots — Pubkey::default()
    expect(parsed.tokenMints[9].toBase58()).toBe(PublicKey.default.toBase58());
  });

  it("default lookup_table (unprovisioned pool) round-trips as PublicKey.default", () => {
    const data = buildSyntheticV4Pool({
      config: pk(),
      bump: 255,
      tokenCount: 2,
      poolId: 0n,
      swapFeeRate: 0,
      protocolFeeRate: 0,
      createdAt: 0,
      poolEnabled: true,
      swapsEnabled: true,
      poolAdmin: pk(),
      lookupTable: PublicKey.default,
      tokens: [
        { mint: pk(), tokenProgram: pk(), weightBps: 5000n, actualBalance: 1n },
        { mint: pk(), tokenProgram: pk(), weightBps: 5000n, actualBalance: 1n },
      ],
    });

    const parsed = decodePoolAccount(data);
    expect(parsed.lookupTable.toBase58()).toBe(PublicKey.default.toBase58());
  });

  it("rejects v3 (1154-byte) pools with an explicit migration hint", () => {
    const v3 = Buffer.alloc(1154);
    ANCHOR_POOL_DISC.copy(v3, 0);
    expect(() => decodePoolAccount(v3)).toThrow(/migrate_to_v5/);
  });

  it("rejects unknown sizes with a clear error", () => {
    const bogus = Buffer.alloc(1500);
    ANCHOR_POOL_DISC.copy(bogus, 0);
    expect(() => decodePoolAccount(bogus)).toThrow(/unexpected data length/i);
  });
});
