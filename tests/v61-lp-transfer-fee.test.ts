/**
 * LP transfer fee (contracts a622faa, 2026-11-19): the Token-2022
 * `TransferFeeConfig` on new LP mints. Covers the pinned discriminators, the
 * fee-account / pool-tag derivations, every builder (raw + protocol-admin
 * wrapper + kind-15 queue + the kind-11 pool-admin queue of I-1), the fee
 * math (ceil / cap / epoch switch / inverse / split), the L-1 / X1 burn
 * stream as the SDK surfaces it (the stream quote, the collect preview, the
 * pending-aware redeem quote; the native vectors of `lp_transfer_fee_drip` /
 * `_settle` / `_schedule` live in `v61-lp-transfer-fee-stream.test.ts`), the
 * error map 6111–6115, the four typed events (`LpTransferFeesCollected` with
 * its `burn_end_ts` tail), the init event order, the LP ATA sizing and the
 * zap LP-mint policy.
 */
import { createHash } from "crypto";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, BorshCoder, Wallet } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, calculateFee, getAccountLen, getAssociatedTokenAddressSync, getMintLen,
  type TransferFee, type TransferFeeConfig,
} from "@solana/spl-token";
import { pack as packTokenMetadata } from "@solana/spl-token-metadata";
import BN from "bn.js";
import {
  LP_TRANSFER_FEE_DISC, SET_LP_TRANSFER_FEE_KIND, deriveLpFeeAccount, lpFeeAccountsOf, treasuryPoolTag, treasuryPoolTagHex, readLpTransferFeeConfig, fetchLpTransferFeeConfig, lpTransferFeeSupported,
  buildSetLpTransferFeeIx, buildProposeSetLpTransferFeeIx, buildCancelSetLpTransferFeeIx, buildExecuteSetLpTransferFeeIx,
  buildSetLpTransferFeeProtocolShareIx, buildPoolSetLpTransferFeeProtocolShareIx, buildExecutePoolSetLpTransferFeeProtocolShareIx,
  buildCollectLpTransferFeesIx, buildCreateLpFeeAccountIx, buildCollectLpTransferFeesTx, redeemLpTransferFeesRemainingAccounts, buildRedeemLpTransferFeesIx,
  buildPoolRedeemLpTransferFeesIx, quoteRedeemLpTransferFees,
} from "../src/clients/lpTransferFee";
import {
  validateLpTransferFeeBps, validateLpTransferFeeProtocolShareBps, lpTransferFeeAt, lpTransferFeeBpsAt, scheduledLpTransferFeeBps, lpTransferFeeOf, lpNetOfTransferFee,
  lpReceivedAfterTransferFee, lpGrossForNet, splitLpTransferFee, previewLpTransferFeeCollection, lpTransferFeeDrip, quoteLpTransferFeeBurnStream, lpBurnStreamOf,
} from "../src/math/lpTransferFee";
import { AdminClient } from "../src/clients/AdminClient";
import { PoolActions, ProtocolActions, poolActionKindOf, protocolActionKindOf, POOL_EXECUTE_INSTRUCTION, PROTOCOL_EXECUTE_INSTRUCTIONS, buildExecutePoolActionIx } from "../src/clients/cooldown";
import { treasuryVaultPda } from "../src/clients/feeClaim";
import { buildInitializePoolIx } from "../src/clients/tx-builders";
import { deriveLpMint, deriveTreasuryPda } from "../src/utils/pda";
import { LP_MINT_BASE_SIZE, LP_MINT_BASE_SIZE_PRE_FEE, LP_TOKEN_ACCOUNT_SIZE_WITH_TRANSFER_FEE, LP_METADATA_GOOD, lpMintAccountSize, lpTokenAccountSize, lpTokenAccountSizeForMint } from "../src/utils/lpMetadata";
import { decodeMintAccount, validatePlannedZapLpMint } from "../src/parsers/mintAccount";
import { decodePoolAccount } from "../src/parsers/poolAccount";
import { decodeTreasuryAccount } from "../src/parsers/treasuryAccount";
import { POOL_LAYOUT, TREASURY_LAYOUT, POOL_ACTION_KIND, PROTOCOL_ACTION_KIND } from "../src/parsers/layout";
import { parseCofferPoolEvents, TYPED_EVENT_NAMES, decodeEventLine } from "../src/parsers/events";
import { describeProgramError, toSdkError } from "../src/utils/errors";
import { IDLS } from "../src/idl";
import {
  DEFAULT_LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS, LP_TRANSFER_FEE_BURN_WINDOW_SECS, LP_TRANSFER_FEE_MAXIMUM, LP_TRANSFER_FEE_PRECISION, MAX_LP_TRANSFER_FEE_BPS,
  MAX_LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS, MIN_LP_SUPPLY,
} from "../src/config";
import type { LpTransferFeesCollectedEvent, LpTransferFeesRedeemedEvent, LpTransferFeeUpdatedEvent, LpTransferFeeProtocolShareUpdatedEvent } from "../src/types/events";
import type { PoolInfo } from "../src/types/pool";
import { eventLog } from "./helpers/borshFixture";
import { mockPool, cfg, pk, bn } from "./helpers/poolFixture";
import cofferFixtures from "./fixtures/events/coffer_pool.json";
import adminFixtures from "./fixtures/events/protocol_admin.json";

const poolIdl = IDLS.cofferPool as any;
const adminIdl = IDLS.protocolAdmin as any;
const poolCoder = new BorshCoder(poolIdl);
const adminCoder = new BorshCoder(adminIdl);
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const disc = (data: Buffer) => data.subarray(0, 8).toString("hex");
const idlDisc = (idl: any, name: string) => Buffer.from(idl.instructions.find((i: any) => i.name === name).discriminator).toString("hex");
const metas = (ix: { keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> }) => ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
const [TREASURY] = deriveTreasuryPda(cfg.programs.protocolAdmin);

const schedule = (bps: number, maximumFee = LP_TRANSFER_FEE_MAXIMUM, epoch = 0n): TransferFee => ({ epoch, maximumFee, transferFeeBasisPoints: bps });
const config = (older: TransferFee, newer: TransferFee, authority = key(7), withheld = 0n): TransferFeeConfig => ({
  transferFeeConfigAuthority: authority, withdrawWithheldAuthority: authority, withheldAmount: withheld, olderTransferFee: older, newerTransferFee: newer,
});

/** A pool snapshot whose LP mint carries the fee extension and that owes the protocol `owed` LP (`pendingBurn` LP still in the stream over `[burnLastTs, burnEndTs]`; the end defaults to `burnLastTs + W`). */
function feePool(owed: bigint, extra: Parameters<typeof mockPool>[0] = {}, stream: { pendingBurn?: bigint; burnLastTs?: number; burnEndTs?: number } = {}): PoolInfo {
  const pool = mockPool(extra);
  pool.lpTransferFeeConfig = config(schedule(0), schedule(100, LP_TRANSFER_FEE_MAXIMUM, 2n), pool.address);
  pool.lpTransferFee = pool.lpTransferFeeConfig.newerTransferFee;
  pool.lpTransferFeeProtocolShareBps = DEFAULT_LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS;
  pool.lpTransferFeesOwedProtocol = bn(owed);
  pool.lpTransferFeesPendingBurn = bn(stream.pendingBurn ?? 0n);
  pool.lpTransferFeeBurnLastTs = bn(stream.burnLastTs ?? 0);
  pool.lpTransferFeeBurnEndTs = bn(stream.burnEndTs ?? (stream.pendingBurn ? (stream.burnLastTs ?? 0) + LP_TRANSFER_FEE_BURN_WINDOW_SECS : (stream.burnLastTs ?? 0)));
  return pool;
}
const WINDOW = BigInt(LP_TRANSFER_FEE_BURN_WINDOW_SECS);

/** Token-2022 LP mint bytes: base + TransferFeeConfig (+ MetadataPointer → self + TokenMetadata). */
function lpMintBytes(mint: PublicKey, pool: PublicKey, fee: { older: [number, bigint, bigint]; newer: [number, bigint, bigint]; withheld?: bigint } | null, metadata = true): Buffer {
  const base = Buffer.alloc(82); base.writeUInt32LE(1, 0); pool.toBuffer().copy(base, 4); base.writeBigUInt64LE(5_000_000_000n, 36); base[44] = 9; base[45] = 1;
  const entries: Buffer[] = [];
  const tlv = (type: number, body: Buffer) => { const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(body.length, 2); entries.push(Buffer.concat([h, body])); };
  if (fee) {
    const b = Buffer.alloc(108); pool.toBuffer().copy(b, 0); pool.toBuffer().copy(b, 32); b.writeBigUInt64LE(fee.withheld ?? 0n, 64);
    const s = ([bps, maxFee, epoch]: [number, bigint, bigint], off: number) => { b.writeBigUInt64LE(epoch, off); b.writeBigUInt64LE(maxFee, off + 8); b.writeUInt16LE(bps, off + 16); };
    s(fee.older, 72); s(fee.newer, 90);
    tlv(ExtensionType.TransferFeeConfig, b);
  }
  if (metadata) {
    const pointer = Buffer.alloc(64); mint.toBuffer().copy(pointer, 32);
    tlv(ExtensionType.MetadataPointer, pointer);
    tlv(ExtensionType.TokenMetadata, Buffer.from(packTokenMetadata({ mint, updateAuthority: PublicKey.default, name: "LP", symbol: "LP", uri: "https://x", additionalMetadata: [["pool", pool.toBase58()]] })));
  }
  return Buffer.concat([base, Buffer.alloc(83), Buffer.from([1]), ...entries]);
}

// ── pins / derivations ──────────────────────────────────────────────────────

