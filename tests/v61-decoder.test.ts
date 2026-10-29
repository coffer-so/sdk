/**
 * v6.1 (T4) pool / Treasury decoder tests.
 *
 * The offset table below is copied VERBATIM from the contracts' shared
 * validator-suite constants (`contracts/tests/utils/v61-layout.ts`, branch
 * v6.1 @ the T9 merge) and `scripts/cli/config.ts::POOL_LAYOUT`. Fixture
 * bytes are built by writing sentinels at THOSE offsets, then decoded with
 * the SDK, so a drift between the contracts and the SDK layout fails here.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType, getMintLen, LENGTH_SIZE, TYPE_SIZE } from "@solana/spl-token";
import { pack as packTokenMetadata } from "@solana/spl-token-metadata";
import BN from "bn.js";
import {
  decodePoolAccount, decodePoolCooldownBlock, isDecodablePoolLen, poolNeedsLayoutMigration,
  POOL_LEN, POOL_V4_LEN, POOL_V3_LEN, POOL_LEN_V5, POOL_LEN_V61, V5_MIGRATION_MARKER,
} from "../src/parsers/poolAccount";
import { decodeTreasuryAccount, decodeTreasuryCooldownBlock, treasuryNeedsLayoutMigration, TREASURY_DISCRIMINATOR } from "../src/parsers/treasuryAccount";
import {
  POOL_LAYOUT, TOKEN_SLOT_LAYOUT, TREASURY_LAYOUT, POOL_ACTION_KINDS, PROTOCOL_ACTION_KINDS, POOL_ACTION_KIND, PROTOCOL_ACTION_KIND,
  pendingStatus, GRACE_PERIOD_SECS, MAX_DELAY_SECS, TREASURY_LEN_V1, TREASURY_LEN_V2, TREASURY_LEN_V3,
} from "../src/parsers/layout";
import { decodeMintAccount, parseTokenMetadataExtension } from "../src/parsers/mintAccount";

// ── contracts/tests/utils/v61-layout.ts (verbatim) ──────────────────────────
const C = {
  POOL_LEN_V5: 1683, POOL_LEN_V61: 2304, LAYOUT_VERSION_OFFSET: 1683, TOKEN_DECIMALS_OFFSET: 1684, V61_CARVE_OFFSET: 1694,
  CREATOR_FEE_BPS_OFFSET: 1694, CREATOR_FEES_OWED_OFFSET: 1696, SURGE_FEES_OWED_OFFSET: 1776,
  DEPOSIT_FEE_BPS_OFFSET: 1856, WITHDRAW_FEE_BPS_OFFSET: 1858, LIQUIDITY_FEE_LOCK_OFFSET: 1860, RANGE_MANAGER_LOCKED_OFFSET: 1861,
  POOL_ADMIN_DELAY_SECS_OFFSET: 1862, POOL_ADMIN_EPOCH_OFFSET: 1866, PENDING_POOL_ADMIN_ETA_OFFSET: 1870,
  PENDING_SET_DELAY_OFFSET: 1878, PENDING_SET_SWAP_FEE_RATE_OFFSET: 1890, PENDING_SET_CREATOR_FEE_BPS_OFFSET: 1902,
  PENDING_SET_LIQUIDITY_FEES_OFFSET: 1912, PENDING_LOCK_LIQUIDITY_FEES_OFFSET: 1924, PENDING_LOCK_RANGE_MANAGER_OFFSET: 1932,
  PENDING_SET_RANGE_MANAGER_OFFSET: 1940, PENDING_SET_RANGE_MANAGER_CONFIG_OFFSET: 1981, PENDING_SET_MAX_SELLOFF_OFFSET: 2005,
  PENDING_SET_TOKEN_ACTIVE_OFFSET: 2045, COOLDOWN_BLOCK_LEN: 192,
  HOOK_PROGRAM_OFFSET: 2054, HOOK_FLAGS_OFFSET: 2086, HOOK_DISABLED_OFFSET: 2088, HOOK_FEE_MIN_OFFSET: 2089, HOOK_FEE_MAX_OFFSET: 2093,
  HOOK_MAX_CU_OFFSET: 2097, HOOK_ACCOUNTS_LEN_OFFSET: 2101, HOOK_BLOCK_LEN: 48, RESERVED_V61_OFFSET: 2102, RESERVED_V61_LEN: 202,
  TREASURY_LEN_V1: 786, TREASURY_LEN_V2: 818, TREASURY_LEN_V3: 1624,
  TREASURY_DELAY_SECS_OFFSET: 818, TREASURY_ADMIN_EPOCH_OFFSET: 822, TREASURY_PENDING_ADMIN_ETA_OFFSET: 826,
  TREASURY_PENDING_SET_DELAY_OFFSET: 834, TREASURY_PENDING_SET_SUPERVISOR_OFFSET: 846, TREASURY_PENDING_WITHDRAW_OFFSET: 886,
  TREASURY_PENDING_WITHDRAW_SOL_OFFSET: 966, TREASURY_PENDING_POOL_DEBUG_WITHDRAW_OFFSET: 1047,
  TREASURY_PENDING_POOL_SET_PROTOCOL_FEE_RATE_OFFSET: 1119, TREASURY_PENDING_POOL_SET_POOL_ENABLED_OFFSET: 1161,
  TREASURY_PENDING_POOL_SET_TOKEN_ACTIVE_OFFSET: 1201, TREASURY_PENDING_UNFREEZE_POOLS_OFFSET: 1242,
  TREASURY_PENDING_POOL_PROTOCOL_ADMIN_TRANSFER_OFFSET: 1282, TREASURY_PENDING_UPGRADE_PROGRAM_OFFSET: 1354,
  TREASURY_PENDING_PROGRAM_OP_OFFSET: 1426, TREASURY_PENDING_POOL_RESCALE_VIRTUAL_BALANCES_OFFSET: 1499, TREASURY_RESERVED_V61_OFFSET: 1547, TREASURY_RESERVED_V61_LEN: 77,
  MAX_DELAY_SECS: 30 * 86_400, GRACE_PERIOD_SECS: 14 * 86_400,
  POOL_ACTION_KIND: { TransferPoolAdmin: 0, SetDelay: 1, SetSwapFeeRate: 2, SetCreatorFeeBps: 3, SetLiquidityFees: 4, LockLiquidityFees: 5, LockRangeManager: 6, SetRangeManager: 7, SetRangeManagerConfig: 8, SetMaxSelloff: 9, SetTokenActive: 10 },
  PROTOCOL_ACTION_KIND: { TransferAdmin: 0, SetDelay: 1, SetSupervisor: 2, Withdraw: 3, WithdrawSol: 4, PoolDebugWithdraw: 5, PoolSetProtocolFeeRate: 6, PoolSetPoolEnabled: 7, PoolSetTokenActive: 8, UnfreezePools: 9, PoolProtocolAdminTransfer: 10, UpgradeProgram: 11, ProgramOp: 12, PoolRescaleVirtualBalances: 13 },
} as const;
const POOL_DISC = Buffer.from("89d22a16d19c2b4e", "hex");

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const bn = (v: string | number | bigint) => new BN(v.toString());

/** A sane 1683-byte legacy prefix with 3 tokens (sentinel values). */
function legacyPrefix(tokenCount = 3): Buffer {
  const b = Buffer.alloc(POOL_LEN_V5);
  POOL_DISC.copy(b, 0);
  key(2).toBuffer().copy(b, 8);
  b[40] = 254; b[41] = tokenCount;
  b.writeBigUInt64LE(123456789n, 42);
  b.writeUInt32LE(3000, 50); b.writeUInt16LE(1000, 54);
  b.writeBigInt64LE(1700000000n, 56);
  b[64] = 1; b[65] = 1;
  key(3).toBuffer().copy(b, 66); key(4).toBuffer().copy(b, 98);
  key(5).toBuffer().copy(b, 130); b[162] = 1; b.writeUInt16LE(500, 163); b.writeUInt16LE(600, 165); b.writeUInt32LE(60, 167); b.writeBigInt64LE(1699999999n, 171);
  for (let i = 0; i < tokenCount; i++) {
    const s = 179 + i * 144;
    key(10 + i).toBuffer().copy(b, s); (i % 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBuffer().copy(b, s + 32);
    b.writeBigUInt64LE(BigInt(3000 + i * 500), s + 64); b.writeUInt16LE(100 + i, s + 72); b.writeUInt32LE(3600, s + 74);
    b.writeUInt16LE(8000, s + 78); b.writeUInt16LE(10, s + 80); b.writeUInt16LE(900, s + 82); b[s + 84] = 1; b.writeUInt16LE(400, s + 85); b[s + 87] = 90;
    b.writeBigUInt64LE(1_000_000n * BigInt(i + 1), s + 88); b.writeBigUInt64LE(900_000n * BigInt(i + 1), s + 96); b.writeBigUInt64LE(BigInt(i), s + 104);
    b.writeBigUInt64LE(7n, s + 112); b.writeBigUInt64LE(8n, s + 120); b.writeBigInt64LE(1699990000n, s + 128); b.writeBigUInt64LE(9n, s + 136);
  }
  key(30).toBuffer().copy(b, 1619);
  b.writeBigUInt64LE(0xdeadbeefn, 1651);
  b.writeUInt32LE(20000, 1659); b.writeUInt32LE(5000, 1663);
  V5_MIGRATION_MARKER.copy(b, 1667);
  return b;
}

/** The legacy prefix grown to 2304 with sentinels in every v6.1 field at the CONTRACTS offsets. */
function v61Pool(tokenCount = 3): Buffer {
  const b = Buffer.alloc(POOL_LEN_V61);
  legacyPrefix(tokenCount).copy(b, 0);
  b[C.LAYOUT_VERSION_OFFSET] = 1;
  for (let i = 0; i < tokenCount; i++) b[C.TOKEN_DECIMALS_OFFSET + i] = 6 + i;
  b.writeUInt16LE(2500, C.CREATOR_FEE_BPS_OFFSET);
  for (let i = 0; i < tokenCount; i++) {
    b.writeBigUInt64LE(BigInt(1_000 + i), C.CREATOR_FEES_OWED_OFFSET + 8 * i);
    b.writeBigUInt64LE(BigInt(2_000 + i), C.SURGE_FEES_OWED_OFFSET + 8 * i);
  }
  b.writeUInt16LE(5, C.DEPOSIT_FEE_BPS_OFFSET); b.writeUInt16LE(7, C.WITHDRAW_FEE_BPS_OFFSET); b[C.LIQUIDITY_FEE_LOCK_OFFSET] = 1;
  b[C.RANGE_MANAGER_LOCKED_OFFSET] = 1;
  b.writeUInt32LE(86_400, C.POOL_ADMIN_DELAY_SECS_OFFSET); b.writeUInt32LE(3, C.POOL_ADMIN_EPOCH_OFFSET);
  b.writeBigInt64LE(1_700_000_000n, C.PENDING_POOL_ADMIN_ETA_OFFSET);
  b.writeBigInt64LE(1_700_000_001n, C.PENDING_SET_DELAY_OFFSET); b.writeUInt32LE(3600, C.PENDING_SET_DELAY_OFFSET + 8);
  b.writeBigInt64LE(1_700_000_002n, C.PENDING_SET_SWAP_FEE_RATE_OFFSET); b.writeUInt32LE(4000, C.PENDING_SET_SWAP_FEE_RATE_OFFSET + 8);
  b.writeBigInt64LE(1_700_000_003n, C.PENDING_SET_CREATOR_FEE_BPS_OFFSET); b.writeUInt16LE(1234, C.PENDING_SET_CREATOR_FEE_BPS_OFFSET + 8);
  b.writeBigInt64LE(1_700_000_004n, C.PENDING_SET_LIQUIDITY_FEES_OFFSET); b.writeUInt16LE(11, C.PENDING_SET_LIQUIDITY_FEES_OFFSET + 8); b.writeUInt16LE(22, C.PENDING_SET_LIQUIDITY_FEES_OFFSET + 10);
  b.writeBigInt64LE(1_700_000_005n, C.PENDING_LOCK_LIQUIDITY_FEES_OFFSET);
  b.writeBigInt64LE(1_700_000_006n, C.PENDING_LOCK_RANGE_MANAGER_OFFSET);
  b.writeBigInt64LE(1_700_000_007n, C.PENDING_SET_RANGE_MANAGER_OFFSET); key(40).toBuffer().copy(b, C.PENDING_SET_RANGE_MANAGER_OFFSET + 8); b[C.PENDING_SET_RANGE_MANAGER_OFFSET + 40] = 1;
  b.writeBigInt64LE(1_700_000_008n, C.PENDING_SET_RANGE_MANAGER_CONFIG_OFFSET);
  b.writeUInt16LE(501, C.PENDING_SET_RANGE_MANAGER_CONFIG_OFFSET + 8); b.writeUInt16LE(602, C.PENDING_SET_RANGE_MANAGER_CONFIG_OFFSET + 10);
  b.writeUInt32LE(61, C.PENDING_SET_RANGE_MANAGER_CONFIG_OFFSET + 12); b.writeUInt32LE(20001, C.PENDING_SET_RANGE_MANAGER_CONFIG_OFFSET + 16); b.writeUInt32LE(5001, C.PENDING_SET_RANGE_MANAGER_CONFIG_OFFSET + 20);
  b.writeBigInt64LE(1_700_000_009n, C.PENDING_SET_MAX_SELLOFF_OFFSET); Buffer.alloc(32, 0xab).copy(b, C.PENDING_SET_MAX_SELLOFF_OFFSET + 8);
  b.writeBigInt64LE(1_700_000_010n, C.PENDING_SET_TOKEN_ACTIVE_OFFSET); b[C.PENDING_SET_TOKEN_ACTIVE_OFFSET + 8] = 2;
  key(41).toBuffer().copy(b, C.HOOK_PROGRAM_OFFSET);
  b.writeUInt16LE(0b1110000, C.HOOK_FLAGS_OFFSET); b[C.HOOK_DISABLED_OFFSET] = 0;
  b.writeUInt32LE(100, C.HOOK_FEE_MIN_OFFSET); b.writeUInt32LE(50_000, C.HOOK_FEE_MAX_OFFSET); b.writeUInt32LE(60_000, C.HOOK_MAX_CU_OFFSET); b[C.HOOK_ACCOUNTS_LEN_OFFSET] = 4;
  return b;
}

function treasuryV2(): Buffer {
  const b = Buffer.alloc(TREASURY_LEN_V2);
  TREASURY_DISCRIMINATOR.copy(b, 0);
  key(50).toBuffer().copy(b, 8); key(51).toBuffer().copy(b, 40); b[72] = 253; b[73] = 2;
  key(60).toBuffer().copy(b, 74); key(61).toBuffer().copy(b, 106);
  key(70).toBuffer().copy(b, 394); key(71).toBuffer().copy(b, 426);
  b.writeBigInt64LE(1_650_000_000n, 714);
  key(52).toBuffer().copy(b, 786);
  return b;
}

function treasuryV3(): Buffer {
  const b = Buffer.alloc(TREASURY_LEN_V3);
  treasuryV2().copy(b, 0);
  b.writeUInt32LE(7200, C.TREASURY_DELAY_SECS_OFFSET); b.writeUInt32LE(5, C.TREASURY_ADMIN_EPOCH_OFFSET);
  b.writeBigInt64LE(1_800_000_000n, C.TREASURY_PENDING_ADMIN_ETA_OFFSET);
  b.writeBigInt64LE(1_800_000_001n, C.TREASURY_PENDING_SET_DELAY_OFFSET); b.writeUInt32LE(99, C.TREASURY_PENDING_SET_DELAY_OFFSET + 8);
  b.writeBigInt64LE(1_800_000_002n, C.TREASURY_PENDING_SET_SUPERVISOR_OFFSET); key(80).toBuffer().copy(b, C.TREASURY_PENDING_SET_SUPERVISOR_OFFSET + 8);
  b.writeBigInt64LE(1_800_000_003n, C.TREASURY_PENDING_WITHDRAW_OFFSET); key(81).toBuffer().copy(b, C.TREASURY_PENDING_WITHDRAW_OFFSET + 8); key(82).toBuffer().copy(b, C.TREASURY_PENDING_WITHDRAW_OFFSET + 40); b.writeBigUInt64LE(777n, C.TREASURY_PENDING_WITHDRAW_OFFSET + 72);
  b.writeBigInt64LE(1_800_000_004n, C.TREASURY_PENDING_WITHDRAW_SOL_OFFSET); b[C.TREASURY_PENDING_WITHDRAW_SOL_OFFSET + 8] = 2; key(83).toBuffer().copy(b, C.TREASURY_PENDING_WITHDRAW_SOL_OFFSET + 9); key(84).toBuffer().copy(b, C.TREASURY_PENDING_WITHDRAW_SOL_OFFSET + 41); b.writeBigUInt64LE(888n, C.TREASURY_PENDING_WITHDRAW_SOL_OFFSET + 73);
  b.writeBigInt64LE(1_800_000_005n, C.TREASURY_PENDING_POOL_DEBUG_WITHDRAW_OFFSET); key(85).toBuffer().copy(b, C.TREASURY_PENDING_POOL_DEBUG_WITHDRAW_OFFSET + 8); Buffer.alloc(32, 0xcd).copy(b, C.TREASURY_PENDING_POOL_DEBUG_WITHDRAW_OFFSET + 40);
  b.writeBigInt64LE(1_800_000_006n, C.TREASURY_PENDING_POOL_SET_PROTOCOL_FEE_RATE_OFFSET); key(86).toBuffer().copy(b, C.TREASURY_PENDING_POOL_SET_PROTOCOL_FEE_RATE_OFFSET + 8); b.writeUInt16LE(2000, C.TREASURY_PENDING_POOL_SET_PROTOCOL_FEE_RATE_OFFSET + 40);
  b.writeBigInt64LE(1_800_000_007n, C.TREASURY_PENDING_POOL_SET_POOL_ENABLED_OFFSET); key(87).toBuffer().copy(b, C.TREASURY_PENDING_POOL_SET_POOL_ENABLED_OFFSET + 8);
  b.writeBigInt64LE(1_800_000_008n, C.TREASURY_PENDING_POOL_SET_TOKEN_ACTIVE_OFFSET); key(88).toBuffer().copy(b, C.TREASURY_PENDING_POOL_SET_TOKEN_ACTIVE_OFFSET + 8); b[C.TREASURY_PENDING_POOL_SET_TOKEN_ACTIVE_OFFSET + 40] = 3;
  b.writeBigInt64LE(1_800_000_009n, C.TREASURY_PENDING_UNFREEZE_POOLS_OFFSET); Buffer.alloc(32, 0xef).copy(b, C.TREASURY_PENDING_UNFREEZE_POOLS_OFFSET + 8);
  b.writeBigInt64LE(1_800_000_010n, C.TREASURY_PENDING_POOL_PROTOCOL_ADMIN_TRANSFER_OFFSET); key(89).toBuffer().copy(b, C.TREASURY_PENDING_POOL_PROTOCOL_ADMIN_TRANSFER_OFFSET + 8); key(90).toBuffer().copy(b, C.TREASURY_PENDING_POOL_PROTOCOL_ADMIN_TRANSFER_OFFSET + 40);
  b.writeBigInt64LE(1_800_000_011n, C.TREASURY_PENDING_UPGRADE_PROGRAM_OFFSET); key(91).toBuffer().copy(b, C.TREASURY_PENDING_UPGRADE_PROGRAM_OFFSET + 8); key(92).toBuffer().copy(b, C.TREASURY_PENDING_UPGRADE_PROGRAM_OFFSET + 40);
  b.writeBigInt64LE(1_800_000_012n, C.TREASURY_PENDING_PROGRAM_OP_OFFSET); b[C.TREASURY_PENDING_PROGRAM_OP_OFFSET + 8] = 1; key(93).toBuffer().copy(b, C.TREASURY_PENDING_PROGRAM_OP_OFFSET + 9); key(94).toBuffer().copy(b, C.TREASURY_PENDING_PROGRAM_OP_OFFSET + 41);
  // v6.1 (T22) kind 13
  b.writeBigInt64LE(1_800_000_013n, C.TREASURY_PENDING_POOL_RESCALE_VIRTUAL_BALANCES_OFFSET); key(95).toBuffer().copy(b, C.TREASURY_PENDING_POOL_RESCALE_VIRTUAL_BALANCES_OFFSET + 8); b.writeBigUInt64LE(1_000_000_000n, C.TREASURY_PENDING_POOL_RESCALE_VIRTUAL_BALANCES_OFFSET + 40);
  return b;
}

// ── positive ────────────────────────────────────────────────────────────────

describe("v6.1 layout constants agree with the contracts' v61-layout.ts", () => {
  test("[P01] pool sizes and the appended-block offsets", () => {
    expect(POOL_LEN).toBe(C.POOL_LEN_V61); expect(POOL_LEN_V61).toBe(2304); expect(POOL_V4_LEN).toBe(C.POOL_LEN_V5); expect(POOL_LEN_V5).toBe(1683); expect(POOL_V3_LEN).toBe(1154);
    const L = POOL_LAYOUT;
    expect([L.LAYOUT_VERSION.offset, L.TOKEN_DECIMALS.offset, L.CREATOR_FEE_BPS.offset, L.CREATOR_FEES_OWED.offset, L.SURGE_FEES_OWED.offset,
      L.DEPOSIT_FEE_BPS.offset, L.WITHDRAW_FEE_BPS.offset, L.LIQUIDITY_FEE_LOCK.offset, L.RANGE_MANAGER_LOCKED.offset]).toEqual(
      [C.LAYOUT_VERSION_OFFSET, C.TOKEN_DECIMALS_OFFSET, C.CREATOR_FEE_BPS_OFFSET, C.CREATOR_FEES_OWED_OFFSET, C.SURGE_FEES_OWED_OFFSET,
        C.DEPOSIT_FEE_BPS_OFFSET, C.WITHDRAW_FEE_BPS_OFFSET, C.LIQUIDITY_FEE_LOCK_OFFSET, C.RANGE_MANAGER_LOCKED_OFFSET]);
  });
  test("[P02] T3 cooldown block offsets and length", () => {
    const L = POOL_LAYOUT;
    expect([L.POOL_ADMIN_DELAY_SECS.offset, L.POOL_ADMIN_EPOCH.offset, L.PENDING_POOL_ADMIN_ETA.offset, L.PENDING_SET_DELAY.offset, L.PENDING_SET_SWAP_FEE_RATE.offset,
      L.PENDING_SET_CREATOR_FEE_BPS.offset, L.PENDING_SET_LIQUIDITY_FEES.offset, L.PENDING_LOCK_LIQUIDITY_FEES.offset, L.PENDING_LOCK_RANGE_MANAGER.offset,
      L.PENDING_SET_RANGE_MANAGER.offset, L.PENDING_SET_RANGE_MANAGER_CONFIG.offset, L.PENDING_SET_MAX_SELLOFF.offset, L.PENDING_SET_TOKEN_ACTIVE.offset]).toEqual(
      [C.POOL_ADMIN_DELAY_SECS_OFFSET, C.POOL_ADMIN_EPOCH_OFFSET, C.PENDING_POOL_ADMIN_ETA_OFFSET, C.PENDING_SET_DELAY_OFFSET, C.PENDING_SET_SWAP_FEE_RATE_OFFSET,
        C.PENDING_SET_CREATOR_FEE_BPS_OFFSET, C.PENDING_SET_LIQUIDITY_FEES_OFFSET, C.PENDING_LOCK_LIQUIDITY_FEES_OFFSET, C.PENDING_LOCK_RANGE_MANAGER_OFFSET,
        C.PENDING_SET_RANGE_MANAGER_OFFSET, C.PENDING_SET_RANGE_MANAGER_CONFIG_OFFSET, C.PENDING_SET_MAX_SELLOFF_OFFSET, C.PENDING_SET_TOKEN_ACTIVE_OFFSET]);
    expect(L.HOOK_PROGRAM.offset - L.POOL_ADMIN_DELAY_SECS.offset).toBe(C.COOLDOWN_BLOCK_LEN);
  });
  test("[P03] T9 hook block offsets, reserve and Treasury v3 block", () => {
    const L = POOL_LAYOUT;
    expect([L.HOOK_PROGRAM.offset, L.HOOK_FLAGS.offset, L.HOOK_DISABLED.offset, L.HOOK_FEE_MIN.offset, L.HOOK_FEE_MAX.offset, L.HOOK_MAX_CU.offset, L.HOOK_ACCOUNTS_LEN.offset, L.RESERVED_V61.offset, L.RESERVED_V61.size])
      .toEqual([C.HOOK_PROGRAM_OFFSET, C.HOOK_FLAGS_OFFSET, C.HOOK_DISABLED_OFFSET, C.HOOK_FEE_MIN_OFFSET, C.HOOK_FEE_MAX_OFFSET, C.HOOK_MAX_CU_OFFSET, C.HOOK_ACCOUNTS_LEN_OFFSET, C.RESERVED_V61_OFFSET, C.RESERVED_V61_LEN]);
    expect(L.RESERVED_V61.offset - L.HOOK_PROGRAM.offset).toBe(C.HOOK_BLOCK_LEN);
    const T = TREASURY_LAYOUT;
    expect([TREASURY_LEN_V1, TREASURY_LEN_V2, TREASURY_LEN_V3]).toEqual([C.TREASURY_LEN_V1, C.TREASURY_LEN_V2, C.TREASURY_LEN_V3]);
    expect([T.DELAY_SECS.offset, T.ADMIN_EPOCH.offset, T.PENDING_ADMIN_ETA.offset, T.PENDING_SET_DELAY.offset, T.PENDING_SET_SUPERVISOR.offset, T.PENDING_WITHDRAW.offset,
      T.PENDING_WITHDRAW_SOL.offset, T.PENDING_POOL_DEBUG_WITHDRAW.offset, T.PENDING_POOL_SET_PROTOCOL_FEE_RATE.offset, T.PENDING_POOL_SET_POOL_ENABLED.offset,
      T.PENDING_POOL_SET_TOKEN_ACTIVE.offset, T.PENDING_UNFREEZE_POOLS.offset, T.PENDING_POOL_PROTOCOL_ADMIN_TRANSFER.offset, T.PENDING_UPGRADE_PROGRAM.offset,
      T.PENDING_PROGRAM_OP.offset, T.PENDING_POOL_RESCALE_VIRTUAL_BALANCES.offset, T.RESERVED_V61.offset, T.RESERVED_V61.size]).toEqual([
      C.TREASURY_DELAY_SECS_OFFSET, C.TREASURY_ADMIN_EPOCH_OFFSET, C.TREASURY_PENDING_ADMIN_ETA_OFFSET, C.TREASURY_PENDING_SET_DELAY_OFFSET, C.TREASURY_PENDING_SET_SUPERVISOR_OFFSET,
      C.TREASURY_PENDING_WITHDRAW_OFFSET, C.TREASURY_PENDING_WITHDRAW_SOL_OFFSET, C.TREASURY_PENDING_POOL_DEBUG_WITHDRAW_OFFSET, C.TREASURY_PENDING_POOL_SET_PROTOCOL_FEE_RATE_OFFSET,
      C.TREASURY_PENDING_POOL_SET_POOL_ENABLED_OFFSET, C.TREASURY_PENDING_POOL_SET_TOKEN_ACTIVE_OFFSET, C.TREASURY_PENDING_UNFREEZE_POOLS_OFFSET,
      C.TREASURY_PENDING_POOL_PROTOCOL_ADMIN_TRANSFER_OFFSET, C.TREASURY_PENDING_UPGRADE_PROGRAM_OFFSET, C.TREASURY_PENDING_PROGRAM_OP_OFFSET,
      C.TREASURY_PENDING_POOL_RESCALE_VIRTUAL_BALANCES_OFFSET, C.TREASURY_RESERVED_V61_OFFSET, C.TREASURY_RESERVED_V61_LEN]);
  });
  test("[P04] the pool layout is contiguous from the legacy block to the account end", () => {
    const L = POOL_LAYOUT as any;
    const order = ["RESERVED", "LAYOUT_VERSION", "TOKEN_DECIMALS", "CREATOR_FEE_BPS", "CREATOR_FEES_OWED", "SURGE_FEES_OWED", "DEPOSIT_FEE_BPS", "WITHDRAW_FEE_BPS",
      "LIQUIDITY_FEE_LOCK", "RANGE_MANAGER_LOCKED", "POOL_ADMIN_DELAY_SECS", "POOL_ADMIN_EPOCH", "PENDING_POOL_ADMIN_ETA", "PENDING_SET_DELAY", "PENDING_SET_SWAP_FEE_RATE",
      "PENDING_SET_CREATOR_FEE_BPS", "PENDING_SET_LIQUIDITY_FEES", "PENDING_LOCK_LIQUIDITY_FEES", "PENDING_LOCK_RANGE_MANAGER", "PENDING_SET_RANGE_MANAGER",
      "PENDING_SET_RANGE_MANAGER_CONFIG", "PENDING_SET_MAX_SELLOFF", "PENDING_SET_TOKEN_ACTIVE", "HOOK_PROGRAM", "HOOK_FLAGS", "HOOK_DISABLED", "HOOK_FEE_MIN",
      "HOOK_FEE_MAX", "HOOK_MAX_CU", "HOOK_ACCOUNTS_LEN", "RESERVED_V61"];
    for (let i = 1; i < order.length; i++) expect(L[order[i - 1]].offset + L[order[i - 1]].size).toBe(L[order[i]].offset);
    expect(L.RESERVED.offset + L.RESERVED.size).toBe(1683);
    expect(L.RESERVED_V61.offset + L.RESERVED_V61.size).toBe(2304);
    expect(L.TOKENS.offset + 10 * TOKEN_SLOT_LAYOUT.TOTAL).toBe(L.LOOKUP_TABLE.offset);
    const T = TREASURY_LAYOUT as any;
    const torder = ["SUPERVISOR", "DELAY_SECS", "ADMIN_EPOCH", "PENDING_ADMIN_ETA", "PENDING_SET_DELAY", "PENDING_SET_SUPERVISOR", "PENDING_WITHDRAW", "PENDING_WITHDRAW_SOL",
      "PENDING_POOL_DEBUG_WITHDRAW", "PENDING_POOL_SET_PROTOCOL_FEE_RATE", "PENDING_POOL_SET_POOL_ENABLED", "PENDING_POOL_SET_TOKEN_ACTIVE", "PENDING_UNFREEZE_POOLS",
      "PENDING_POOL_PROTOCOL_ADMIN_TRANSFER", "PENDING_UPGRADE_PROGRAM", "PENDING_PROGRAM_OP", "PENDING_POOL_RESCALE_VIRTUAL_BALANCES", "RESERVED_V61"];
    for (let i = 1; i < torder.length; i++) expect(T[torder[i - 1]].offset + T[torder[i - 1]].size).toBe(T[torder[i]].offset);
    expect(T.RESERVED_V61.offset + T.RESERVED_V61.size).toBe(1624);
  });
  test("[P05] kind tables and cooldown constants", () => {
    expect(POOL_ACTION_KIND).toEqual(C.POOL_ACTION_KIND); expect(PROTOCOL_ACTION_KIND).toEqual(C.PROTOCOL_ACTION_KIND);
    expect(POOL_ACTION_KINDS).toHaveLength(11); expect(PROTOCOL_ACTION_KINDS).toHaveLength(14);
    expect(MAX_DELAY_SECS).toBe(C.MAX_DELAY_SECS); expect(GRACE_PERIOD_SECS).toBe(C.GRACE_PERIOD_SECS);
  });
});

describe("decodePoolAccount on a 2304-byte v6.1 account", () => {
  const raw = decodePoolAccount(v61Pool());
  test("[P06] legacy prefix fields are unchanged", () => {
    expect(raw.dataLen).toBe(2304); expect(raw.tokenCount).toBe(3); expect(raw.poolId.toString()).toBe("123456789"); expect(raw.swapFeeRate).toBe(3000);
    expect(raw.protocolFeeRate).toBe(1000); expect(raw.poolAdmin.equals(key(3))).toBe(true); expect(raw.lookupTable.equals(key(30))).toBe(true);
    expect(raw.deprecatedBannedExtensions.toString()).toBe(String(0xdeadbeef)); expect(raw.rangeManagerMaxLeverageBps).toBe(20000); expect(raw.rangeManagerMinLeverageBps).toBe(5000);
    expect(raw.v5Migrated).toBe(true); expect(raw.tokenMints[1].equals(key(11))).toBe(true); expect(raw.tokenPrograms[1].equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(raw.actualBalances[2].toString()).toBe("2700000"); expect(raw.variableFeeKinkPct[0]).toBe(90);
  });
  test("[P07] L0 block: layout_version and the decimals pins", () => {
    expect(raw.layoutVersion).toBe(1); expect(raw.tokenDecimals).toEqual([6, 7, 8, 0, 0, 0, 0, 0, 0, 0]); expect(raw.layoutDrift).toEqual([]);
  });
  test("[P08] T14 creator fee block", () => {
    expect(raw.creatorFeeBps).toBe(2500);
    expect(raw.creatorFeesOwed.map(String)).toEqual(["1000", "1001", "1002", "0", "0", "0", "0", "0", "0", "0"]);
  });
  test("[P09] T12 surge bucket", () => {
    expect(raw.surgeFeesOwed.map(String)).toEqual(["2000", "2001", "2002", "0", "0", "0", "0", "0", "0", "0"]);
  });
  test("[P10] T7 liquidity fees and lock, T6 range-manager lock", () => {
    expect(raw.depositFeeBps).toBe(5); expect(raw.withdrawFeeBps).toBe(7); expect(raw.liquidityFeeLock).toBe(1); expect(raw.rangeManagerLocked).toBe(true);
  });
  test("[P11] T3 delay, epoch, transfer eta", () => {
    expect(raw.poolAdminDelaySecs).toBe(86_400); expect(raw.poolAdminEpoch).toBe(3); expect(raw.pendingPoolAdminEta.toString()).toBe("1700000000");
    expect(raw.pendingActions[0]).toMatchObject({ kind: 0, name: "TransferPoolAdmin" });
    expect((raw.pendingActions[0].payload.newAdmin as PublicKey).equals(key(4))).toBe(true);
  });
  test("[P12] T3 typed slots 1..10 with their payloads at the contracts offsets", () => {
    const p = raw.pendingActions;
    expect(p.map((s) => s.eta.toString())).toEqual(Array.from({ length: 11 }, (_, i) => String(1_700_000_000 + i)));
    expect(p.map((s) => s.name)).toEqual([...POOL_ACTION_KINDS]);
    expect(p[1].payload).toEqual({ secs: 3600 }); expect(p[2].payload).toEqual({ rate: 4000 }); expect(p[3].payload).toEqual({ bps: 1234 });
    expect(p[4].payload).toEqual({ depositFeeBps: 11, withdrawFeeBps: 22 }); expect(p[5].payload).toEqual({}); expect(p[6].payload).toEqual({});
    expect((p[7].payload.manager as PublicKey).equals(key(40))).toBe(true); expect(p[7].payload.enabled).toBe(true);
    expect(p[8].payload).toEqual({ maxVbChangePct: 501, maxWeightChangePct: 602, minUpdateIntervalSecs: 61, maxLeverageBps: 20001, minLeverageBps: 5001 });
    expect(p[9].payload).toEqual({ paramsHash: "ab".repeat(32) }); expect(p[10].payload).toEqual({ tokenIndex: 2 });
    expect(raw.pendingActionsMask).toBe(0b11111111111);
  });
  test("[P13] T9 hook block", () => {
    expect(raw.hookProgram.equals(key(41))).toBe(true); expect(raw.hookFlags).toBe(0b1110000); expect(raw.hookDisabled).toBe(0);
    expect(raw.hookFeeMin).toBe(100); expect(raw.hookFeeMax).toBe(50_000); expect(raw.hookMaxCu).toBe(60_000); expect(raw.hookAccountsLen).toBe(4);
    expect(raw.reservedV61.length).toBe(202); expect(raw.reservedV61.every((b) => b === 0)).toBe(true);
  });
  test("[P14] an empty cooldown block decodes as nothing pending", () => {
    const b = v61Pool(); b.fill(0, C.POOL_ADMIN_DELAY_SECS_OFFSET, C.HOOK_PROGRAM_OFFSET);
    const r = decodePoolAccount(b);
    expect(r.poolAdminDelaySecs).toBe(0); expect(r.pendingActionsMask).toBe(0); expect(r.pendingActions.every((s) => s.eta.isZero())).toBe(true);
    expect(decodePoolCooldownBlock(b).pendingActionsMask).toBe(0);
  });
  test("[P15] a pool without a hook decodes the default program and zero block", () => {
    const b = v61Pool(); b.fill(0, C.HOOK_PROGRAM_OFFSET, C.RESERVED_V61_OFFSET);
    const r = decodePoolAccount(b);
    expect(r.hookProgram.equals(PublicKey.default)).toBe(true); expect(r.hookAccountsLen).toBe(0); expect(r.layoutDrift).toEqual([]);
  });
  test("[P16] a disabled hook keeps its config", () => {
    const b = v61Pool(); b[C.HOOK_DISABLED_OFFSET] = 1;
    const r = decodePoolAccount(b);
    expect(r.hookDisabled).toBe(1); expect(r.hookProgram.equals(key(41))).toBe(true); expect(r.layoutDrift).toEqual([]);
  });
  test("[P17] ten-token pool: every per-slot v6.1 array is read in slot order", () => {
    const b = v61Pool(10);
    for (let i = 0; i < 10; i++) { b[C.TOKEN_DECIMALS_OFFSET + i] = 9; b.writeBigUInt64LE(BigInt(10 + i), C.CREATOR_FEES_OWED_OFFSET + 8 * i); b.writeBigUInt64LE(BigInt(20 + i), C.SURGE_FEES_OWED_OFFSET + 8 * i); }
    const r = decodePoolAccount(b);
    expect(r.tokenDecimals).toEqual(Array(10).fill(9));
    expect(r.creatorFeesOwed.map(Number)).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
    expect(r.surgeFeesOwed.map(Number)).toEqual(Array.from({ length: 10 }, (_, i) => 20 + i));
    expect(r.layoutDrift).toEqual([]);
  });
  test("[P18] negative etas (i64) decode signed", () => {
    const b = v61Pool(); b.writeBigInt64LE(-7n, C.PENDING_SET_DELAY_OFFSET);
    expect(decodePoolAccount(b).pendingActions[1].eta.toString()).toBe("-7");
  });
  test("[P19] size predicates", () => {
    expect(isDecodablePoolLen(1683)).toBe(true); expect(isDecodablePoolLen(2304)).toBe(true);
    expect(poolNeedsLayoutMigration(legacyPrefix())).toBe(true); expect(poolNeedsLayoutMigration(v61Pool())).toBe(false);
  });
  test("[P20] the returned reserve is a copy", () => {
    const b = v61Pool(); const r = decodePoolAccount(b); r.reservedV61[0] = 9; expect(b[C.RESERVED_V61_OFFSET]).toBe(0);
  });
});

describe("decodePoolAccount on an unmigrated 1683-byte account (read-only)", () => {
  const raw = decodePoolAccount(legacyPrefix());
  test("[P21] prefix fields decode and every v6.1 field is its default", () => {
    expect(raw.dataLen).toBe(1683); expect(raw.layoutVersion).toBe(0); expect(raw.tokenCount).toBe(3); expect(raw.v5Migrated).toBe(true);
    expect(raw.tokenDecimals).toEqual(Array(10).fill(0)); expect(raw.creatorFeeBps).toBe(0); expect(raw.depositFeeBps).toBe(0); expect(raw.withdrawFeeBps).toBe(0);
    expect(raw.liquidityFeeLock).toBe(0); expect(raw.rangeManagerLocked).toBe(false); expect(raw.poolAdminDelaySecs).toBe(0); expect(raw.poolAdminEpoch).toBe(0);
    expect(raw.pendingPoolAdminEta.isZero()).toBe(true); expect(raw.pendingActions).toEqual([]); expect(raw.pendingActionsMask).toBe(0);
    expect(raw.hookProgram.equals(PublicKey.default)).toBe(true); expect(raw.hookFlags).toBe(0); expect(raw.hookAccountsLen).toBe(0);
    expect(raw.creatorFeesOwed.every((x) => x.isZero())).toBe(true); expect(raw.surgeFeesOwed.every((x) => x.isZero())).toBe(true);
    expect(raw.reservedV61.length).toBe(0); expect(raw.layoutDrift).toEqual([]);
  });
  test("[P22] an unmarked (pre-migrate_to_v5) legacy pool still decodes", () => {
    const b = legacyPrefix(); b.fill(0, 1667, 1683);
    expect(decodePoolAccount(b).v5Migrated).toBe(false);
  });
  test("[P23] the 1683-byte prefix of a v6.1 account decodes identically to the same bytes before migration", () => {
    const grown = v61Pool(); const prefix = decodePoolAccount(grown.subarray(0, 1683)); const full = decodePoolAccount(grown);
    for (const k of ["config", "poolId", "swapFeeRate", "protocolFeeRate", "poolAdmin", "lookupTable", "tokenMints", "actualBalances", "reserved"] as const) {
      expect(JSON.stringify((prefix as any)[k])).toBe(JSON.stringify((full as any)[k]));
    }
  });
});

describe("decodeTreasuryAccount", () => {
  test("[P24] v2 (818) reads the supervisor and no cooldown", () => {
    const t = decodeTreasuryAccount(treasuryV2());
    expect(t.layout).toBe("v2"); expect(t.admin.equals(key(50))).toBe(true); expect(t.supervisor!.equals(key(52))).toBe(true); expect(t.tokenCount).toBe(2);
    expect(t.tokenMints[1].equals(key(61))).toBe(true); expect(t.tokenVaults[0].equals(key(70))).toBe(true); expect(t.createdAt.toString()).toBe("1650000000");
    expect(t.delaySecs).toBe(0); expect(t.pendingActions).toEqual([]); expect(t.pendingActionsMask).toBe(0);
    expect(treasuryNeedsLayoutMigration(treasuryV2())).toBe(true);
  });
  test("[P25] v1 (786) has no supervisor", () => {
    const t = decodeTreasuryAccount(treasuryV2().subarray(0, 786));
    expect(t.layout).toBe("v1"); expect(t.supervisor).toBeNull(); expect(t.delaySecs).toBe(0);
  });
  test("[P26] v3 (1624) decodes delay, epoch, transfer eta and all thirteen typed slots (incl. T22 kind 13) at the contracts offsets", () => {
    const t = decodeTreasuryAccount(treasuryV3());
    expect(t.layout).toBe("v3"); expect(treasuryNeedsLayoutMigration(treasuryV3())).toBe(false);
    expect(t.delaySecs).toBe(7200); expect(t.adminEpoch).toBe(5); expect(t.pendingAdminEta.toString()).toBe("1800000000");
    const p = t.pendingActions;
    expect(p.map((s) => s.name)).toEqual([...PROTOCOL_ACTION_KINDS]);
    expect(p.map((s) => s.eta.toString())).toEqual(Array.from({ length: 14 }, (_, i) => String(1_800_000_000 + i)));
    expect((p[13].payload.pool as PublicKey).equals(key(95))).toBe(true); expect(p[13].payload.multiplier!.toString()).toBe("1000000000"); expect(p[13].name).toBe("PoolRescaleVirtualBalances");
    expect((p[0].payload.newAdmin as PublicKey).equals(key(51))).toBe(true);
    expect(p[1].payload).toEqual({ secs: 99 }); expect((p[2].payload.key as PublicKey).equals(key(80))).toBe(true);
    expect((p[3].payload.mint as PublicKey).equals(key(81))).toBe(true); expect((p[3].payload.recipient as PublicKey).equals(key(82))).toBe(true); expect(p[3].payload.amount!.toString()).toBe("777");
    expect(p[4].payload.route).toBe(2); expect((p[4].payload.source as PublicKey).equals(key(83))).toBe(true); expect(p[4].payload.amount!.toString()).toBe("888");
    expect((p[5].payload.pool as PublicKey).equals(key(85))).toBe(true); expect(p[5].payload.paramsHash).toBe("cd".repeat(32));
    expect((p[6].payload.pool as PublicKey).equals(key(86))).toBe(true); expect(p[6].payload.rate).toBe(2000);
    expect((p[7].payload.pool as PublicKey).equals(key(87))).toBe(true);
    expect((p[8].payload.pool as PublicKey).equals(key(88))).toBe(true); expect(p[8].payload.tokenIndex).toBe(3);
    expect(p[9].payload.poolsHash).toBe("ef".repeat(32));
    expect((p[10].payload.config as PublicKey).equals(key(89))).toBe(true); expect((p[10].payload.newAdmin as PublicKey).equals(key(90))).toBe(true);
    expect((p[11].payload.program as PublicKey).equals(key(91))).toBe(true); expect((p[11].payload.buffer as PublicKey).equals(key(92))).toBe(true);
    expect(p[12].payload.op).toBe(1); expect((p[12].payload.program as PublicKey).equals(key(93))).toBe(true); expect((p[12].payload.target as PublicKey).equals(key(94))).toBe(true);
    expect(t.pendingActionsMask).toBe(0b11111111111111); expect(t.reservedV61NonZero).toBe(false);
  });
  test("[P27] an empty v3 cooldown block reads as direct-path (delay 0, nothing pending)", () => {
    const b = treasuryV3(); b.fill(0, 818, 1624);
    const t = decodeTreasuryAccount(b);
    expect(t.delaySecs).toBe(0); expect(t.pendingActionsMask).toBe(0); expect(decodeTreasuryCooldownBlock(b).pendingActions.every((s) => s.eta.isZero())).toBe(true);
  });
});

describe("pendingStatus (chain clock)", () => {
  test("[P28] none / waiting / ready / expired boundaries", () => {
    expect(pendingStatus(0, 10)).toBe("none");
    expect(pendingStatus(100, 99)).toBe("waiting");
    expect(pendingStatus(100, 100)).toBe("ready");
    expect(pendingStatus(100, 100 + GRACE_PERIOD_SECS)).toBe("ready");
    expect(pendingStatus(100, 100 + GRACE_PERIOD_SECS + 1)).toBe("expired");
    expect(pendingStatus(100n, 50n)).toBe("waiting");
    expect(pendingStatus(new BN(100).toNumber(), 150, 10)).toBe("expired");
  });
});

describe("LP mint metadata (T1)", () => {
  function t22MintWithMetadata(name: string, symbol: string, uri: string, pool: PublicKey, authority: PublicKey | null): Buffer {
    const mint = Keypair.generate().publicKey;
    const base = Buffer.alloc(getMintLen([ExtensionType.MetadataPointer]));
    base[44] = 9; base[45] = 1;
    base[165] = 1; // AccountType::Mint
    // MetadataPointer TLV: type 18, length 64, authority + metadata address (= mint)
    let o = 166;
    base.writeUInt16LE(ExtensionType.MetadataPointer, o); base.writeUInt16LE(64, o + 2); o += TYPE_SIZE + LENGTH_SIZE;
    PublicKey.default.toBuffer().copy(base, o); mint.toBuffer().copy(base, o + 32);
    const body = packTokenMetadata({ mint, name, symbol, uri, updateAuthority: authority ?? undefined, additionalMetadata: [["pool", pool.toBase58()]] });
    const tlv = Buffer.alloc(TYPE_SIZE + LENGTH_SIZE + body.length);
    tlv.writeUInt16LE(ExtensionType.TokenMetadata, 0); tlv.writeUInt16LE(body.length, 2); Buffer.from(body).copy(tlv, 4);
    return Buffer.concat([base, tlv]);
  }
  test("[P29] in-mint TokenMetadata is decoded with the pool pair and a revoked authority", () => {
    const pool = key(77);
    const m = decodeMintAccount(t22MintWithMetadata("USDC-USDT Coffer LP", "cLP-USDX", "https://arweave.net/abc", pool, null));
    expect(m.extensions).toEqual([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
    expect(m.metadataPointer).not.toBeNull();
    expect(m.tokenMetadata).toEqual({ name: "USDC-USDT Coffer LP", symbol: "cLP-USDX", uri: "https://arweave.net/abc", additionalMetadata: [["pool", pool.toBase58()]], updateAuthority: null });
  });
  test("[P30] a legacy 82-byte SPL LP mint has no metadata (null → synthetic label)", () => {
    const b = Buffer.alloc(82); b[44] = 9; b[45] = 1;
    expect(decodeMintAccount(b).tokenMetadata).toBeNull(); expect(decodeMintAccount(b).metadataPointer).toBeNull();
  });
  test("[P31] an update authority that is still set is surfaced", () => {
    const m = decodeMintAccount(t22MintWithMetadata("x", "y", "ipfs://Q", key(1), key(9)));
    expect(m.tokenMetadata!.updateAuthority!.equals(key(9))).toBe(true);
  });
  test("[P32] a malformed TokenMetadata body yields null instead of breaking the mint decode", () => {
    expect(parseTokenMetadataExtension([ExtensionType.TokenMetadata], Buffer.from([19, 0, 3, 0, 1, 2, 3]))).toBeNull();
  });
});

// ── negative ────────────────────────────────────────────────────────────────

describe("decodePoolAccount refusals and drift notes", () => {
  test("[N01] v3 size is refused with the migration hint", () => {
    expect(() => decodePoolAccount(Buffer.alloc(1154))).toThrow(/v3 size/);
  });
  test.each([0, 8, 1682, 1684, 2303, 2305, 4096])("[N02] unexpected size %i is refused", (len) => {
    const b = Buffer.alloc(len); if (len >= 8) POOL_DISC.copy(b, 0);
    expect(() => decodePoolAccount(b)).toThrow(/unexpected data length/);
    expect(isDecodablePoolLen(len)).toBe(false);
  });
  test("[N03] wrong discriminator on both sizes", () => {
    for (const b of [legacyPrefix(), v61Pool()]) { b[0] ^= 0xff; expect(() => decodePoolAccount(b)).toThrow(/discriminator/); }
  });
  test("[N04] token_count > 10", () => {
    const b = v61Pool(); b[41] = 11; expect(() => decodePoolAccount(b)).toThrow(/token_count 11/);
  });
  test.each([64, 65, 162, 179 + 84])("[N05] non-canonical Borsh bool at %i", (off) => {
    const b = v61Pool(); b[off] = 2; expect(() => decodePoolAccount(b)).toThrow(/invalid Borsh bool/);
  });
  test("[N06] layout_version != 1 on a 2304-byte account is reported as drift", () => {
    const b = v61Pool(); b[C.LAYOUT_VERSION_OFFSET] = 0;
    const r = decodePoolAccount(b); expect(r.layoutVersion).toBe(0); expect(r.layoutDrift.join()).toMatch(/layout_version is 0/);
    b[C.LAYOUT_VERSION_OFFSET] = 2; expect(decodePoolAccount(b).layoutDrift.join()).toMatch(/layout_version is 2/);
  });
  test("[N07] a non-zero reserve is drift", () => {
    const b = v61Pool(); b[2303] = 1; expect(decodePoolAccount(b).layoutDrift).toContain("reserved_v61 is not all zero");
    const c = v61Pool(); c[C.RESERVED_V61_OFFSET] = 1; expect(decodePoolAccount(c).layoutDrift).toContain("reserved_v61 is not all zero");
  });
  test("[N08] non-bool range_manager_locked / hook_disabled bytes are drift (not a lock)", () => {
    const b = v61Pool(); b[C.RANGE_MANAGER_LOCKED_OFFSET] = 7;
    expect(decodePoolAccount(b).layoutDrift.join()).toMatch(/range_manager_locked/);
    const c = v61Pool(); c[C.HOOK_DISABLED_OFFSET] = 9;
    expect(decodePoolAccount(c).layoutDrift.join()).toMatch(/hook_disabled/);
  });
  test("[N09] a hook block without a program is drift", () => {
    const b = v61Pool(); b.fill(0, C.HOOK_PROGRAM_OFFSET, C.HOOK_PROGRAM_OFFSET + 32);
    expect(decodePoolAccount(b).layoutDrift).toContain("hook block is non-zero without a hook program");
  });
  test("[N10] per-slot v6.1 arrays past token_count must be zero", () => {
    const b = v61Pool(); b.writeBigUInt64LE(1n, C.CREATOR_FEES_OWED_OFFSET + 8 * 5);
    expect(decodePoolAccount(b).layoutDrift.join()).toMatch(/creator_fees_owed\[5\]/);
    const c = v61Pool(); c.writeBigUInt64LE(1n, C.SURGE_FEES_OWED_OFFSET + 8 * 9);
    expect(decodePoolAccount(c).layoutDrift.join()).toMatch(/surge_fees_owed\[9\]/);
    const d = v61Pool(); d[C.TOKEN_DECIMALS_OFFSET + 3] = 6;
    expect(decodePoolAccount(d).layoutDrift.join()).toMatch(/token_decimals\[3\]/);
  });
  test("[N11] drift never hides the decoded values", () => {
    const b = v61Pool(); b[2303] = 1; const r = decodePoolAccount(b);
    expect(r.creatorFeeBps).toBe(2500); expect(r.hookAccountsLen).toBe(4);
  });
  test("[N12] the cooldown block reader needs the v6.1 size", () => {
    expect(() => decodePoolCooldownBlock(legacyPrefix())).toThrow(/2304/);
  });
  test("[N13] a legacy-size account never reports v6.1 state even when its tail bytes would decode", () => {
    const b = legacyPrefix(); // 1683 bytes: there is no v6.1 block to read
    const r = decodePoolAccount(b);
    expect(r.pendingActions).toHaveLength(0); expect(r.hookProgram.equals(PublicKey.default)).toBe(true);
  });
  test("[N14] a slot mask bit is set only for a non-zero eta (negative etas count as live)", () => {
    const b = v61Pool(); b.fill(0, C.PENDING_POOL_ADMIN_ETA_OFFSET, C.HOOK_PROGRAM_OFFSET); b.writeBigInt64LE(-1n, C.PENDING_SET_TOKEN_ACTIVE_OFFSET);
    expect(decodePoolAccount(b).pendingActionsMask).toBe(1 << 10);
  });
  test("[N15] the migration marker is not inferred from the v6.1 block", () => {
    const b = v61Pool(); b.fill(0, 1667, 1683);
    expect(decodePoolAccount(b).v5Migrated).toBe(false);
  });
});

describe("decodeTreasuryAccount refusals", () => {
  test.each([0, 7, 785, 787, 817, 819, 1623, 1625])("[N16] size %i is refused", (len) => {
    const b = Buffer.alloc(len); if (len >= 8) TREASURY_DISCRIMINATOR.copy(b, 0);
    expect(() => decodeTreasuryAccount(b)).toThrow(/discriminator|unexpected data length/);
  });
  test("[N17] wrong discriminator", () => {
    const b = treasuryV3(); b[3] ^= 1; expect(() => decodeTreasuryAccount(b)).toThrow(/discriminator/);
  });
  test("[N18] token_count > 10", () => {
    const b = treasuryV3(); b[73] = 11; expect(() => decodeTreasuryAccount(b)).toThrow(/token_count 11/);
  });
  test("[N19] the cooldown block reader needs the v3 size", () => {
    expect(() => decodeTreasuryCooldownBlock(treasuryV2())).toThrow(/1624/);
  });
  test("[N20] a non-zero v3 reserve is flagged", () => {
    const b = treasuryV3(); b[1623] = 1; expect(decodeTreasuryAccount(b).reservedV61NonZero).toBe(true);
  });
  test("[N21] v1 / v2 readings never report a supervisor or cooldown that is not there", () => {
    const v1 = decodeTreasuryAccount(treasuryV2().subarray(0, 786));
    expect(v1.supervisor).toBeNull(); expect(v1.pendingAdminEta.isZero()).toBe(true);
  });
  test("[N22] pendingStatus treats a negative now as waiting, never ready", () => {
    expect(pendingStatus(5, -1)).toBe("waiting");
  });
  test("[N23] pendingStatus with a zero grace expires right after eta", () => {
    expect(pendingStatus(5, 6, 0)).toBe("expired"); expect(pendingStatus(5, 5, 0)).toBe("ready");
  });
});
