import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/**
 * Raw binary layout of CubicPool **v5** (see
 * `contracts/programs/cubic-pool/src/state/cubic_pool.rs`).
 *
 * v4 reorganised per-token data from six parallel arrays into a single
 * `tokens: [TokenSlot; 10]` array (each slot = `AssetConfig` +
 * `AssetDynamics`). For backwards compatibility with downstream
 * consumers (`CubicPoolClient.sync()` and similar), this decoder still
 * exposes the parallel-array shape, plus the new max-selloff and admin
 * fields.
 *
 * v5.1 layout deltas (all carved out of `reserved`, total size unchanged
 * at 1683 — every pre-existing field keeps its byte offset):
 *   - `AssetConfig.reserved[3]` → `variable_fee_slope_mid_pct: u16` +
 *     `variable_fee_kink_pct: u8`. Slot stays 88 bytes.
 *   - `CubicPool`: `range_manager_max_leverage_bps: u32` and
 *     `range_manager_min_leverage_bps: u32` appended after
 *     `banned_extensions`; trailing `reserved` shrank [u8;24] → [u8;16].
 *
 * Pools written by the pre-v5.1 program decode these new fields as `0`,
 * which is the back-compatible reading (curve has no kink, leverage band
 * disabled).
 *
 * We decode manually to avoid bundling an Anchor `Program` instance into
 * the SDK — both frontend and backend consume the SDK, and pulling the
 * full Anchor runtime is heavy.
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
   *
   * The per-update percentage caps *velocity*; this caps *distance*.
   * Breaching it reverts with `RangeManagerLeverageBandExceeded` (6062).
   */
  rangeManagerMaxLeverageBps: number;
  /**
   * Absolute LOWER bound on `virtual_balance / actual_balance`, same units.
   * `0` ⇒ floor disabled. Pools written before v5.1 read `0`.
   */
  rangeManagerMinLeverageBps: number;

  // Per-token (length 10 each; values past `tokenCount` are zeroed).
  tokenMints: PublicKey[];
  tokenPrograms: PublicKey[];
  normalizedWeights: BN[];
  /**
   * Max cumulative sell volume per window, as a percent of the token's
   * virtual balance (`PERCENT_SCALE` units; 10_000 = 100%). `0` disables.
   */
  maxSelloffPct: number[];
  maxSelloffPeriodLength: number[];
  /** Variable surge-fee curve, per token (`PERCENT_SCALE` units). */
  variableFeeThresholdPct: number[];
  variableFeeSlopeLowPct: number[];
  variableFeeSlopeHighPct: number[];
  /**
   * Surge fee at the KINK — the middle control point of the three-point
   * curve (`PERCENT_SCALE` units). Between `variableFeeThresholdPct` and
   * the kink the fee runs linearly from `variableFeeSlopeLowPct` to this
   * value; beyond it, from this value to `variableFeeSlopeHighPct` at full
   * window fill. Contract enforces `low <= mid <= high`.
   *
   * New in v5.1 (carved out of `AssetConfig.reserved`). Pools written by
   * the older program read `0`.
   */
  variableFeeSlopeMidPct: number[];
  /**
   * Window fill at which the surge curve kinks, in WHOLE PERCENT (0..=100)
   * — NOT `PERCENT_SCALE` units. `0` ⇒ no kink: the curve degenerates to a
   * single straight line from `low` at the threshold to `high` at full fill,
   * which is exactly how every pre-v5.1 pool decodes.
   *
   * New in v5.1 (carved out of `AssetConfig.reserved`).
   */
  variableFeeKinkPct: number[];
  /**
   * Per-token input kill switch. `false` ⇒ swaps with this token as INPUT
   * revert (`TokenInactive`). Defaults to `true`.
   */
  isActive: boolean[];

  virtualBalances: BN[];
  actualBalances: BN[];
  protocolFeesOwed: BN[];
  previousSelloff: BN[];
  currentSelloff: BN[];
  windowStartTimestamp: BN[];
  /** Virtual-balance snapshot taken when the max-selloff window opened. */
  selloffVbSnapshot: BN[];

  /**
   * Per-pool Address Lookup Table. `PublicKey.default` means the pool's
   * ALT has not been provisioned yet (`initialize_pool_alt` not called).
   * SDK uses this to choose between v0 (with ALT) and legacy tx-building
   * paths.
   */
  lookupTable: PublicKey;

  /**
   * Effective Token-2022 banned-extensions bitmap this pool's tokens were
   * vetted against at creation (creator override, or the config default).
   * `0` ⇒ no extensions banned. Pre-upgrade pools read `0`. A permissive
   * value is a rug-risk — surface it before depositing.
   */
  bannedExtensions: BN;
}