describe("pins and derivations", () => {
  test("[P01] the eight discriminators are pinned to the shipped IDLs (abi-pins.json addedInstructions)", () => {
    expect(LP_TRANSFER_FEE_DISC.setLpTransferFee.toString("hex")).toBe("da8162567b51dd69");
    expect(LP_TRANSFER_FEE_DISC.executeSetLpTransferFee.toString("hex")).toBe("e35b25e5e4e08a9b");
    expect(LP_TRANSFER_FEE_DISC.setLpTransferFeeProtocolShare.toString("hex")).toBe("634341a9d2099cb2");
    expect(LP_TRANSFER_FEE_DISC.collectLpTransferFees.toString("hex")).toBe("1433ed8b8eea4644");
    expect(LP_TRANSFER_FEE_DISC.redeemLpTransferFees.toString("hex")).toBe("33b96e8af96ebb32");
    expect(LP_TRANSFER_FEE_DISC.poolSetLpTransferFeeProtocolShare.toString("hex")).toBe("445ed675b1b305ff");
    expect(LP_TRANSFER_FEE_DISC.executePoolSetLpTransferFeeProtocolShare.toString("hex")).toBe("0403cae680edac1f");
    expect(LP_TRANSFER_FEE_DISC.poolRedeemLpTransferFees.toString("hex")).toBe("c40538f8c88d25f7");
    for (const name of ["set_lp_transfer_fee", "execute_set_lp_transfer_fee", "set_lp_transfer_fee_protocol_share", "collect_lp_transfer_fees", "redeem_lp_transfer_fees"]) {
      expect(idlDisc(poolIdl, name)).toBe(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex"));
    }
    // `initialize_pool` kept its discriminator; its arg list ends with the new u16.
    expect(idlDisc(poolIdl, "initialize_pool")).toBe("5fb40aac54aee828");
    expect(poolIdl.instructions.find((i: any) => i.name === "initialize_pool").args.at(-1)).toEqual({ name: "lp_transfer_fee_bps", type: "u16" });
  });
  test("[P02] the LP fee account is ATA(pool PDA, lp_mint, Token-2022) with the off-curve owner", () => {
    const pool = feePool(0n);
    const expected = getAssociatedTokenAddressSync(pool.lpMint, pool.address, true, TOKEN_2022_PROGRAM_ID);
    expect(deriveLpFeeAccount(pool.address, pool.lpMint).equals(expected)).toBe(true);
    expect(PublicKey.isOnCurve(pool.address.toBytes())).toBe(false);
    const both = lpFeeAccountsOf(cfg, pool.address);
    expect(both.lpMint.equals(deriveLpMint(cfg.programs.cofferPool, pool.address)[0])).toBe(true);
    expect(both.lpFeeAccount.equals(expected)).toBe(true);
  });
  test("[P03] treasuryPoolTag = sha256(pool)[..16] (Treasury::pool_tag via payload_hash)", () => {
    const pool = pk();
    const expected = createHash("sha256").update(pool.toBuffer()).digest().subarray(0, 16);
    expect(treasuryPoolTag(pool).equals(expected)).toBe(true); expect(treasuryPoolTag(pool).length).toBe(16);
    expect(treasuryPoolTagHex(pool)).toBe(expected.toString("hex"));
    expect(treasuryPoolTagHex(pool)).not.toBe(treasuryPoolTagHex(pk()));
  });
  test("[P04] constants mirror constants.rs", () => {
    expect(LP_TRANSFER_FEE_PRECISION).toBe(10_000); expect(MAX_LP_TRANSFER_FEE_BPS).toBe(1_000); expect(MAX_LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS).toBe(10_000);
    expect(LP_TRANSFER_FEE_MAXIMUM).toBe(18446744073709551615n); expect(DEFAULT_LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS).toBe(1_000);
    expect(LP_TRANSFER_FEE_BURN_WINDOW_SECS).toBe(86_400); expect(SET_LP_TRANSFER_FEE_KIND).toBe(11); expect(POOL_ACTION_KIND.SetLpTransferFee).toBe(11);
  });
});

// ── builders ────────────────────────────────────────────────────────────────

describe("set_lp_transfer_fee (pool admin, D-class kind 11)", () => {
  test("[P05] accounts [pool w, lp_mint w, authority s, Token-2022], data = disc + u16 (Anchor coder agrees); the LP mint is derived", () => {
    const admin = pk(); const pool = feePool(0n, { poolAdmin: admin });
    const ix = buildSetLpTransferFeeIx(cfg, { pool, authority: admin, bps: 250 });
    expect(ix.programId.equals(cfg.programs.cofferPool)).toBe(true);
    expect(disc(ix.data)).toBe("da8162567b51dd69"); expect(ix.data.length).toBe(10); expect(ix.data.readUInt16LE(8)).toBe(250);
    expect((poolCoder.instruction.decode(ix.data) as any).data).toEqual({ bps: 250 });
    // I-1: `pool` is writable now (the execute path clears the slot through the same context).
    expect(metas(ix)).toEqual([[pool.address.toBase58(), false, true], [pool.lpMint.toBase58(), false, true], [admin.toBase58(), true, false], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false]]);
    expect(poolIdl.instructions.find((i: any) => i.name === "set_lp_transfer_fee").accounts[0]).toMatchObject({ name: "pool", writable: true });
    const raw = buildSetLpTransferFeeIx(cfg, { pool: pool.address, authority: admin, bps: 1_000 });
    expect(raw.keys[1].pubkey.equals(pool.lpMint)).toBe(true); expect(raw.data.readUInt16LE(8)).toBe(1_000);
  });
  test("[N01] bps above 10 % / non-integer; snapshot refusals: cooldown open, locked fees, wrong admin, renounced admin, pre-feature LP mint", () => {
    const admin = pk();
    expect(() => buildSetLpTransferFeeIx(cfg, { pool: pk(), authority: admin, bps: 1_001 })).toThrow(/LpTransferFeeMaxExceeded, 6111/);
    expect(() => buildSetLpTransferFeeIx(cfg, { pool: pk(), authority: admin, bps: -1 })).toThrow(/6111/);
    expect(() => buildSetLpTransferFeeIx(cfg, { pool: pk(), authority: admin, bps: 2.5 })).toThrow(/6111/);
    // D-class: the direct path is closed while pool_admin_delay_secs > 0 (checked first, like the program).
    expect(() => buildSetLpTransferFeeIx(cfg, { pool: feePool(0n, { poolAdmin: admin, poolAdminDelaySecs: 3600 }), authority: admin, bps: 1 })).toThrow(/CooldownRequired, 6089/);
    expect(() => buildSetLpTransferFeeIx(cfg, { pool: feePool(0n, { poolAdmin: admin, liquidityFeesLocked: true }), authority: admin, bps: 1 })).toThrow(/LiquidityFeesLocked/);
    expect(() => buildSetLpTransferFeeIx(cfg, { pool: feePool(0n, { poolAdmin: pk() }), authority: admin, bps: 1 })).toThrow(/Unauthorized/);
    expect(() => buildSetLpTransferFeeIx(cfg, { pool: feePool(0n, { poolAdmin: PublicKey.default }), authority: admin, bps: 1 })).toThrow(/PoolAdminDisabled/);
    const legacy = feePool(0n, { poolAdmin: admin }); legacy.lpTransferFeeConfig = null;
    expect(() => buildSetLpTransferFeeIx(cfg, { pool: legacy, authority: admin, bps: 1 })).toThrow(/LpTransferFeeUnsupported, 6112/);
    const spl = feePool(0n, { poolAdmin: admin, lpTokenProgram: TOKEN_PROGRAM_ID });
    expect(() => buildSetLpTransferFeeIx(cfg, { pool: spl, authority: admin, bps: 1 })).toThrow(/6112/);
    expect(lpTransferFeeSupported({ lpTransferFeeConfig: undefined, lpTokenProgram: TOKEN_2022_PROGRAM_ID })).toBe(true); // unknown ⇒ let the program decide
  });
  test("[P05b] PoolActions.setLpTransferFee: kind 11, Borsh tag 10 (u16 payload), coder round trip, execute table", () => {
    const action = PoolActions.setLpTransferFee(250);
    expect(action).toEqual({ SetLpTransferFee: { bps: 250 } }); expect(poolActionKindOf(action)).toBe(11);
    const encoded = poolCoder.types.encode("PoolAction", action);
    expect(encoded.length).toBe(3); expect(encoded[0]).toBe(10); expect(encoded.readUInt16LE(1)).toBe(250);
    expect(poolCoder.types.decode("PoolAction", encoded)).toEqual(action);
    expect(POOL_EXECUTE_INSTRUCTION.SetLpTransferFee).toBe("execute_set_lp_transfer_fee");
    for (const bad of [1_001, -1, 0.5]) expect(() => PoolActions.setLpTransferFee(bad)).toThrow(/6111/);
  });
  test("[P05c] propose (SetLpTransferFee { bps }) [pool w, authority s], cancel(11), execute [pool w, lp_mint w, authority s, Token-2022] — Anchor coder agrees", () => {
    const admin = pk(); const pool = feePool(0n, { poolAdmin: admin, poolAdminDelaySecs: 86_400 });
    const propose = buildProposeSetLpTransferFeeIx(cfg, { pool, authority: admin, bps: 500 });
    expect(disc(propose.data)).toBe(idlDisc(poolIdl, "propose_pool_action"));
    const decodedPropose = poolCoder.instruction.decode(propose.data) as any;
    expect(decodedPropose.name).toBe("propose_pool_action"); expect(decodedPropose.data.action).toEqual({ SetLpTransferFee: { bps: 500 } });
    expect(metas(propose)).toEqual([[pool.address.toBase58(), false, true], [admin.toBase58(), true, false]]);
    // Independent Borsh: disc + tag 10 + u16 LE.
    expect(propose.data.subarray(8).equals(Buffer.from([10, 0xf4, 0x01]))).toBe(true);
    const cancel = buildCancelSetLpTransferFeeIx(cfg, pool, admin);
    expect((poolCoder.instruction.decode(cancel.data) as any)).toEqual({ name: "cancel_pool_action", data: { kind: 11 } });
    expect(cancel.data.equals(Buffer.concat([Buffer.from(idlDisc(poolIdl, "cancel_pool_action"), "hex"), Buffer.from([11])]))).toBe(true);
    expect(metas(cancel)).toEqual([[pool.address.toBase58(), false, true], [admin.toBase58(), true, false]]);
    const exec = buildExecuteSetLpTransferFeeIx(cfg, { pool, authority: admin });
    expect(disc(exec.data)).toBe("e35b25e5e4e08a9b"); expect(exec.data.length).toBe(8);
    expect((poolCoder.instruction.decode(exec.data) as any).name).toBe("execute_set_lp_transfer_fee");
    expect(metas(exec)).toEqual([[pool.address.toBase58(), false, true], [pool.lpMint.toBase58(), false, true], [admin.toBase58(), true, false], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false]]);
    // the generic kind-11 execute and the explicit-lp-mint form produce the same wire
    const generic = buildExecutePoolActionIx(cfg, pool.address, admin, 11);
    expect(generic.data.equals(exec.data)).toBe(true); expect(metas(generic)).toEqual(metas(exec));
    const explicit = buildExecuteSetLpTransferFeeIx(cfg, { pool: pool.address, authority: admin, lpMint: pool.lpMint });
    expect(metas(explicit)).toEqual(metas(exec));
    // same snapshot refusals as the direct setter (minus the cooldown: the queue IS the delayed path)
    expect(() => buildProposeSetLpTransferFeeIx(cfg, { pool: feePool(0n, { poolAdmin: admin, liquidityFeesLocked: true }), authority: admin, bps: 1 })).toThrow(/LiquidityFeesLocked/);
    expect(() => buildProposeSetLpTransferFeeIx(cfg, { pool, authority: pk(), bps: 1 })).toThrow(/Unauthorized/);
    expect(() => buildProposeSetLpTransferFeeIx(cfg, { pool, authority: admin, bps: 1_001 })).toThrow(/6111/);
    expect(() => buildExecuteSetLpTransferFeeIx(cfg, { pool: feePool(0n, { poolAdmin: PublicKey.default }), authority: admin })).toThrow(/PoolAdminDisabled/);
    const legacy = feePool(0n, { poolAdmin: admin }); legacy.lpTransferFeeConfig = null;
    expect(() => buildExecuteSetLpTransferFeeIx(cfg, { pool: legacy, authority: admin })).toThrow(/6112/);
    expect(() => buildProposeSetLpTransferFeeIx(cfg, { pool: legacy, authority: admin, bps: 1 })).toThrow(/6112/);
  });
  test("[P05d] a decoded kind-11 slot @2150 feeds pendingActions[11] and the mask bit 11", () => {
    const b = Buffer.alloc(POOL_LAYOUT.TOTAL); Buffer.from("89d22a16d19c2b4e", "hex").copy(b, 0); b[41] = 2; b[1683] = 1; Buffer.from("V5M1").copy(b, 1667);
    const o = POOL_LAYOUT.PENDING_SET_LP_TRANSFER_FEE.offset;
    expect(o).toBe(2150); expect(POOL_LAYOUT.PENDING_SET_LP_TRANSFER_FEE.size).toBe(10);
    expect(POOL_LAYOUT.LP_TRANSFER_FEE_BURN_END_TS).toEqual({ offset: 2160, size: 8 }); expect(POOL_LAYOUT.RESERVED_V61).toEqual({ offset: 2168, size: 136 });
    b.writeBigInt64LE(1_800_000_000n, o); b.writeUInt16LE(999, o + 8);
    const raw = decodePoolAccount(b);
    expect(raw.pendingActions).toHaveLength(12);
    expect(raw.pendingActions[11]).toMatchObject({ kind: 11, name: "SetLpTransferFee", payload: { bps: 999 } });
    expect(raw.pendingActions[11].eta.toString()).toBe("1800000000"); expect(raw.pendingActionsMask).toBe(1 << 11); expect(raw.layoutDrift).toEqual([]);
  });
});

