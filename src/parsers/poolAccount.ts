import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  MAX_TOKENS,
  POOL_ACTION_KINDS,
  POOL_DECODABLE_LENS,
  POOL_LAYOUT as L,
  POOL_LAYOUT_VERSION_V61,
  POOL_LEN_V3,
  POOL_LEN_V5,
  POOL_LEN_V61,
  TOKEN_SLOT_LEN,
  PoolActionKindName,
} from "./layout";

/**
 * Raw binary layout of `CofferPool` (see
 * `contracts/programs/coffer-pool/src/state/coffer_pool.rs`).
 *
 * Two sizes decode:
 *
 *   - **2304 bytes (v6.1)** — the current layout. The v4/v5 account is its
 *     prefix; the appended block (`layout_version`, FIX-6 decimals pins, the
 *     T14 creator fee, the T12 surge bucket, the T7 liquidity fees, the T6
 *     range-manager lock, the T3 cooldown block, the T9 hook block, the
 *     reserve) starts at byte 1683.
 *   - **1683 bytes (v4/v5, unmigrated)** — decoded READ-ONLY with
 *     `layoutVersion = 0` and every appended field at its default (0 / empty
 *     / `PublicKey.default`). The v6.1 program refuses every instruction on
 *     such an account with `LayoutVersionMismatch` (6070) until the
 *     permissionless `migrate_pool_layout_v61` grows it; the transaction
 *     builders prepend that migration automatically.
 *
 * Per-token data is exposed as parallel arrays (10 entries, zero past
 * `tokenCount`) for backwards compatibility with `CofferPoolClient.sync()`
 * and other consumers of the v5 shape.
 *
 * Decoded manually (no Anchor `Program` instance): both frontend and
 * backend consume the SDK and the full Anchor runtime is heavy.
 */
export interface RawPoolAccount {
  config: PublicKey;
  bump: number;
  tokenCount: number;
  poolId: BN;
  swapFeeRate: number;
  protocolFeeRate: number;
  createdAt: BN;
  poolEnabled: boolean;
  swapsEnabled: boolean;
  poolAdmin: PublicKey;
  pendingPoolAdmin: PublicKey;

  rangeManager: PublicKey;
  rangeManagerEnabled: boolean;
  /** Percent-of-current-value cap, `PERCENT_SCALE` units (10_000 = 100%). */
  rangeManagerMaxVbChangePct: number;
  rangeManagerMaxWeightChangePct: number;
  rangeManagerMinUpdateIntervalSecs: number;
  rangeManagerLastUpdated: BN;
  /**
   * Absolute UPPER bound on `virtual_balance / actual_balance` the range
   * manager may leave a token at, in basis points (10_000 = 1.0×).
   * `0` ⇒ band disabled. Pools written before v5.1 read `0`.
   */
  rangeManagerMaxLeverageBps: number;
  /** Absolute LOWER bound on `virtual_balance / actual_balance`, same units. */
  rangeManagerMinLeverageBps: number;

  // Per-token (length 10 each; values past `tokenCount` are zeroed).
  tokenMints: PublicKey[];
  tokenPrograms: PublicKey[];
  normalizedWeights: BN[];
  /** Max cumulative sell volume per window, `PERCENT_SCALE` units; `0` disables. */
  maxSelloffPct: number[];
  maxSelloffPeriodLength: number[];
  /** Variable surge-fee curve, per token (`PERCENT_SCALE` units). */
  variableFeeThresholdPct: number[];
  variableFeeSlopeLowPct: number[];
  variableFeeSlopeHighPct: number[];
  /** Surge fee at the KINK (`PERCENT_SCALE` units); v5.1, `0` on older pools. */
  variableFeeSlopeMidPct: number[];
  /** Kink position in WHOLE PERCENT (0..=100); `0` ⇒ no kink. */
  variableFeeKinkPct: number[];
  /** Per-token input kill switch (`false` ⇒ swaps with this token as INPUT revert). */
  isActive: boolean[];

  virtualBalances: BN[];
  actualBalances: BN[];
  protocolFeesOwed: BN[];
  previousSelloff: BN[];
  currentSelloff: BN[];
  windowStartTimestamp: BN[];
  /** Virtual-balance snapshot taken when the max-selloff window opened. */
  selloffVbSnapshot: BN[];