/** 8-byte anchor discriminator for CubicPool. */
export const POOL_DISCRIMINATOR_LEN = 8;
const MAX_TOKENS = 10;
/**
 * Total on-chain size of a v4/v5 CubicPool (includes the 8-byte
 * discriminator). v5.1 carved its new fields out of `reserved`, so the
 * size is deliberately identical to v4 — size alone cannot tell the two
 * apart, and it does not need to: the new fields read `0` on a v4 account.
 */
export const POOL_V4_LEN = 1683;
/** Alias for {@link POOL_V4_LEN}; the layout is shared by v4 and v5. */
export const POOL_LEN = POOL_V4_LEN;
/** Per-token `TokenSlot` = `AssetConfig` (88) + `AssetDynamics` (56). */
const ASSET_CONFIG_LEN = 88;
const ASSET_DYNAMICS_LEN = 56;
const TOKEN_SLOT_LEN = ASSET_CONFIG_LEN + ASSET_DYNAMICS_LEN;
/** Pre-v4 size — accounts at this size still need `migrate_to_v5`. */
export const POOL_V3_LEN = 1154;

export function decodePoolAccount(data: Buffer): RawPoolAccount {
  if (data.length === POOL_V3_LEN) {
    throw new Error(
      `decodePoolAccount: account is at v3 size (${POOL_V3_LEN}). ` +
        `Run migrate_to_v5 against it before calling this decoder.`,
    );
  }
  if (data.length !== POOL_V4_LEN) {
    throw new Error(
      `decodePoolAccount: unexpected data length ${data.length} ` +
        `(expected ${POOL_V4_LEN} for v4).`,
    );
  }

  let off = POOL_DISCRIMINATOR_LEN;

  const config = readPubkey(data, off);
  off += 32;
  const bump = data.readUInt8(off);
  off += 1;
  const tokenCount = data.readUInt8(off);
  off += 1;
  const poolId = readU64LE(data, off);
  off += 8;
  const swapFeeRate = data.readUInt32LE(off);
  off += 4;
  const protocolFeeRate = data.readUInt16LE(off);
  off += 2;
  const createdAt = readI64LE(data, off);
  off += 8;
  const poolEnabled = data.readUInt8(off) !== 0;
  off += 1;
  const swapsEnabled = data.readUInt8(off) !== 0;
  off += 1;
  const poolAdmin = readPubkey(data, off);
  off += 32;
  const pendingPoolAdmin = readPubkey(data, off);
  off += 32;

  const rangeManager = readPubkey(data, off);
  off += 32;
  const rangeManagerEnabled = data.readUInt8(off) !== 0;
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
    isActive.push(data.readUInt8(off) !== 0);
    off += 1;
    // v5.1: the trailing `AssetConfig.reserved[3]` became these two fields.
    // Byte-for-byte replacement — the slot is still 88 bytes and every
    // preceding field keeps its offset, so a v4 account decodes as 0/0.
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
    off += 8; // AssetDynamics.selloff_vb_snapshot

    // Fail loudly rather than silently sliding every later field if the
    // slot layout ever drifts again.
    if (off - slotStart !== TOKEN_SLOT_LEN) {
      throw new Error(
        `decodePoolAccount: TokenSlot ${i} consumed ${off - slotStart} bytes, expected ${TOKEN_SLOT_LEN}`,
      );
    }
  }

  const lookupTable = readPubkey(data, off);
  off += 32;

  // Effective per-pool Token-2022 banned-extensions bitmap (carved out of
  // the old reserved[32]; pre-upgrade pools read 0).
  const bannedExtensions = readU64LE(data, off);
  off += 8;

  // v5.1: two u32s carved out of the trailing reserved blob, which shrank
  // [u8;24] → [u8;16]. Pre-v5.1 pools read 0 (band disabled).
  const rangeManagerMaxLeverageBps = data.readUInt32LE(off);
  off += 4;
  const rangeManagerMinLeverageBps = data.readUInt32LE(off);
  off += 4;

  // Trailing `reserved[16]` is ignored — but assert we landed exactly on it.
  if (off + 16 !== POOL_V4_LEN) {
    throw new Error(
      `decodePoolAccount: consumed ${off} bytes before reserved[16], ` +
        `expected ${POOL_V4_LEN - 16}. Layout drift — regenerate this decoder.`,
    );
  }

  return {
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
    bannedExtensions,
  };
}

function readPubkey(data: Buffer, off: number): PublicKey {
  return new PublicKey(data.slice(off, off + 32));
}

function readU64LE(data: Buffer, off: number): BN {
  return new BN(data.slice(off, off + 8), "le");
}

function readI64LE(data: Buffer, off: number): BN {
  // i64 LE — for our timestamps (always ≥ 0 in practice) BN+LE matches.
  // Returning BN keeps callers free to interpret signedness if needed.
  return new BN(data.slice(off, off + 8), "le");
}