describe("set_lp_transfer_fee_protocol_share: raw, wrapper, execute, kind-15 queue", () => {
  const admin = pk(), configKey = pk(), pool = pk();
  test("[P06] raw coffer_pool form [config, pool w, authority s] + u16; 0..=10_000", () => {
    const ix = buildSetLpTransferFeeProtocolShareIx(cfg, configKey, pool, TREASURY, 10_000);
    expect(disc(ix.data)).toBe("634341a9d2099cb2"); expect((poolCoder.instruction.decode(ix.data) as any).data).toEqual({ bps: 10_000 });
    expect(metas(ix)).toEqual([[configKey.toBase58(), false, false], [pool.toBase58(), false, true], [TREASURY.toBase58(), true, false]]);
    expect(() => buildSetLpTransferFeeProtocolShareIx(cfg, configKey, pool, TREASURY, 10_001)).toThrow(/LpTransferFeeProtocolShareMaxExceeded, 6113/);
  });
  test("[P07] protocol_admin wrapper [treasury, admin s, config, pool w, coffer_pool_program] + u16; AdminClient delegates", () => {
    const ix = buildPoolSetLpTransferFeeProtocolShareIx(cfg, { admin, config: configKey, pool, bps: 2_500 });
    expect(ix.programId.equals(cfg.programs.protocolAdmin)).toBe(true);
    expect(disc(ix.data)).toBe("445ed675b1b305ff"); expect((adminCoder.instruction.decode(ix.data) as any).data).toEqual({ bps: 2_500 });
    expect(metas(ix)).toEqual([[TREASURY.toBase58(), false, false], [admin.toBase58(), true, false], [configKey.toBase58(), false, false], [pool.toBase58(), false, true], [cfg.programs.cofferPool.toBase58(), false, false]]);
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {}) });
    const viaClient = client.poolSetLpTransferFeeProtocolShareIx(admin, configKey, pool, 2_500);
    expect(viaClient.data.equals(ix.data)).toBe(true); expect(metas(viaClient)).toEqual(metas(ix));
    expect(() => buildPoolSetLpTransferFeeProtocolShareIx(cfg, { admin, config: configKey, pool, bps: 10_001 })).toThrow(/6113/);
  });
  test("[P08] execute_pool_set_lp_transfer_fee_protocol_share [treasury w, admin s, config, pool w, coffer_pool_program], no args", () => {
    const ix = buildExecutePoolSetLpTransferFeeProtocolShareIx(cfg, { admin, config: configKey, pool });
    expect(disc(ix.data)).toBe("0403cae680edac1f"); expect(ix.data.length).toBe(8);
    expect(metas(ix)).toEqual([[TREASURY.toBase58(), false, true], [admin.toBase58(), true, false], [configKey.toBase58(), false, false], [pool.toBase58(), false, true], [cfg.programs.cofferPool.toBase58(), false, false]]);
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {}) });
    expect(client.executePoolSetLpTransferFeeProtocolShareIx(admin, configKey, pool).data.equals(ix.data)).toBe(true);
  });
  test("[P09] ProtocolActions.poolSetLpTransferFeeProtocolShare: kind 15, Borsh tag 14, coder round trip, execute table", () => {
    const action = ProtocolActions.poolSetLpTransferFeeProtocolShare(pool, 3_333);
    expect(action).toEqual({ PoolSetLpTransferFeeProtocolShare: { pool, bps: 3_333 } });
    expect(protocolActionKindOf(action)).toBe(15); expect(PROTOCOL_ACTION_KIND.PoolSetLpTransferFeeProtocolShare).toBe(15);
    const encoded = adminCoder.types.encode("ProtocolAction", action);
    expect(encoded[0]).toBe(14); expect(encoded.length).toBe(1 + 32 + 2); expect(encoded.readUInt16LE(33)).toBe(3_333);
    expect(adminCoder.types.decode("ProtocolAction", encoded)).toEqual(action);
    expect(PROTOCOL_EXECUTE_INSTRUCTIONS.PoolSetLpTransferFeeProtocolShare).toEqual(["execute_pool_set_lp_transfer_fee_protocol_share"]);
    expect(() => ProtocolActions.poolSetLpTransferFeeProtocolShare(pool, 10_001)).toThrow(/LpTransferFeeProtocolShareMaxExceeded/);
    expect(() => ProtocolActions.poolSetLpTransferFeeProtocolShare(pool, 1.5)).toThrow();
    // propose_action carries the enum through the IDL coder (no remaining accounts for this kind).
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {}) });
    const propose = client.proposeActionIx(admin, action);
    expect((adminCoder.instruction.decode(propose.data) as any).data.action).toEqual(action); expect(propose.keys.length).toBe(2);
  });
  test("[P10] the Treasury slot pins the pool by tag: a decoded pending kind-15 slot matches treasuryPoolTagHex(pool)", () => {
    const b = Buffer.alloc(TREASURY_LAYOUT.TOTAL); Buffer.from("eeef7bee5901a8fd", "hex").copy(b, 0);
    const o = TREASURY_LAYOUT.PENDING_POOL_SET_LP_TRANSFER_FEE_PROTOCOL_SHARE.offset;
    b.writeBigInt64LE(1_800_000_015n, o); b.writeUInt16LE(3_333, o + 8); treasuryPoolTag(pool).copy(b, o + 10);
    const t = decodeTreasuryAccount(b);
    expect(t.pendingActions[15]).toMatchObject({ kind: 15, name: "PoolSetLpTransferFeeProtocolShare", payload: { bps: 3_333, poolTag: treasuryPoolTagHex(pool) } });
    expect(t.pendingActionsMask).toBe(1 << 15); expect(t.reservedV61NonZero).toBe(false);
    expect(t.pendingActions[15].payload.poolTag).not.toBe(treasuryPoolTagHex(pk()));
  });
});