  /** Per-pool Address Lookup Table; `PublicKey.default` ⇒ not provisioned. */
  lookupTable: PublicKey;

  /**
   * Bytes 1651..1659: the former per-pool `banned_extensions` policy bitmap
   * (removed in v6.1/T19). Exposed raw for layout inspection only.
   */
  deprecatedBannedExtensions: BN;
  /** The legacy 16-byte trailing block (frozen; `V5M1` marker in `[0..4]`). */
  reserved: Buffer;
  /** `reserved[0..4] == "V5M1"`: `CofferPool::is_v5_migrated()`. */
  v5Migrated: boolean;

  // ── v6.1 appended block (defaults on a 1683-byte account) ──────────────

  /** Account size the bytes were decoded from: 1683 (unmigrated) or 2304. */
  dataLen: number;
  /**
   * `CofferPool.layout_version` @1683: `1` on a v6.1 account, `0` on an
   * unmigrated 1683-byte account (the SIZE is the real marker; a 2304-byte
   * account with `0` here is flagged by `layoutDrift`).
   */
  layoutVersion: number;
  /** FIX-6 decimals pins @1684.., 10 entries (0 past `tokenCount`); all 0 on an unmigrated account. */
  tokenDecimals: number[];
  /** v6.1 (T14): pool admin's share of the LP fee remainder, bps (0 = off). */
  creatorFeeBps: number;
  /** v6.1 (T14): `creator_fees_owed` @1696, 10 entries (raw units). */
  creatorFeesOwed: BN[];
  /** v6.1 (T12): LP-claimable surge bucket `surge_fees_owed` @1776, 10 entries (raw units). */
  surgeFeesOwed: BN[];
  /** v6.1 (T7): deposit fee bps (LP haircut on `add_liquidity`). */
  depositFeeBps: number;
  /** v6.1 (T7): withdraw fee bps (payout haircut on `remove_liquidity`). */
  withdrawFeeBps: number;
  /** v6.1 (T7): raw `liquidity_fee_lock` byte (bit 0 = frozen for ever). */
  liquidityFeeLock: number;
  /** v6.1 (T6): one-way "no range manager, ever" flag @1861. */
  rangeManagerLocked: boolean;
  /** v6.1 (T3): pool-admin cooldown in force (0 = direct path). */
  poolAdminDelaySecs: number;
  /** v6.1 (T3): bumped on every pool-admin change; every pending slot is voided with it. */
  poolAdminEpoch: number;
  /** v6.1 (T3): eta of the pending admin transfer (kind 0; nominee = `pendingPoolAdmin`); 0 = none. */
  pendingPoolAdminEta: BN;
  /** v6.1 (T3): the eleven typed pending slots in kind order (kind 0 = admin transfer). */
  pendingActions: RawPendingPoolAction[];
  /** v6.1 (T3): bit `kind` set ⇔ that slot is live (`CofferPool::pending_actions_mask`). */
  pendingActionsMask: number;
  /** v6.1 (T9): hook program (`PublicKey.default` = no hook). */
  hookProgram: PublicKey;
  /** v6.1 (T9): `coffer_hook_interface::flags` bitmap. */
  hookFlags: number;
  /** v6.1 (T9): raw `hook_disabled` byte (protocol-admin emergency switch). */
  hookDisabled: number;
  /** v6.1 (T9): fee-override clamp (hundredths of bps). */
  hookFeeMin: number;
  hookFeeMax: number;
  /** v6.1 (T9): per-callback CU ceiling. */
  hookMaxCu: number;
  /** v6.1 (T9): length of the hook account slice `[hook_program, hook_caller, extras..]`. */
  hookAccountsLen: number;
  /** v6.1: `reserved_v61` @2102 (202 bytes, zero); empty on an unmigrated account. */
  reservedV61: Buffer;
  /**
   * Non-empty when a 2304-byte account carries bytes the v6.1 layout does
   * not explain (version byte ≠ 1, non-zero reserve, non-bool flags, slots
   * past `tokenCount` of a per-slot array, hook block without a program).
   * Decoding still succeeds; consumers that mutate state should refuse.
   */
  layoutDrift: string[];
}

