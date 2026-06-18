import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/**
 * Raw binary layout of CubicPool **v4** (see
 * `contracts/programs/cubic-pool/src/state/cubic_pool.rs`).
 *
 * v4 reorganised per-token data from six parallel arrays into a single
 * `tokens: [TokenSlot; 10]` array (each slot = `AssetConfig` +
 * `AssetDynamics`). For backwards compatibility with downstream
 * consumers (`CubicPoolClient.sync()` and similar), this decoder still
 * exposes the parallel-array shape, plus the new max-selloff and admin
 * fields.
 *
 * We decode manually to avoid bundling an Anchor `Program` instance into
 * the SDK — both frontend and backend consume the SDK, and pulling the
 * full Anchor runtime is heavy. The on-chain layout is stable (trailing
 * `reserved[64]` blob keeps room for forward extensions).
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
}

/** 8-byte anchor discriminator for CubicPool. */
export const POOL_DISCRIMINATOR_LEN = 8;
const MAX_TOKENS = 10;
/** Total on-chain size of a v4 CubicPool (includes the 8-byte discriminator). */
export const POOL_V4_LEN = 1683;
/** Pre-v4 size — accounts at this size still need `migrate_pool_v4`. */
export const POOL_V3_LEN = 1154;

export function decodePoolAccount(data: Buffer): RawPoolAccount {
  if (data.length === POOL_V3_LEN) {
    throw new Error(
      `decodePoolAccount: account is at v3 size (${POOL_V3_LEN}). ` +
        `Run migrate_pool_v4 against it before calling this decoder.`,
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
  const isActive: boolean[] = [];
  const virtualBalances: BN[] = [];
  const actualBalances: BN[] = [];
  const protocolFeesOwed: BN[] = [];
  const previousSelloff: BN[] = [];
  const currentSelloff: BN[] = [];
  const windowStartTimestamp: BN[] = [];
  const selloffVbSnapshot: BN[] = [];

  for (let i = 0; i < MAX_TOKENS; i++) {
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
    off += 3; // AssetConfig.reserved[3]

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
  }

  const lookupTable = readPubkey(data, off);
  off += 32;

  // Trailing `reserved[32]` ignored.

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
    tokenMints,
    tokenPrograms,
    normalizedWeights,
    maxSelloffPct,
    maxSelloffPeriodLength,
    variableFeeThresholdPct,
    variableFeeSlopeLowPct,
    variableFeeSlopeHighPct,
    isActive,
    virtualBalances,
    actualBalances,
    protocolFeesOwed,
    previousSelloff,
    currentSelloff,
    windowStartTimestamp,
    selloffVbSnapshot,
    lookupTable,
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