describe("collect_lp_transfer_fees (permissionless)", () => {
  test("[P11] accounts [pool w, lp_mint w, lp_fee_account w, Token-2022] + writable sources; no data", () => {
    const pool = feePool(0n); const sources = [pk(), pk(), pk()];
    const ix = buildCollectLpTransferFeesIx(cfg, { pool, sources });
    expect(disc(ix.data)).toBe("1433ed8b8eea4644"); expect(ix.data.length).toBe(8);
    const fee = deriveLpFeeAccount(pool.address, pool.lpMint);
    expect(metas(ix).slice(0, 4)).toEqual([[pool.address.toBase58(), false, true], [pool.lpMint.toBase58(), false, true], [fee.toBase58(), false, true], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false]]);
    expect(metas(ix).slice(4)).toEqual(sources.map((s) => [s.toBase58(), false, true]));
    expect(buildCollectLpTransferFeesIx(cfg, { pool: pool.address }).keys.length).toBe(4);
  });
  test("[P12] the Tx prepends the idempotent fee-account create (ATA program, pool PDA owner) unless told not to", () => {
    const pool = feePool(0n); const payer = pk();
    const tx = buildCollectLpTransferFeesTx(cfg, { pool, payer, sources: [pk()] });
    expect(tx.instructions.length).toBe(3);
    const create = tx.instructions[1];
    expect(create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true); expect(create.data).toEqual(Buffer.from([1]));
    expect(create.keys.map((k) => k.pubkey.toBase58())).toEqual([payer, deriveLpFeeAccount(pool.address, pool.lpMint), pool.address, pool.lpMint, SystemProgram.programId, TOKEN_2022_PROGRAM_ID].map((k) => k.toBase58()));
    expect(create.data.equals(buildCreateLpFeeAccountIx(cfg, pool.address, payer).data)).toBe(true);
    expect(disc(tx.instructions[2].data)).toBe("1433ed8b8eea4644"); expect(tx.suggestedCuLimit).toBe(120_000);
    const bare = buildCollectLpTransferFeesTx(cfg, { pool: pool.address, payer, createFeeAccount: false, computeUnitLimit: 77_000 });
    expect(bare.instructions.length).toBe(2); expect(bare.suggestedCuLimit).toBe(77_000);
  });
  test("[N02] duplicate sources, the fee account as a source, a pre-feature snapshot", () => {
    const pool = feePool(0n); const s = pk();
    expect(() => buildCollectLpTransferFeesIx(cfg, { pool, sources: [s, s] })).toThrow(/duplicate source/);
    expect(() => buildCollectLpTransferFeesIx(cfg, { pool, sources: [deriveLpFeeAccount(pool.address, pool.lpMint)] })).toThrow(/destination, not a source/);
    const legacy = feePool(0n); legacy.lpTransferFeeConfig = null;
    expect(() => buildCollectLpTransferFeesIx(cfg, { pool: legacy })).toThrow(/6112/);
  });
});

describe("redeem_lp_transfer_fees: raw and the Treasury wrapper", () => {
  test("[P13] remaining = [vault_i, recipient_i]×n, mint×n, token_program×n + tail (no hook slice)", () => {
    const pool = feePool(10n, { tokenCount: 3, tokenPrograms: [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID] });
    const recipients = [pk(), pk(), pk()]; const memo = pk();
    const rem = redeemLpTransferFeesRemainingAccounts(pool, recipients, [{ pubkey: memo, isSigner: false, isWritable: false }]);
    expect(rem.length).toBe(3 * 4 + 1);
    pool.tokens.forEach((t, i) => {
      expect(rem[2 * i].pubkey.equals(t.vault) && rem[2 * i].isWritable).toBe(true);
      expect(rem[2 * i + 1].pubkey.equals(recipients[i]) && rem[2 * i + 1].isWritable).toBe(true);
      expect(rem[6 + i].pubkey.equals(t.mint) && !rem[6 + i].isWritable).toBe(true);
      expect(rem[9 + i].pubkey.equals(t.tokenProgram) && !rem[9 + i].isWritable).toBe(true);
    });
    expect(rem[12].pubkey.equals(memo)).toBe(true);
    expect(() => redeemLpTransferFeesRemainingAccounts(pool, [pk()])).toThrow(/recipients length/);
    expect(() => redeemLpTransferFeesRemainingAccounts(pool, recipients, [{ pubkey: memo, isSigner: true, isWritable: false }])).toThrow(/signers/);
    expect(() => redeemLpTransferFeesRemainingAccounts(pool, recipients, [{ pubkey: memo, isSigner: false, isWritable: false }, { pubkey: memo, isSigner: false, isWritable: true }])).toThrow(/duplicate tail/);
  });
  test("[P14] raw coffer_pool redeem: [config, pool w, lp_mint w, lp_fee_account w, authority s, Token-2022] + block", () => {
    const pool = feePool(10n); const recipients = [pk(), pk()];
    const ix = buildRedeemLpTransferFeesIx(cfg, { pool, authority: TREASURY, recipients });
    expect(disc(ix.data)).toBe("33b96e8af96ebb32"); expect(ix.data.length).toBe(8);
    expect(metas(ix).slice(0, 6)).toEqual([
      [pool.config.toBase58(), false, false], [pool.address.toBase58(), false, true], [pool.lpMint.toBase58(), false, true],
      [deriveLpFeeAccount(pool.address, pool.lpMint).toBase58(), false, true], [TREASURY.toBase58(), true, false], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false],
    ]);
    expect(ix.keys.length).toBe(6 + 8);
  });
  test("[P15] pool_redeem_lp_transfer_fees wrapper: fixed accounts, recipients pinned to the Treasury vault PDAs, AdminClient delegates", () => {
    const admin = pk(); const pool = feePool(10n, { tokenPrograms: [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] });
    const ix = buildPoolRedeemLpTransferFeesIx(cfg, { admin, pool });
    expect(ix.programId.equals(cfg.programs.protocolAdmin)).toBe(true); expect(disc(ix.data)).toBe("c40538f8c88d25f7"); expect(ix.data.length).toBe(8);
    expect(metas(ix).slice(0, 8)).toEqual([
      [TREASURY.toBase58(), false, false], [admin.toBase58(), true, false], [pool.config.toBase58(), false, false], [pool.address.toBase58(), false, true],
      [pool.lpMint.toBase58(), false, true], [deriveLpFeeAccount(pool.address, pool.lpMint).toBase58(), false, true], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false],
      [cfg.programs.cofferPool.toBase58(), false, false],
    ]);
    pool.tokens.forEach((t, i) => {
      const vault = treasuryVaultPda(t.mint, cfg.programs.protocolAdmin);
      expect(ix.recipients[i].equals(vault)).toBe(true); expect(ix.keys[8 + 2 * i + 1].pubkey.equals(vault)).toBe(true);
    });
    expect(ix.keys.length).toBe(8 + 8);
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {}) });
    const viaClient = client.poolRedeemLpTransferFeesIx(admin, pool, [{ pubkey: key(9), isSigner: false, isWritable: false }]);
    expect(metas(viaClient).slice(0, 16)).toEqual(metas(ix)); expect(viaClient.keys.length).toBe(17);
  });
  test("[N03] nothing owed / pool disabled / pre-feature mint are refused before building", () => {
    const admin = pk();
    expect(() => buildPoolRedeemLpTransferFeesIx(cfg, { admin, pool: feePool(0n) })).toThrow(/NoLpTransferFeesOwed, 6114/);
    expect(() => buildPoolRedeemLpTransferFeesIx(cfg, { admin, pool: feePool(5n, { poolEnabled: false }) })).toThrow(/PoolDisabled/);
    const legacy = feePool(5n); legacy.lpTransferFeeConfig = null;
    expect(() => buildRedeemLpTransferFeesIx(cfg, { pool: legacy, authority: TREASURY, recipients: [pk(), pk()] })).toThrow(/6112/);
    // An older snapshot without the field is not refused client-side (the program decides).
    const unknown = feePool(0n); delete unknown.lpTransferFeesOwedProtocol;
    expect(() => buildPoolRedeemLpTransferFeesIx(cfg, { admin, pool: unknown })).not.toThrow();
  });
  test("[P16] quoteRedeemLpTransferFees: pro-rata legs, MIN_LP_SUPPLY clamp leaves a remainder owed; the stream stays behind", () => {
    const pool = feePool(250_000_000_000n, { surge: [100n, 0n] }, { pendingBurn: 7_000n, burnLastTs: 1_700_000_000 }); // supply 1e12, actual 1e9 each
    const q = quoteRedeemLpTransferFees(pool);
    expect(q.lpBurn).toBe(250_000_000_000n); expect(q.remainderOwed).toBe(0n);
    expect(q.tokenAmounts).toEqual([250_000_000n, 250_000_000n]); expect(q.surgeAmounts).toEqual([25n, 0n]);
    expect(q.pendingBurn).toBe(7_000n); expect(q.feeAccountReserved).toBe(250_000_007_000n); expect(q.streamBurnNow).toBe(0n);
    expect(quoteRedeemLpTransferFees(pool, { now: 1_700_000_000 + 43_200 }).streamBurnNow).toBe(3_500n);
    // the drip follows the pool's own segment, not a fixed window: an end 2 h away releases half after an hour
    const short = feePool(250_000_000_000n, { surge: [100n, 0n] }, { pendingBurn: 7_000n, burnLastTs: 1_700_000_000, burnEndTs: 1_700_007_200 });
    expect(quoteRedeemLpTransferFees(short, { now: 1_700_003_600 }).streamBurnNow).toBe(3_500n);
    expect(quoteRedeemLpTransferFees(short, { now: 1_700_007_200 }).streamBurnNow).toBe(7_000n);
    // a snapshot without the stream fields (older SDK consumer) reads a zeroed triple: everything is burnable at any positive clock
    const bare = feePool(10n, {}, { pendingBurn: 5n }); delete bare.lpTransferFeeBurnLastTs; delete bare.lpTransferFeeBurnEndTs;
    expect(quoteRedeemLpTransferFees(bare, { now: 1 }).streamBurnNow).toBe(5n);
    expect(quoteRedeemLpTransferFees(pool, { feeAccountAmount: 250_000_007_000n }).lpBurn).toBe(250_000_000_000n);
    const tiny = feePool(5_000n, { lpSupply: 5_000n });
    const clamped = quoteRedeemLpTransferFees(tiny);
    expect(clamped.lpBurn).toBe(5_000n - MIN_LP_SUPPLY); expect(clamped.remainderOwed).toBe(MIN_LP_SUPPLY);
  });
  test("[N03b] pending-aware refusals: LpFeeAccountUnderfunded below owed + pending; FullExitRequiredBelowFloor at the floor with a stream", () => {
    const pool = feePool(1_000n, {}, { pendingBurn: 500n });
    expect(() => quoteRedeemLpTransferFees(pool, { feeAccountAmount: 1_499n })).toThrow(/LpFeeAccountUnderfunded/);
    expect(() => quoteRedeemLpTransferFees(pool, { feeAccountAmount: 1_500n })).not.toThrow();
    // supply ≤ 1000: the whole fee account must go — impossible while anything is pending
    const floor = feePool(600n, { lpSupply: 1_000n }, { pendingBurn: 1n });
    expect(() => quoteRedeemLpTransferFees(floor)).toThrow(/FullExitRequiredBelowFloor/);
    expect(() => buildPoolRedeemLpTransferFeesIx(cfg, { admin: pk(), pool: floor })).toThrow(/FullExitRequiredBelowFloor, 6109/);
    const floorClean = feePool(600n, { lpSupply: 1_000n });
    expect(quoteRedeemLpTransferFees(floorClean).lpBurn).toBe(600n); // at the floor the whole owed burns
    expect(() => quoteRedeemLpTransferFees(floorClean, { feeAccountAmount: 601n })).toThrow(/FullExitRequiredBelowFloor/); // a donation next to the owed LP
    expect(() => quoteRedeemLpTransferFees(floorClean, { feeAccountAmount: 600n })).not.toThrow();
    expect(() => buildPoolRedeemLpTransferFeesIx(cfg, { admin: pk(), pool: floorClean })).not.toThrow();
    // above the floor a pending stream is fine for the builder
    expect(() => buildPoolRedeemLpTransferFeesIx(cfg, { admin: pk(), pool })).not.toThrow();
  });
});