/** One decoded pool-admin pending slot (v6.1 T3). `eta` is 0 when empty. */
export interface RawPendingPoolAction {
  kind: number;
  name: PoolActionKindName;
  /** Unix seconds; `0` ⇔ empty. */
  eta: BN;
  /** Absolute payload as stored on chain (plain values; hashes as hex strings). */
  payload: Record<string, string | number | boolean | PublicKey | BN>;
}

/** 8-byte anchor discriminator for CofferPool. */
export const POOL_DISCRIMINATOR_LEN = 8;
const POOL_DISCRIMINATOR = Buffer.from([137, 210, 42, 22, 209, 156, 43, 78]);
/**
 * Current (v6.1) `CofferPool` size, discriminator included. Since v6.1 this
 * is 2304; the pre-migration v4/v5 account is {@link POOL_V4_LEN}.
 */
export const POOL_LEN = POOL_LEN_V61;
/**
 * Pre-v6.1 (v4/v5) size, 1683 bytes. v5.1 carved its fields out of
 * `reserved` so v4 and v5 share it; v6.1 grows it to {@link POOL_LEN}.
 */
export const POOL_V4_LEN = POOL_LEN_V5;
/** Pre-v4 size — legacy accounts are unsupported (dead pools). */
export const POOL_V3_LEN = POOL_LEN_V3;
export { POOL_LEN_V5, POOL_LEN_V61 };

/** `CofferPool::V5_MIGRATION_MARKER`: stamped into `reserved[0..4]` by `migrate_to_v5` and at creation. */
export const V5_MIGRATION_MARKER = Buffer.from("V5M1", "ascii");

/** `true` for the two sizes the decoder accepts. */
export function isDecodablePoolLen(len: number): boolean {
  return POOL_DECODABLE_LENS.includes(len);
}

/** `true` iff the account still needs `migrate_pool_layout_v61` (1683 bytes). */
export function poolNeedsLayoutMigration(data: Buffer | { length: number }): boolean {
  return data.length === POOL_LEN_V5;
}