describe("initialize_pool / atomic deploy carry lp_transfer_fee_bps", () => {
  test("[P17] the trailing u16 is encoded after hook_config and decodes through the Anchor coder", () => {
    const p = { payer: pk(), configKey: pk(), poolId: new BN(7), tokens: [pk(), pk()], weightsBps: [5000, 5000], virtualBalances: [new BN(1_000), new BN(1_000)], swapFeeRate: 3000, lpMetadata: LP_METADATA_GOOD };
    const zero = buildInitializePoolIx(cfg, p), fee = buildInitializePoolIx(cfg, { ...p, lpTransferFeeBps: 1_000 });
    expect(zero.data.length).toBe(fee.data.length); expect(zero.data.readUInt16LE(zero.data.length - 2)).toBe(0); expect(fee.data.readUInt16LE(fee.data.length - 2)).toBe(1_000);
    const decoded = poolCoder.instruction.decode(fee.data) as any;
    expect(decoded.name).toBe("initialize_pool"); expect(decoded.data.lp_transfer_fee_bps).toBe(1_000); expect(decoded.data.hook_config).toBeNull();
    expect(decoded.data.withdraw_fee_bps).toBe(0);
  });
});

// ── fee math ────────────────────────────────────────────────────────────────

describe("LP transfer fee math", () => {
  test("[P18] fee = ceil(amount · bps / 10_000): rounding up, zero rate, zero amount, no schedule", () => {
    const s = schedule(100); // 1 %
    expect(lpTransferFeeOf(s, 10_000n)).toBe(100n); expect(lpTransferFeeOf(s, 10_001n)).toBe(101n); expect(lpTransferFeeOf(s, 1n)).toBe(1n); expect(lpTransferFeeOf(s, 99n)).toBe(1n);
    expect(lpTransferFeeOf(schedule(0), 10_000n)).toBe(0n); expect(lpTransferFeeOf(s, 0n)).toBe(0n); expect(lpTransferFeeOf(null, 10_000n)).toBe(0n);
    expect(lpTransferFeeOf(schedule(1_000), 10n)).toBe(1n); // 10 % of 10 = 1 exactly
    expect(lpTransferFeeOf(schedule(1_000), 9n)).toBe(1n); // ceil(0.9)
    expect(lpNetOfTransferFee(s, 10_001n)).toBe(9_900n);
  });
  test("[P19] the fee is capped at maximumFee; u64::MAX means uncapped (the LP mint's setting)", () => {
    expect(lpTransferFeeOf(schedule(1_000, 5n), 1_000_000n)).toBe(5n);
    expect(lpTransferFeeOf(schedule(1_000, LP_TRANSFER_FEE_MAXIMUM), 1_000_000n)).toBe(100_000n);
    expect(lpTransferFeeOf(schedule(10_000, 7n), 3n)).toBe(3n); // 100 % below the cap
    expect(lpTransferFeeOf(schedule(1_000), LP_TRANSFER_FEE_MAXIMUM)).toBe(1844674407370955162n); // ceil(u64::MAX / 10)
  });
  test("[P20] matches spl-token calculateFee on a vector sweep (bps × amount × cap)", () => {
    for (const bps of [0, 1, 7, 100, 999, 1_000, 10_000]) for (const amount of [0n, 1n, 9n, 10n, 999n, 10_000n, 123_456_789n, 10n ** 18n]) for (const cap of [0n, 3n, 1_000n, LP_TRANSFER_FEE_MAXIMUM]) {
      const s = schedule(bps, cap);
      expect(lpTransferFeeOf(s, amount)).toBe(calculateFee(s, amount));
    }
  });
  test("[P21] epoch switch: older before newer.epoch, newer from it; scheduled = newer", () => {
    const c = config(schedule(50, LP_TRANSFER_FEE_MAXIMUM, 0n), schedule(300, LP_TRANSFER_FEE_MAXIMUM, 12n));
    expect(lpTransferFeeAt(c, 11n)!.transferFeeBasisPoints).toBe(50); expect(lpTransferFeeAt(c, 12n)!.transferFeeBasisPoints).toBe(300); expect(lpTransferFeeAt(c, 13)!.transferFeeBasisPoints).toBe(300);
    expect(lpTransferFeeBpsAt(c, 0)).toBe(50); expect(lpTransferFeeBpsAt(null, 0)).toBe(0);
    expect(scheduledLpTransferFeeBps(c)).toBe(300); expect(scheduledLpTransferFeeBps(null)).toBe(0);
    expect(lpReceivedAfterTransferFee(c, 11n, 10_000n)).toEqual({ schedule: c.olderTransferFee, fee: 50n, net: 9_950n });
    expect(lpReceivedAfterTransferFee(c, 12n, 10_000n)).toEqual({ schedule: c.newerTransferFee, fee: 300n, net: 9_700n });
    expect(lpReceivedAfterTransferFee(null, 12n, 10_000n)).toEqual({ schedule: null, fee: 0n, net: 10_000n });
    expect(lpTransferFeeAt(c, 0n)).toBe(c.olderTransferFee); expect(() => lpTransferFeeAt(c, -1)).toThrow(/negative/);
  });
  test("[P22] inverse: the smallest gross that nets at least `net`, round-tripped", () => {
    for (const bps of [1, 100, 999, 1_000]) for (const net of [1n, 7n, 9_900n, 123_456_789n]) {
      const s = schedule(bps);
      const gross = lpGrossForNet(s, net);
      expect(lpNetOfTransferFee(s, gross)).toBeGreaterThanOrEqual(net);
      expect(lpNetOfTransferFee(s, gross - 1n)).toBeLessThan(net);
    }
    expect(lpGrossForNet(schedule(0), 5n)).toBe(5n); expect(lpGrossForNet(null, 5n)).toBe(5n); expect(lpGrossForNet(schedule(100), 0n)).toBe(0n);
    expect(lpGrossForNet(schedule(1_000, 10n), 1_000n)).toBe(1_010n); // cap binds: gross = net + maximumFee
  });
  test("[P23] split favours the burn: floor on the protocol part; the edge shares", () => {
    expect(splitLpTransferFee(1_000n, 1_000)).toEqual({ protocol: 100n, burn: 900n });
    expect(splitLpTransferFee(1_001n, 1_000)).toEqual({ protocol: 100n, burn: 901n });
    expect(splitLpTransferFee(9n, 1_000)).toEqual({ protocol: 0n, burn: 9n }); // collected · share < 10_000
    expect(splitLpTransferFee(0n, 5_000)).toEqual({ protocol: 0n, burn: 0n });
    expect(splitLpTransferFee(123n, 0)).toEqual({ protocol: 0n, burn: 123n });
    expect(splitLpTransferFee(123n, 10_000)).toEqual({ protocol: 123n, burn: 0n });
    const max = (1n << 64n) - 1n;
    expect(splitLpTransferFee(max, 10_000)).toEqual({ protocol: max, burn: 0n });
    expect(splitLpTransferFee(max, 1)).toEqual({ protocol: max / 10_000n, burn: max - max / 10_000n });
    expect(() => splitLpTransferFee(1n, 10_001)).toThrow(/6113/); expect(() => splitLpTransferFee(-1n, 1)).toThrow(/u64/);
  });
  test("[P24] previewLpTransferFeeCollection (L-1 / X1 order): drip over the segment, settle, collected above owed + pending, split scheduled (amount-weighted end)", () => {
    const t0 = 1_700_000_000;
    // No stream yet: everything above `owed` is collected; the burn part gets a whole window from now, burnedNow = 0.
    expect(previewLpTransferFeeCollection({ feeAccountAmount: 1_000n, owedProtocol: 400n, pendingBurn: 0n, burnLastTs: 0, burnEndTs: 0, now: t0, shareBps: 2_500, withheld: 600n, lpSupply: 10_000n }))
      .toEqual({ collected: 1_200n, protocolPart: 300n, scheduledBurn: 900n, burnedNow: 0n, protocolOwedAfter: 700n, pendingBurnAfter: 900n, lpSupplyAfter: 10_000n, feeAccountAmountAfter: 1_600n, burnLastTsAfter: BigInt(t0), burnEndTsAfter: BigInt(t0 + 86_400) });
    // Half a window later: 450 of the 900 burn, last moves to now; a fresh 1_000 collection joins: D = (450·43200 + 750·86400) / 1200 = 70_200.
    const half = previewLpTransferFeeCollection({ feeAccountAmount: 1_600n + 1_000n, owedProtocol: 700n, pendingBurn: 900n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 + 43_200, shareBps: 2_500, lpSupply: 10_000n });
    expect(half).toEqual({ collected: 1_000n, protocolPart: 250n, scheduledBurn: 750n, burnedNow: 450n, protocolOwedAfter: 950n, pendingBurnAfter: 1_200n, lpSupplyAfter: 9_550n, feeAccountAmountAfter: 2_150n, burnLastTsAfter: BigInt(t0 + 43_200), burnEndTsAfter: BigInt(t0 + 113_400) });
    expect(half.feeAccountAmountAfter).toBe(half.protocolOwedAfter + half.pendingBurnAfter); // the fee-account invariant
    expect(half.burnEndTsAfter).toBe(BigInt(t0 + 86_400) + (750n * 43_200n) / 1_200n); // end += floor(A · (now + W − end) / (P + A))
    // Same slot (elapsed 0): nothing burns, nothing collected, the stream is untouched.
    expect(previewLpTransferFeeCollection({ feeAccountAmount: 2_150n, owedProtocol: 950n, pendingBurn: 1_200n, burnLastTs: t0 + 43_200, burnEndTs: t0 + 113_400, now: t0 + 43_200, shareBps: 2_500 }))
      .toMatchObject({ collected: 0n, protocolPart: 0n, scheduledBurn: 0n, burnedNow: 0n, pendingBurnAfter: 1_200n, feeAccountAmountAfter: 2_150n, burnLastTsAfter: BigInt(t0 + 43_200), burnEndTsAfter: BigInt(t0 + 113_400) });
    // One second before the end 1_199 burn; at the end everything, and the emptied stream collapses to now.
    expect(previewLpTransferFeeCollection({ feeAccountAmount: 2_150n, owedProtocol: 950n, pendingBurn: 1_200n, burnLastTs: t0 + 43_200, burnEndTs: t0 + 113_400, now: t0 + 113_399, shareBps: 2_500 }))
      .toMatchObject({ burnedNow: 1_199n, pendingBurnAfter: 1n, burnLastTsAfter: BigInt(t0 + 113_399), burnEndTsAfter: BigInt(t0 + 113_400) });
    expect(previewLpTransferFeeCollection({ feeAccountAmount: 2_150n, owedProtocol: 950n, pendingBurn: 1_200n, burnLastTs: t0 + 43_200, burnEndTs: t0 + 113_400, now: t0 + 113_400, shareBps: 2_500 }))
      .toMatchObject({ burnedNow: 1_200n, pendingBurnAfter: 0n, feeAccountAmountAfter: 950n, collected: 0n, burnLastTsAfter: BigInt(t0 + 113_400), burnEndTsAfter: BigInt(t0 + 113_400) });
    // A collection onto a stale sub-unit accrual carries it: P = 900 accrued 50 s + A = 900 ⇒ last = now − 25, end = now + W − 25 (vector 37).
    expect(previewLpTransferFeeCollection({ feeAccountAmount: 900n + 900n, owedProtocol: 0n, pendingBurn: 900n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 + 50, shareBps: 0 }))
      .toMatchObject({ burnedNow: 0n, scheduledBurn: 900n, pendingBurnAfter: 1_800n, burnLastTsAfter: BigInt(t0 + 25), burnEndTsAfter: BigInt(t0 + 50 + 86_375) });
    // Underfunded: below owed + pending after the drip, or below the drip itself.
    expect(() => previewLpTransferFeeCollection({ feeAccountAmount: 1_599n, owedProtocol: 700n, pendingBurn: 900n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0, shareBps: 2_500 })).toThrow(/LpFeeAccountUnderfunded/);
    expect(() => previewLpTransferFeeCollection({ feeAccountAmount: 100n, owedProtocol: 0n, pendingBurn: 900n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 + 86_400, shareBps: 2_500 })).toThrow(/LpFeeAccountUnderfunded/);
    expect(() => previewLpTransferFeeCollection({ feeAccountAmount: 1_600n, owedProtocol: 700n, pendingBurn: 900n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 + 86_400, shareBps: 2_500, lpSupply: 899n })).toThrow(/exceeds lpSupply/);
    expect(previewLpTransferFeeCollection({ feeAccountAmount: 400n, owedProtocol: 400n, pendingBurn: 0n, burnLastTs: 0, burnEndTs: 0, now: t0, shareBps: 2_500 }).lpSupplyAfter).toBeUndefined();
  });
  test("[P24b] lpTransferFeeDrip takes the segment (4-arg form): the slope is pending / (endTs − lastTs); a zeroed triple burns 0; (P, 0, 0) with P > 0 burns on the next collect", () => {
    const P = 1_000_000n, t0 = 1_700_000_000n;
    expect(lpTransferFeeDrip(P, t0, t0 + WINDOW, t0)).toBe(0n); // same slot
    expect(lpTransferFeeDrip(P, t0, t0 + WINDOW, t0 - 1n)).toBe(0n); // clock went backwards
    expect(lpTransferFeeDrip(P, t0, t0 + WINDOW, t0 + 1n)).toBe(11n); // floor(1e6 / 86_400)
    expect(lpTransferFeeDrip(P, t0, t0 + WINDOW, t0 + WINDOW / 2n)).toBe(P / 2n);
    expect(lpTransferFeeDrip(P, t0, t0 + WINDOW, t0 + WINDOW - 1n)).toBe(999_988n);
    expect(lpTransferFeeDrip(P, t0, t0 + WINDOW, t0 + WINDOW)).toBe(P);
    expect(lpTransferFeeDrip(P, t0, t0 + 2n * WINDOW, t0 + WINDOW)).toBe(P / 2n); // a re-based segment longer than a window
    expect(lpTransferFeeDrip(P, t0, t0 + 3_600n, t0 + 1_800n)).toBe(P / 2n); // and one shorter
    expect(lpTransferFeeDrip(0n, 0n, 0n, t0)).toBe(0n); // migrated / never collected
    expect(lpTransferFeeDrip(P, 0, 0, 1)).toBe(P); // pending with a zeroed segment: everything at any later clock
    expect(lpTransferFeeDrip(1n, t0, t0 + WINDOW, t0 + WINDOW - 1n)).toBe(0n); // floor: a single unit waits for the end
    // however often collect is called the stream completes exactly at its end (no exponential tail): 24 hourly collects on P burn P
    let pending = P, ts = t0, burned = 0n;
    for (let i = 0; i < 24; i++) { const d = lpTransferFeeDrip(pending, ts, t0 + WINDOW, ts + 3_600n); pending -= d; burned += d; if (d > 0n) ts += 3_600n; }
    expect(burned).toBe(P); expect(pending).toBe(0n);
  });
  test("[P24c] quoteLpTransferFeeBurnStream: effective pending burn / LP supply at time t over [lastTs, endTs]", () => {
    const t0 = 1_700_000_000;
    const q = quoteLpTransferFeeBurnStream({ pendingBurn: 9_000n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 + 28_800, lpSupply: 1_000_000n });
    expect(q).toEqual({ elapsedSecs: 28_800n, burnNow: 3_000n, pendingBurnAfter: 6_000n, lpSupplyAfter: 997_000n, releasedBps: 3_333, fullyReleasedAt: BigInt(t0 + 86_400), streamAfter: { pending: 6_000n, lastTs: BigInt(t0 + 28_800), endTs: BigInt(t0 + 86_400) } });
    expect(quoteLpTransferFeeBurnStream({ pendingBurn: 9_000n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 })).toEqual({ elapsedSecs: 0n, burnNow: 0n, pendingBurnAfter: 9_000n, releasedBps: 0, fullyReleasedAt: BigInt(t0 + 86_400), streamAfter: { pending: 9_000n, lastTs: BigInt(t0), endTs: BigInt(t0 + 86_400) } });
    expect(quoteLpTransferFeeBurnStream({ pendingBurn: 9_000n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 - 100 })).toMatchObject({ elapsedSecs: 0n, burnNow: 0n });
    // a floored-to-zero drip keeps lastTs (the accrual is not forfeited); a re-based end shorter than a window is honoured
    expect(quoteLpTransferFeeBurnStream({ pendingBurn: 9_000n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 + 9 }).streamAfter).toEqual({ pending: 9_000n, lastTs: BigInt(t0), endTs: BigInt(t0 + 86_400) });
    expect(quoteLpTransferFeeBurnStream({ pendingBurn: 9_000n, burnLastTs: t0, burnEndTs: t0 + 7_200, now: t0 + 3_600 })).toMatchObject({ burnNow: 4_500n, releasedBps: 5_000, fullyReleasedAt: BigInt(t0 + 7_200) });
    expect(quoteLpTransferFeeBurnStream({ pendingBurn: 9_000n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 + 2 * 86_400, lpSupply: 9_000n })).toMatchObject({ burnNow: 9_000n, pendingBurnAfter: 0n, lpSupplyAfter: 0n, releasedBps: 10_000, streamAfter: { pending: 0n, lastTs: BigInt(t0 + 2 * 86_400), endTs: BigInt(t0 + 2 * 86_400) } });
    expect(quoteLpTransferFeeBurnStream({ pendingBurn: 0n, burnLastTs: 0, burnEndTs: 0, now: t0 })).toEqual({ elapsedSecs: BigInt(t0), burnNow: 0n, pendingBurnAfter: 0n, releasedBps: 0, streamAfter: { pending: 0n, lastTs: BigInt(t0), endTs: BigInt(t0) } });
    expect(() => quoteLpTransferFeeBurnStream({ pendingBurn: 9_000n, burnLastTs: t0, burnEndTs: t0 + 86_400, now: t0 + 86_400, lpSupply: 8_999n })).toThrow(/exceeds lpSupply/);
    // snapshot-driven: the PoolInfo fields feed it directly (lpBurnStreamOf)
    const pool = feePool(100n, { lpSupply: 500_000n }, { pendingBurn: 4_000n, burnLastTs: t0 });
    const stream = lpBurnStreamOf(pool);
    expect(stream).toEqual({ pending: 4_000n, lastTs: BigInt(t0), endTs: BigInt(t0 + 86_400) });
    const fromPool = quoteLpTransferFeeBurnStream({ pendingBurn: stream.pending, burnLastTs: stream.lastTs, burnEndTs: stream.endTs, now: t0 + 21_600, lpSupply: BigInt(pool.lpTotalSupply.toString()) });
    expect(fromPool.burnNow).toBe(1_000n); expect(fromPool.lpSupplyAfter).toBe(499_000n);
  });
  test("[N04] validators mirror the program's bounds", () => {
    expect(validateLpTransferFeeBps(0)).toBe(0); expect(validateLpTransferFeeBps(1_000)).toBe(1_000);
    for (const bad of [1_001, -1, 0.5, NaN]) expect(() => validateLpTransferFeeBps(bad)).toThrow(/6111/);
    expect(validateLpTransferFeeProtocolShareBps(10_000)).toBe(10_000);
    for (const bad of [10_001, -1, 1.5]) expect(() => validateLpTransferFeeProtocolShareBps(bad)).toThrow(/6113/);
    expect(() => lpTransferFeeOf(schedule(10_001), 1n)).toThrow(/outside 0..=10_000/);
  });
});

// ── errors ──────────────────────────────────────────────────────────────────

describe("error map 6111–6115", () => {
  test("[P25] names, sdk codes and actionable messages; hex and decimal forms", () => {
    expect(describeProgramError(6111)).toMatchObject({ name: "LpTransferFeeMaxExceeded", sdkCode: "invalid_input" });
    expect(describeProgramError(6112)).toMatchObject({ name: "LpTransferFeeUnsupported", sdkCode: "unsupported_pool_state" });
    expect(describeProgramError(6113)).toMatchObject({ name: "LpTransferFeeProtocolShareMaxExceeded", sdkCode: "invalid_input" });
    expect(describeProgramError(6114)).toMatchObject({ name: "NoLpTransferFeesOwed", sdkCode: "unsupported_pool_state" });
    expect(describeProgramError(6115)).toMatchObject({ name: "LpFeeAccountUnderfunded", sdkCode: "unsupported_pool_state" });
    expect(describeProgramError(6120)).toBeUndefined(); // rc5 appended 6116–6119
    expect(describeProgramError(6111)!.message).toMatch(/10 %/); expect(describeProgramError(6112)!.message).toMatch(/no Token-2022 transfer fee extension/);
    expect(describeProgramError(6114)!.message).toMatch(/collect_lp_transfer_fees first/); expect(describeProgramError(6115)!.message).toMatch(/do not redeem/);
    expect(toSdkError(new Error("custom program error: 0x17e0")).code).toBe("unsupported_pool_state"); // 6112
    expect(toSdkError(new Error("Error Number: 6113")).humanMessage).toMatch(/100 %/);
    expect(toSdkError(new Error("custom program error: 0x17e3")).humanMessage).toMatch(/owed/); // 6115
    const idlMsgs = Object.fromEntries((poolIdl.errors as any[]).map((e) => [e.code, e.name]));
    expect([6111, 6112, 6113, 6114, 6115].map((c) => idlMsgs[c])).toEqual(["LpTransferFeeMaxExceeded", "LpTransferFeeUnsupported", "LpTransferFeeProtocolShareMaxExceeded", "NoLpTransferFeesOwed", "LpFeeAccountUnderfunded"]);
  });
});