export function decodePoolAccount(data: Buffer): RawPoolAccount {
  if (data.length === POOL_V3_LEN) {
    throw new Error(
      `decodePoolAccount: account is at v3 size (${POOL_V3_LEN}). ` +
        `Legacy v3 accounts require a separate migration; migrate_to_v5 supports only 1683-byte v4 accounts.`,
    );
  }
  if (!isDecodablePoolLen(data.length)) {
    throw new Error(
      `decodePoolAccount: unexpected data length ${data.length} ` +
        `(expected ${POOL_V4_LEN} for an unmigrated v4/v5 pool or ${POOL_LEN_V61} for v6.1).`,
    );
  }
  if (!data.subarray(0, POOL_DISCRIMINATOR_LEN).equals(POOL_DISCRIMINATOR)) {
    throw new Error("decodePoolAccount: invalid CofferPool discriminator");
  }

  let off = POOL_DISCRIMINATOR_LEN;

  const config = readPubkey(data, off);
  off += 32;
  const bump = data.readUInt8(off);
  off += 1;
  const tokenCount = data.readUInt8(off);
  off += 1;
  if (tokenCount > MAX_TOKENS) {
    throw new Error(`decodePoolAccount: token_count ${tokenCount} exceeds ${MAX_TOKENS}`);
  }
  const poolId = readU64LE(data, off);
  off += 8;
  const swapFeeRate = data.readUInt32LE(off);
  off += 4;
  const protocolFeeRate = data.readUInt16LE(off);
  off += 2;
  const createdAt = readI64LE(data, off);
  off += 8;
  const poolEnabled = readBool(data, off);
  off += 1;
  const swapsEnabled = readBool(data, off);
  off += 1;
  const poolAdmin = readPubkey(data, off);
  off += 32;
  const pendingPoolAdmin = readPubkey(data, off);
  off += 32;

  const rangeManager = readPubkey(data, off);
  off += 32;
  const rangeManagerEnabled = readBool(data, off);
  off += 1;
  const rangeManagerMaxVbChangePct = data.readUInt16LE(off);
  off += 2;
  const rangeManagerMaxWeightChangePct = data.readUInt16LE(off);
  off += 2;
  const rangeManagerMinUpdateIntervalSecs = data.readUInt32LE(off);
  off += 4;
  const rangeManagerLastUpdated = readI64LE(data, off);
  off += 8;

  // Per-token AoS — 10 slots, each 144 bytes.
  const tokenMints: PublicKey[] = [];
  const tokenPrograms: PublicKey[] = [];
  const normalizedWeights: BN[] = [];
  const maxSelloffPct: number[] = [];
  const maxSelloffPeriodLength: number[] = [];
  const variableFeeThresholdPct: number[] = [];
  const variableFeeSlopeLowPct: number[] = [];
  const variableFeeSlopeHighPct: number[] = [];
  const variableFeeSlopeMidPct: number[] = [];
  const variableFeeKinkPct: number[] = [];
  const isActive: boolean[] = [];
  const virtualBalances: BN[] = [];
  const actualBalances: BN[] = [];
  const protocolFeesOwed: BN[] = [];
  const previousSelloff: BN[] = [];
  const currentSelloff: BN[] = [];
  const windowStartTimestamp: BN[] = [];
  const selloffVbSnapshot: BN[] = [];

  if (off !== L.TOKENS.offset) {
    throw new Error(`decodePoolAccount: header consumed ${off} bytes, expected the token slots @${L.TOKENS.offset}`);
  }
  for (let i = 0; i < MAX_TOKENS; i++) {
    const slotStart = off;

    // AssetConfig — 88 bytes
    tokenMints.push(readPubkey(data, off));
    off += 32;
    tokenPrograms.push(readPubkey(data, off));
    off += 32;
    normalizedWeights.push(readU64LE(data, off));
    off += 8;
    maxSelloffPct.push(data.readUInt16LE(off));
    off += 2;
    maxSelloffPeriodLength.push(data.readUInt32LE(off));
    off += 4;
    variableFeeThresholdPct.push(data.readUInt16LE(off));
    off += 2;
    variableFeeSlopeLowPct.push(data.readUInt16LE(off));
    off += 2;
    variableFeeSlopeHighPct.push(data.readUInt16LE(off));
    off += 2;
    isActive.push(readBool(data, off));
    off += 1;
    // v5.1: the trailing `AssetConfig.reserved[3]` became these two fields.
    variableFeeSlopeMidPct.push(data.readUInt16LE(off));
    off += 2;
    variableFeeKinkPct.push(data.readUInt8(off));
    off += 1;

    // AssetDynamics — 56 bytes
    virtualBalances.push(readU64LE(data, off));
    off += 8;
    actualBalances.push(readU64LE(data, off));
    off += 8;
    protocolFeesOwed.push(readU64LE(data, off));
    off += 8;
    previousSelloff.push(readU64LE(data, off));
    off += 8;
    currentSelloff.push(readU64LE(data, off));
    off += 8;
    windowStartTimestamp.push(readI64LE(data, off));
    off += 8;
    selloffVbSnapshot.push(readU64LE(data, off));
    off += 8;

    // Fail loudly rather than silently sliding every later field if the
    // slot layout ever drifts again.
    if (off - slotStart !== TOKEN_SLOT_LEN) {
      throw new Error(
        `decodePoolAccount: TokenSlot ${i} consumed ${off - slotStart} bytes, expected ${TOKEN_SLOT_LEN}`,
      );
    }
  }

  if (off !== L.LOOKUP_TABLE.offset) {
    throw new Error(`decodePoolAccount: token slots end at ${off}, expected lookup_table @${L.LOOKUP_TABLE.offset}`);
  }
  const lookupTable = readPubkey(data, off);
  off += 32;

  // Former per-pool banned-extensions bitmap (policy removed in v6.1/T19).
  const deprecatedBannedExtensions = readU64LE(data, off);
  off += 8;

  // v5.1: two u32s carved out of the trailing reserved blob.
  const rangeManagerMaxLeverageBps = data.readUInt32LE(off);
  off += 4;
  const rangeManagerMinLeverageBps = data.readUInt32LE(off);
  off += 4;

  // Preserve the legacy trailing block after checking its exact offset.
  if (off !== L.RESERVED.offset || off + L.RESERVED.size !== POOL_V4_LEN) {
    throw new Error(
      `decodePoolAccount: consumed ${off} bytes before reserved[16], ` +
        `expected ${POOL_V4_LEN - 16}. Layout drift — regenerate this decoder.`,
    );
  }
  const reserved = Buffer.from(data.subarray(off, off + 16));
  const v5Migrated = reserved.subarray(0, 4).equals(V5_MIGRATION_MARKER);
  off += 16;

  const base = {
    config,
    bump,
    tokenCount,
    poolId,
    swapFeeRate,
    protocolFeeRate,
    createdAt,
    poolEnabled,
    swapsEnabled,
    poolAdmin,
    pendingPoolAdmin,
    rangeManager,
    rangeManagerEnabled,
    rangeManagerMaxVbChangePct,
    rangeManagerMaxWeightChangePct,
    rangeManagerMinUpdateIntervalSecs,
    rangeManagerLastUpdated,
    rangeManagerMaxLeverageBps,
    rangeManagerMinLeverageBps,
    tokenMints,
    tokenPrograms,
    normalizedWeights,
    maxSelloffPct,
    maxSelloffPeriodLength,
    variableFeeThresholdPct,
    variableFeeSlopeLowPct,
    variableFeeSlopeHighPct,
    variableFeeSlopeMidPct,
    variableFeeKinkPct,
    isActive,
    virtualBalances,
    actualBalances,
    protocolFeesOwed,
    previousSelloff,
    currentSelloff,
    windowStartTimestamp,
    selloffVbSnapshot,
    lookupTable,
    deprecatedBannedExtensions,
    reserved,
    v5Migrated,
    dataLen: data.length,
  };

  if (data.length === POOL_V4_LEN) {
    return { ...base, ...v61Defaults() };
  }
  if (off !== L.LAYOUT_VERSION.offset) {
    throw new Error(`decodePoolAccount: v6.1 block expected @${L.LAYOUT_VERSION.offset}, walk ended at ${off}`);
  }
  return { ...base, ...decodeV61Block(data, tokenCount) };
}