// ── events ──────────────────────────────────────────────────────────────────

describe("events", () => {
  test("[P26] the four coffer_pool events are typed and decode from the IDL-generated fixtures", () => {
    for (const name of ["LpTransferFeeUpdated", "LpTransferFeeProtocolShareUpdated", "LpTransferFeesCollected", "LpTransferFeesRedeemed"]) {
      expect(TYPED_EVENT_NAMES).toContain(name);
      const f = (cofferFixtures.events as any[]).find((e) => e.name === name);
      expect(f).toBeDefined();
      const [e] = parseCofferPoolEvents([`Program data: ${f.base64}`]) as any[];
      expect(e.kind).toBe(name);
      expect(e.pool.toBase58()).toBe(f.value.pool); expect(e.timestamp).toBe(Number(f.value.timestamp));
      if (name !== "LpTransferFeesRedeemed") { expect(typeof e.oldBps === "number" || BN.isBN(e.collected)).toBe(true); }
    }
  });
  test("[P27] LpTransferFeesCollected (L-1 shape + X1 burn_end_ts tail) / LpTransferFeesRedeemed field-level decode and the collected = protocol + scheduled invariant", () => {
    const pool = key(1), mint = key(2), fee = key(3);
    expect(poolIdl.types.find((t: any) => t.name === "LpTransferFeesCollected").type.fields.map((f: any) => f.name))
      .toEqual(["pool", "lp_mint", "lp_fee_account", "collected", "protocol_part", "scheduled_burn", "burned_now", "protocol_owed_after", "pending_burn_after", "lp_supply_after", "timestamp", "burn_end_ts"]);
    const collected = parseCofferPoolEvents([eventLog(poolIdl, "LpTransferFeesCollected", {
      pool, lp_mint: mint, lp_fee_account: fee, collected: bn(1_000), protocol_part: bn(100), scheduled_burn: bn(900), burned_now: bn(450), protocol_owed_after: bn(350),
      pending_burn_after: bn(2_250), lp_supply_after: bn("5000000000"), timestamp: bn(1_700_000_000), burn_end_ts: bn(1_700_073_440),
    })])[0] as LpTransferFeesCollectedEvent;
    expect(collected.kind).toBe("LpTransferFeesCollected"); expect(collected.lpFeeAccount.equals(fee)).toBe(true);
    expect(collected.scheduledBurn.add(collected.protocolPart).eq(collected.collected)).toBe(true); expect(collected.protocolOwedAfter.toString()).toBe("350");
    expect(collected.burnedNow.toString()).toBe("450"); expect(collected.pendingBurnAfter.toString()).toBe("2250"); // 1_800 − 450 + 900
    expect((collected as any).burned).toBeUndefined();
    expect(collected.lpSupplyAfter.toString()).toBe("5000000000"); expect(collected.timestamp).toBe(1_700_000_000);
    expect(BN.isBN(collected.burnEndTs)).toBe(true); expect(collected.burnEndTs.toString()).toBe("1700073440");
    // the preview reproduces the event: pending 1_800 vesting over [t − 21_600, t + 64_800], 1_000 fresh, 10 % share ⇒ end = (1350·64800 + 900·86400) / 2250 = 73_440 s from now
    const preview = previewLpTransferFeeCollection({ feeAccountAmount: 250n + 1_800n + 1_000n, owedProtocol: 250n, pendingBurn: 1_800n, burnLastTs: 1_700_000_000 - 21_600, burnEndTs: 1_700_000_000 + 64_800, now: 1_700_000_000, shareBps: 1_000, lpSupply: 5_000_000_450n });
    expect([preview.collected, preview.protocolPart, preview.scheduledBurn, preview.burnedNow, preview.protocolOwedAfter, preview.pendingBurnAfter, preview.lpSupplyAfter, preview.burnEndTsAfter].map(String))
      .toEqual([collected.collected, collected.protocolPart, collected.scheduledBurn, collected.burnedNow, collected.protocolOwedAfter, collected.pendingBurnAfter, collected.lpSupplyAfter, collected.burnEndTs].map(String));
    // a negative end (the event is i64) round-trips
    expect((parseCofferPoolEvents([eventLog(poolIdl, "LpTransferFeesCollected", {
      pool, lp_mint: mint, lp_fee_account: fee, collected: bn(0), protocol_part: bn(0), scheduled_burn: bn(0), burned_now: bn(0), protocol_owed_after: bn(0),
      pending_burn_after: bn(0), lp_supply_after: bn(1), timestamp: bn(-7), burn_end_ts: bn(-7),
    })])[0] as LpTransferFeesCollectedEvent).burnEndTs.toString()).toBe("-7");
    const redeemed = parseCofferPoolEvents([eventLog(poolIdl, "LpTransferFeesRedeemed", {
      pool, authority: key(4), lp_burned: bn(350), token_amounts: [bn(10), bn(0)], surge_amounts: [bn(1), bn(0)], transfer_fees_out: [bn(0), bn(0)],
      recipients: [key(5), PublicKey.default], protocol_owed_after: bn(0), lp_supply_before: bn(5_000), lp_supply_after: bn(4_650), timestamp: bn(-5),
    })])[0] as LpTransferFeesRedeemedEvent;
    expect(redeemed.kind).toBe("LpTransferFeesRedeemed"); expect(redeemed.lpBurned.toString()).toBe("350");
    expect(redeemed.recipients[1].equals(PublicKey.default)).toBe(true); expect(redeemed.tokenAmounts.map(String)).toEqual(["10", "0"]);
    expect(redeemed.lpSupplyBefore.sub(redeemed.lpBurned).eq(redeemed.lpSupplyAfter)).toBe(true); expect(redeemed.timestamp).toBe(-5);
    const updated = parseCofferPoolEvents([eventLog(poolIdl, "LpTransferFeeUpdated", { pool, lp_mint: mint, authority: key(4), old_bps: 0, new_bps: 250, timestamp: bn(1) })])[0] as LpTransferFeeUpdatedEvent;
    expect(updated).toMatchObject({ kind: "LpTransferFeeUpdated", oldBps: 0, newBps: 250, timestamp: 1 });
    const share = parseCofferPoolEvents([eventLog(poolIdl, "LpTransferFeeProtocolShareUpdated", { pool, authority: key(4), old_bps: 1_000, new_bps: 2_500, timestamp: bn(2) })])[0] as LpTransferFeeProtocolShareUpdatedEvent;
    expect(share).toMatchObject({ kind: "LpTransferFeeProtocolShareUpdated", oldBps: 1_000, newBps: 2_500, timestamp: 2 });
    // strict: a truncated payload is Unknown, never a half value
    const line = eventLog(poolIdl, "LpTransferFeeUpdated", { pool, lp_mint: mint, authority: key(4), old_bps: 0, new_bps: 250, timestamp: bn(1) });
    const cut = Buffer.from(line.slice("Program data: ".length), "base64").subarray(0, 8 + 96 + 2);
    expect(decodeEventLine(cut.toString("base64")).event.kind).toBe("Unknown");
  });
  test("[P27b] initialize_pool emits PoolInitializedV2 THEN LpTransferFeeUpdated (I-2): the parser keeps log order, no SDK assumption inverts it", () => {
    const init = (cofferFixtures.events as any[]).find((e) => e.name === "PoolInitializedV2");
    const pool = new PublicKey(init.value.pool), mint = new PublicKey(init.value.lp_mint);
    const logs = [`Program data: ${init.base64}`, eventLog(poolIdl, "LpTransferFeeUpdated", { pool, lp_mint: mint, authority: key(4), old_bps: 0, new_bps: 250, timestamp: bn(1) })];
    const events = parseCofferPoolEvents(logs);
    expect(events.map((e) => e.kind)).toEqual(["PoolInitializedV2", "LpTransferFeeUpdated"]);
    expect((events[1] as LpTransferFeeUpdatedEvent).oldBps).toBe(0); expect((events[1] as LpTransferFeeUpdatedEvent).pool.equals(pool)).toBe(true);
    // reversed logs decode in reversed order too: the SDK takes the order from the log, never from the event kind
    expect(parseCofferPoolEvents([logs[1], logs[0]]).map((e) => e.kind)).toEqual(["LpTransferFeeUpdated", "PoolInitializedV2"]);
  });
  test("[P28] the two protocol_admin events decode through the generic (camelCase) path from the fixtures", () => {
    for (const name of ["PoolLpTransferFeeProtocolShareSet", "PoolLpTransferFeesRedeemed"]) {
      const f = (adminFixtures.events as any[]).find((e) => e.name === name);
      expect(f).toBeDefined();
      const { event, program } = decodeEventLine(f.base64);
      expect(program).toBe("protocolAdmin"); expect(event.kind).toBe(name);
      const e = event as any;
      expect(e.treasury.toBase58()).toBe(f.value.treasury); expect(e.admin.toBase58()).toBe(f.value.admin); expect(e.pool.toBase58()).toBe(f.value.pool);
      if (name === "PoolLpTransferFeeProtocolShareSet") { expect(e.oldBps).toBe(f.value.old_bps); expect(e.newBps).toBe(f.value.new_bps); }
      else expect(e.lpOwedBefore.toString()).toBe(f.value.lp_owed_before);
      expect(e.timestamp).toBe(Number(f.value.timestamp));
    }
  });
});