/** The v6.1 fields as a 1683-byte (unmigrated) account reads them. */
function v61Defaults(): Pick<RawPoolAccount,
  | "layoutVersion" | "tokenDecimals" | "creatorFeeBps" | "creatorFeesOwed" | "surgeFeesOwed" | "depositFeeBps"
  | "withdrawFeeBps" | "liquidityFeeLock" | "rangeManagerLocked" | "poolAdminDelaySecs" | "poolAdminEpoch"
  | "pendingPoolAdminEta" | "pendingActions" | "pendingActionsMask" | "hookProgram" | "hookFlags" | "hookDisabled"
  | "hookFeeMin" | "hookFeeMax" | "hookMaxCu" | "hookAccountsLen" | "reservedV61" | "layoutDrift"
> {
  const zeros = () => Array.from({ length: MAX_TOKENS }, () => new BN(0));
  return {
    layoutVersion: 0,
    tokenDecimals: Array.from({ length: MAX_TOKENS }, () => 0),
    creatorFeeBps: 0,
    creatorFeesOwed: zeros(),
    surgeFeesOwed: zeros(),
    depositFeeBps: 0,
    withdrawFeeBps: 0,
    liquidityFeeLock: 0,
    rangeManagerLocked: false,
    poolAdminDelaySecs: 0,
    poolAdminEpoch: 0,
    pendingPoolAdminEta: new BN(0),
    pendingActions: [],
    pendingActionsMask: 0,
    hookProgram: PublicKey.default,
    hookFlags: 0,
    hookDisabled: 0,
    hookFeeMin: 0,
    hookFeeMax: 0,
    hookMaxCu: 0,
    hookAccountsLen: 0,
    reservedV61: Buffer.alloc(0),
    layoutDrift: [],
  };
}