// ── LP mint / LP account ────────────────────────────────────────────────────

describe("LP mint TransferFeeConfig and LP account sizing", () => {
  const pool = key(11), mint = key(12);
  test("[P29] readLpTransferFeeConfig / fetchLpTransferFeeConfig read both schedules, the withheld amount and the pool authorities", async () => {
    const data = lpMintBytes(mint, pool, { older: [0, 18446744073709551615n, 0n], newer: [250, 18446744073709551615n, 3n], withheld: 77n });
    const c = readLpTransferFeeConfig(data)!;
    expect(c.transferFeeConfigAuthority.equals(pool) && c.withdrawWithheldAuthority.equals(pool)).toBe(true);
    expect(c.withheldAmount).toBe(77n); expect(c.olderTransferFee.transferFeeBasisPoints).toBe(0); expect(c.newerTransferFee).toEqual({ epoch: 3n, maximumFee: LP_TRANSFER_FEE_MAXIMUM, transferFeeBasisPoints: 250 });
    expect(scheduledLpTransferFeeBps(c)).toBe(250); expect(lpTransferFeeBpsAt(c, 2)).toBe(0); expect(lpTransferFeeBpsAt(c, 3)).toBe(250);
    expect(readLpTransferFeeConfig(lpMintBytes(mint, pool, null))).toBeNull();
    const reader = { getAccountInfo: async (k: PublicKey) => (k.equals(mint) ? { owner: TOKEN_2022_PROGRAM_ID, data, executable: false, lamports: 1 } : null) };
    const fetched = await fetchLpTransferFeeConfig(reader as any, mint);
    expect(fetched.config!.newerTransferFee.transferFeeBasisPoints).toBe(250); expect(fetched.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true); expect(fetched.supply).toBe(5_000_000_000n);
    await expect(fetchLpTransferFeeConfig(reader as any, key(99))).rejects.toThrow(/does not exist/);
    const legacyReader = { getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data: lpMintBytes(mint, pool, null, false).subarray(0, 82), executable: false, lamports: 1 }) };
    expect((await fetchLpTransferFeeConfig(legacyReader as any, mint)).config).toBeNull();
  });
  test("[P30] mint sizes: base 346 = getMintLen([MetadataPointer, TransferFeeConfig]); lpMintAccountSize grows by the 112-byte TLV", () => {
    expect(LP_MINT_BASE_SIZE).toBe(346); expect(LP_MINT_BASE_SIZE).toBe(getMintLen([ExtensionType.MetadataPointer, ExtensionType.TransferFeeConfig]));
    expect(LP_MINT_BASE_SIZE_PRE_FEE).toBe(234);
    expect(lpMintAccountSize(LP_METADATA_GOOD, pool) - lpMintAccountSize(LP_METADATA_GOOD, pool, false)).toBe(112);
    // the hand-built fee-bearing LP mint has exactly the size the formula predicts
    const built = lpMintBytes(mint, pool, { older: [0, 1n, 0n], newer: [0, 1n, 0n] });
    expect(built.length).toBe(lpMintAccountSize({ name: "LP", symbol: "LP", uri: "https://x" }, pool));
  });
  test("[P31] LP token account sizing: TransferFeeConfig ⇒ TransferFeeAmount (8 B); an ATA adds ImmutableOwner; getAccountLen semantics", () => {
    const feeMint = [ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata];
    expect(lpTokenAccountSize(feeMint)).toBe(182); expect(lpTokenAccountSize(feeMint, false)).toBe(178);
    expect(LP_TOKEN_ACCOUNT_SIZE_WITH_TRANSFER_FEE).toBe(182);
    expect(lpTokenAccountSize(feeMint)).toBe(getAccountLen([ExtensionType.TransferFeeAmount, ExtensionType.ImmutableOwner]));
    expect(lpTokenAccountSize([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata])).toBe(170); // pre-fee v6.1 LP ATA: ImmutableOwner only
    expect(lpTokenAccountSize([], false)).toBe(165); // legacy SPL LP mint
    expect(lpTokenAccountSize([ExtensionType.TransferFeeConfig, ExtensionType.TransferHook])).toBe(165 + 1 + 12 + 5 + 4);
    expect(lpTokenAccountSizeForMint(decodeMintAccount(lpMintBytes(mint, pool, { older: [0, 1n, 0n], newer: [0, 1n, 0n] })))).toBe(182);
    expect(lpTokenAccountSizeForMint(decodeMintAccount(lpMintBytes(mint, pool, null)))).toBe(170);
  });
  test("[P32] the zap LP-mint policy admits {MetadataPointer, TokenMetadata, TransferFeeConfig} and still rejects anything else", () => {
    const withFee = lpMintBytes(mint, pool, { older: [0, 1n, 0n], newer: [100, 1n, 0n] });
    expect(validatePlannedZapLpMint(mint, TOKEN_2022_PROGRAM_ID, withFee, pool).extensions).toEqual([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
    expect(validatePlannedZapLpMint(mint, TOKEN_2022_PROGRAM_ID, lpMintBytes(mint, pool, null), pool).extensions).toEqual([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
    // the fee extension never stands in for the metadata pair
    expect(() => validatePlannedZapLpMint(mint, TOKEN_2022_PROGRAM_ID, lpMintBytes(mint, pool, { older: [0, 1n, 0n], newer: [0, 1n, 0n] }, false), pool)).toThrow(/ZapTokenExtensionsUnsupported/);
    expect(() => validatePlannedZapLpMint(mint, TOKEN_2022_PROGRAM_ID, withFee, key(13))).toThrow(/InvalidLpMint/);
  });
  test("[P33] pool decode at the raw offsets (2124 / 2126 / 2134 / 2142 / 2160) feeds PoolInfo's share / owed / pending-burn / last-ts / end-ts fields", () => {
    const b = Buffer.alloc(POOL_LAYOUT.TOTAL); Buffer.from("89d22a16d19c2b4e", "hex").copy(b, 0); b[41] = 2; b[1683] = 1; Buffer.from("V5M1").copy(b, 1667);
    expect([POOL_LAYOUT.LP_TRANSFER_FEES_PENDING_BURN, POOL_LAYOUT.LP_TRANSFER_FEE_BURN_LAST_TS, POOL_LAYOUT.LP_TRANSFER_FEE_BURN_END_TS, POOL_LAYOUT.RESERVED_V61])
      .toEqual([{ offset: 2134, size: 8 }, { offset: 2142, size: 8 }, { offset: 2160, size: 8 }, { offset: 2168, size: 136 }]);
    b.writeUInt16LE(4_200, POOL_LAYOUT.LP_TRANSFER_FEE_PROTOCOL_SHARE_BPS.offset); b.writeBigUInt64LE(9_876_543_210n, POOL_LAYOUT.LP_TRANSFER_FEES_OWED_PROTOCOL.offset);
    b.writeBigUInt64LE(123_456n, 2134); b.writeBigInt64LE(1_700_000_000n, 2142); b.writeBigInt64LE(1_700_086_400n, 2160);
    const raw = decodePoolAccount(b);
    expect(raw.lpTransferFeeProtocolShareBps).toBe(4_200); expect(raw.lpTransferFeesOwedProtocol.toString()).toBe("9876543210"); expect(raw.layoutDrift).toEqual([]);
    expect(raw.lpTransferFeesPendingBurn.toString()).toBe("123456"); expect(raw.lpTransferFeeBurnLastTs.toString()).toBe("1700000000"); expect(raw.lpTransferFeeBurnEndTs.toString()).toBe("1700086400");
    expect(raw.reservedV61.length).toBe(136);
    expect(lpBurnStreamOf(raw)).toEqual({ pending: 123_456n, lastTs: 1_700_000_000n, endTs: 1_700_086_400n });
    // a full-width u64 pending burn and the reserve boundary right after the end ts (which sits after slot 11)
    b.writeBigUInt64LE((1n << 64n) - 1n, 2134); expect(decodePoolAccount(b).lpTransferFeesPendingBurn.toString()).toBe("18446744073709551615");
    b[2159] = 1; expect(decodePoolAccount(b).layoutDrift).toEqual([]); // last byte of slot 11's bps, not the reserve
    b[2160] = 1; expect(decodePoolAccount(b).layoutDrift).toEqual([]); // low byte of the end ts, not the reserve
    b[2167] = 0x7f; expect(decodePoolAccount(b).layoutDrift).toEqual([]); // top byte of the end ts (still non-negative)
    b[2168] = 1; expect(decodePoolAccount(b).layoutDrift).toContain("reserved_v61 is not all zero");
    const legacy = decodePoolAccount(b.subarray(0, 1683));
    expect(legacy.lpTransferFeesOwedProtocol.isZero() && legacy.lpTransferFeesPendingBurn.isZero() && legacy.lpTransferFeeBurnLastTs.isZero() && legacy.lpTransferFeeBurnEndTs.isZero()).toBe(true);
  });
});