function decodeV61Block(data: Buffer, tokenCount: number): ReturnType<typeof v61Defaults> {
  const drift: string[] = [];
  const layoutVersion = data.readUInt8(L.LAYOUT_VERSION.offset);
  if (layoutVersion !== POOL_LAYOUT_VERSION_V61) drift.push(`layout_version is ${layoutVersion}, expected ${POOL_LAYOUT_VERSION_V61}`);
  const tokenDecimals = Array.from(data.subarray(L.TOKEN_DECIMALS.offset, L.TOKEN_DECIMALS.offset + L.TOKEN_DECIMALS.size));
  for (let i = tokenCount; i < MAX_TOKENS; i++) if (tokenDecimals[i] !== 0) drift.push(`token_decimals[${i}] past token_count is ${tokenDecimals[i]}`);

  const creatorFeeBps = data.readUInt16LE(L.CREATOR_FEE_BPS.offset);
  const creatorFeesOwed: BN[] = [];
  const surgeFeesOwed: BN[] = [];
  for (let i = 0; i < MAX_TOKENS; i++) {
    creatorFeesOwed.push(readU64LE(data, L.CREATOR_FEES_OWED.offset + 8 * i));
    surgeFeesOwed.push(readU64LE(data, L.SURGE_FEES_OWED.offset + 8 * i));
    if (i >= tokenCount) {
      if (!creatorFeesOwed[i].isZero()) drift.push(`creator_fees_owed[${i}] past token_count is non-zero`);
      if (!surgeFeesOwed[i].isZero()) drift.push(`surge_fees_owed[${i}] past token_count is non-zero`);
    }
  }
  const depositFeeBps = data.readUInt16LE(L.DEPOSIT_FEE_BPS.offset);
  const withdrawFeeBps = data.readUInt16LE(L.WITHDRAW_FEE_BPS.offset);
  const liquidityFeeLock = data.readUInt8(L.LIQUIDITY_FEE_LOCK.offset);
  const lockedByte = data.readUInt8(L.RANGE_MANAGER_LOCKED.offset);
  if (lockedByte > 1) drift.push(`range_manager_locked @${L.RANGE_MANAGER_LOCKED.offset} is ${lockedByte}, not a bool`);

  const cooldown = decodePoolCooldownBlock(data);

  const hookProgram = readPubkey(data, L.HOOK_PROGRAM.offset);
  const hookFlags = data.readUInt16LE(L.HOOK_FLAGS.offset);
  const hookDisabled = data.readUInt8(L.HOOK_DISABLED.offset);
  if (hookDisabled > 1) drift.push(`hook_disabled @${L.HOOK_DISABLED.offset} is ${hookDisabled}, not a bool`);
  const hookFeeMin = data.readUInt32LE(L.HOOK_FEE_MIN.offset);
  const hookFeeMax = data.readUInt32LE(L.HOOK_FEE_MAX.offset);
  const hookMaxCu = data.readUInt32LE(L.HOOK_MAX_CU.offset);
  const hookAccountsLen = data.readUInt8(L.HOOK_ACCOUNTS_LEN.offset);
  if (hookProgram.equals(PublicKey.default) && (hookFlags | hookDisabled | hookFeeMin | hookFeeMax | hookMaxCu | hookAccountsLen) !== 0) {
    drift.push("hook block is non-zero without a hook program");
  }

  const reservedV61 = Buffer.from(data.subarray(L.RESERVED_V61.offset, L.RESERVED_V61.offset + L.RESERVED_V61.size));
  if (reservedV61.some((b) => b !== 0)) drift.push("reserved_v61 is not all zero");
  if (L.RESERVED_V61.offset + L.RESERVED_V61.size !== POOL_LEN_V61) {
    throw new Error("decodePoolAccount: reserved_v61 does not end at the account size — regenerate this decoder");
  }

  return {
    layoutVersion,
    tokenDecimals,
    creatorFeeBps,
    creatorFeesOwed,
    surgeFeesOwed,
    depositFeeBps,
    withdrawFeeBps,
    liquidityFeeLock,
    rangeManagerLocked: lockedByte !== 0,
    ...cooldown,
    hookProgram,
    hookFlags,
    hookDisabled,
    hookFeeMin,
    hookFeeMax,
    hookMaxCu,
    hookAccountsLen,
    reservedV61,
    layoutDrift: drift,
  };
}

/** v6.1 (T3): decode the pool-admin cooldown block @1862..2054 of a 2304-byte account. */
export function decodePoolCooldownBlock(data: Buffer): Pick<RawPoolAccount, "poolAdminDelaySecs" | "poolAdminEpoch" | "pendingPoolAdminEta" | "pendingActions" | "pendingActionsMask"> {
  if (data.length !== POOL_LEN_V61) throw new Error(`decodePoolCooldownBlock: needs a ${POOL_LEN_V61}-byte account`);
  const slot = (kind: number, off: number, payload: RawPendingPoolAction["payload"]): RawPendingPoolAction =>
    ({ kind, name: POOL_ACTION_KINDS[kind], eta: readI64LE(data, off), payload });
  const rm = L.PENDING_SET_RANGE_MANAGER.offset;
  const cfg = L.PENDING_SET_RANGE_MANAGER_CONFIG.offset;
  const pendingActions: RawPendingPoolAction[] = [
    slot(0, L.PENDING_POOL_ADMIN_ETA.offset, { newAdmin: readPubkey(data, L.PENDING_POOL_ADMIN.offset) }),
    slot(1, L.PENDING_SET_DELAY.offset, { secs: data.readUInt32LE(L.PENDING_SET_DELAY.offset + 8) }),
    slot(2, L.PENDING_SET_SWAP_FEE_RATE.offset, { rate: data.readUInt32LE(L.PENDING_SET_SWAP_FEE_RATE.offset + 8) }),
    slot(3, L.PENDING_SET_CREATOR_FEE_BPS.offset, { bps: data.readUInt16LE(L.PENDING_SET_CREATOR_FEE_BPS.offset + 8) }),
    slot(4, L.PENDING_SET_LIQUIDITY_FEES.offset, {
      depositFeeBps: data.readUInt16LE(L.PENDING_SET_LIQUIDITY_FEES.offset + 8),
      withdrawFeeBps: data.readUInt16LE(L.PENDING_SET_LIQUIDITY_FEES.offset + 10),
    }),
    slot(5, L.PENDING_LOCK_LIQUIDITY_FEES.offset, {}),
    slot(6, L.PENDING_LOCK_RANGE_MANAGER.offset, {}),
    slot(7, rm, { manager: readPubkey(data, rm + 8), enabled: data.readUInt8(rm + 40) !== 0 }),
    slot(8, cfg, {
      maxVbChangePct: data.readUInt16LE(cfg + 8), maxWeightChangePct: data.readUInt16LE(cfg + 10),
      minUpdateIntervalSecs: data.readUInt32LE(cfg + 12), maxLeverageBps: data.readUInt32LE(cfg + 16), minLeverageBps: data.readUInt32LE(cfg + 20),
    }),
    slot(9, L.PENDING_SET_MAX_SELLOFF.offset, { paramsHash: data.subarray(L.PENDING_SET_MAX_SELLOFF.offset + 8, L.PENDING_SET_MAX_SELLOFF.offset + 40).toString("hex") }),
    slot(10, L.PENDING_SET_TOKEN_ACTIVE.offset, { tokenIndex: data.readUInt8(L.PENDING_SET_TOKEN_ACTIVE.offset + 8) }),
  ];
  return {
    poolAdminDelaySecs: data.readUInt32LE(L.POOL_ADMIN_DELAY_SECS.offset),
    poolAdminEpoch: data.readUInt32LE(L.POOL_ADMIN_EPOCH.offset),
    pendingPoolAdminEta: readI64LE(data, L.PENDING_POOL_ADMIN_ETA.offset),
    pendingActions,
    pendingActionsMask: pendingActions.reduce((m, s) => (s.eta.isZero() ? m : m | (1 << s.kind)), 0),
  };
}

function readPubkey(data: Buffer, off: number): PublicKey {
  return new PublicKey(data.subarray(off, off + 32));
}

function readU64LE(data: Buffer, off: number): BN {
  return new BN(data.subarray(off, off + 8), "le");
}

function readI64LE(data: Buffer, off: number): BN {
  return new BN(data.subarray(off, off + 8), "le").fromTwos(64);
}

function readBool(data: Buffer, off: number): boolean {
  const value = data.readUInt8(off);
  if (value > 1) throw new Error(`decodePoolAccount: invalid Borsh bool ${value} at offset ${off}`);
  return value === 1;
}
