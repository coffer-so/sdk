/**
 * Byte layout of the v6.1 on-chain accounts, mirrored from
 * `contracts/scripts/cli/config.ts` (`POOL_LAYOUT`, `TOKEN_SLOT_LAYOUT`,
 * `TREASURY_LAYOUT`) and `programs/coffer-pool/src/state/coffer_pool.rs`.
 *
 * Every offset counts from the start of the account (8-byte discriminator
 * included). The v4/v5 `CofferPool` (1683 bytes) is the PREFIX of the v6.1
 * account (2304 bytes): `migrate_pool_layout_v61` grows the account in
 * place and appends the block that starts at `LAYOUT_VERSION`; no
 * pre-existing field moved. The same holds for `Treasury` (786 → 818 → 1624).
 *
 * The decoders (`poolAccount.ts`, `treasuryAccount.ts`) self-check against
 * these numbers so a layout drift fails loudly instead of sliding fields.
 */

// ── CofferPool ───────────────────────────────────────────────────────────────

/** Current (v6.1) `CofferPool` account size. */
export const POOL_LEN_V61 = 2304;
/** Pre-v6.1 (v4/v5) size: the layout migration's input; read-only for the v6.1 program. */
export const POOL_LEN_V5 = 1683;
/** Legacy v3 parallel-array layout; dead pools only, never decodable here. */
export const POOL_LEN_V3 = 1154;
/** Sizes the pool decoder accepts. */
export const POOL_DECODABLE_LENS: readonly number[] = [POOL_LEN_V5, POOL_LEN_V61];
/** `CofferPool::LAYOUT_VERSION_V61` — the byte at `POOL_LAYOUT.LAYOUT_VERSION` on a v6.1 account. */
export const POOL_LAYOUT_VERSION_V61 = 1;
export const MAX_TOKENS = 10;
export const ASSET_CONFIG_LEN = 88;
export const ASSET_DYNAMICS_LEN = 56;
export const TOKEN_SLOT_LEN = ASSET_CONFIG_LEN + ASSET_DYNAMICS_LEN; // 144

export interface LayoutField { readonly offset: number; readonly size: number }

export const POOL_LAYOUT = {
  DISCRIMINATOR:                    { offset: 0,    size: 8 },
  CONFIG:                           { offset: 8,    size: 32 },
  BUMP:                             { offset: 40,   size: 1 },
  TOKEN_COUNT:                      { offset: 41,   size: 1 },
  POOL_ID:                          { offset: 42,   size: 8 },
  SWAP_FEE_RATE:                    { offset: 50,   size: 4 },
  PROTOCOL_FEE_RATE:                { offset: 54,   size: 2 },
  CREATED_AT:                       { offset: 56,   size: 8 },
  POOL_ENABLED:                     { offset: 64,   size: 1 },
  SWAPS_ENABLED:                    { offset: 65,   size: 1 },
  POOL_ADMIN:                       { offset: 66,   size: 32 },
  PENDING_POOL_ADMIN:               { offset: 98,   size: 32 },
  RANGE_MANAGER:                    { offset: 130,  size: 32 },
  RANGE_MANAGER_ENABLED:            { offset: 162,  size: 1 },
  RANGE_MANAGER_MAX_VB_CHANGE_PCT:  { offset: 163,  size: 2 },
  RANGE_MANAGER_MAX_WEIGHT_CHANGE_PCT: { offset: 165, size: 2 },
  RANGE_MANAGER_MIN_UPDATE_INTERVAL_SECS: { offset: 167, size: 4 },
  RANGE_MANAGER_LAST_UPDATED:       { offset: 171,  size: 8 },
  TOKENS:                           { offset: 179,  size: 1440 },
  LOOKUP_TABLE:                     { offset: 1619, size: 32 },
  DEPRECATED_BANNED_EXTENSIONS:     { offset: 1651, size: 8 },
  RANGE_MANAGER_MAX_LEVERAGE_BPS:   { offset: 1659, size: 4 },
  RANGE_MANAGER_MIN_LEVERAGE_BPS:   { offset: 1663, size: 4 },
  /** Legacy block, frozen since v6.1: `V5M1` marker in the first 4 bytes. */
  RESERVED:                         { offset: 1667, size: 16 },
  TOTAL_V5:                         1683,
  // ── v6.1 (L0) appended block ──
  LAYOUT_VERSION:                   { offset: 1683, size: 1 },
  TOKEN_DECIMALS:                   { offset: 1684, size: 10 },
  // ── v6.1 (T14) creator fee ──
  CREATOR_FEE_BPS:                  { offset: 1694, size: 2 },
  CREATOR_FEES_OWED:                { offset: 1696, size: 80 },
  // ── v6.1 (T12) LP-claimable surge bucket ──
  SURGE_FEES_OWED:                  { offset: 1776, size: 80 },
  // ── v6.1 (T7) liquidity fees ──
  DEPOSIT_FEE_BPS:                  { offset: 1856, size: 2 },
  WITHDRAW_FEE_BPS:                 { offset: 1858, size: 2 },
  LIQUIDITY_FEE_LOCK:               { offset: 1860, size: 1 },
  // ── v6.1 (T6) ──
  RANGE_MANAGER_LOCKED:             { offset: 1861, size: 1 },
  // ── v6.1 (T3) pool-admin cooldown block (192 B); every slot = `eta: i64` + payload ──
  POOL_ADMIN_DELAY_SECS:            { offset: 1862, size: 4 },
  POOL_ADMIN_EPOCH:                 { offset: 1866, size: 4 },
  PENDING_POOL_ADMIN_ETA:           { offset: 1870, size: 8 },
  PENDING_SET_DELAY:                { offset: 1878, size: 12 },
  PENDING_SET_SWAP_FEE_RATE:        { offset: 1890, size: 12 },
  PENDING_SET_CREATOR_FEE_BPS:      { offset: 1902, size: 10 },
  PENDING_SET_LIQUIDITY_FEES:       { offset: 1912, size: 12 },
  PENDING_LOCK_LIQUIDITY_FEES:      { offset: 1924, size: 8 },
  PENDING_LOCK_RANGE_MANAGER:       { offset: 1932, size: 8 },
  PENDING_SET_RANGE_MANAGER:        { offset: 1940, size: 41 },
  PENDING_SET_RANGE_MANAGER_CONFIG: { offset: 1981, size: 24 },
  PENDING_SET_MAX_SELLOFF:          { offset: 2005, size: 40 },
  PENDING_SET_TOKEN_ACTIVE:         { offset: 2045, size: 9 },
  // ── v6.1 (T9) native hook block (48 B) ──
  HOOK_PROGRAM:                     { offset: 2054, size: 32 },
  HOOK_FLAGS:                       { offset: 2086, size: 2 },
  HOOK_DISABLED:                    { offset: 2088, size: 1 },
  HOOK_FEE_MIN:                     { offset: 2089, size: 4 },
  HOOK_FEE_MAX:                     { offset: 2093, size: 4 },
  HOOK_MAX_CU:                      { offset: 2097, size: 4 },
  HOOK_ACCOUNTS_LEN:                { offset: 2101, size: 1 },
  /** Zero on every v6.1 account; T2/T10's 2 B are the only remaining planned carve. */
  RESERVED_V61:                     { offset: 2102, size: 202 },
  TOTAL:                            2304,
} as const;

/** Offsets inside one 144-byte `TokenSlot` (slot i starts at `POOL_LAYOUT.TOKENS.offset + i * 144`). */
export const TOKEN_SLOT_LAYOUT = {
  MINT:                             { offset: 0,   size: 32 },
  TOKEN_PROGRAM:                    { offset: 32,  size: 32 },
  NORMALIZED_WEIGHT:                { offset: 64,  size: 8 },
  MAX_SELLOFF_PCT:                  { offset: 72,  size: 2 },
  MAX_SELLOFF_PERIOD_LENGTH:        { offset: 74,  size: 4 },
  VARIABLE_FEE_THRESHOLD_PCT:       { offset: 78,  size: 2 },
  VARIABLE_FEE_SLOPE_LOW_PCT:       { offset: 80,  size: 2 },
  VARIABLE_FEE_SLOPE_HIGH_PCT:      { offset: 82,  size: 2 },
  IS_ACTIVE:                        { offset: 84,  size: 1 },
  VARIABLE_FEE_SLOPE_MID_PCT:       { offset: 85,  size: 2 },
  VARIABLE_FEE_KINK_PCT:            { offset: 87,  size: 1 },
  VIRTUAL_BALANCE:                  { offset: 88,  size: 8 },
  ACTUAL_BALANCE:                   { offset: 96,  size: 8 },
  PROTOCOL_FEES_OWED:               { offset: 104, size: 8 },
  PREVIOUS_SELLOFF:                 { offset: 112, size: 8 },
  CURRENT_SELLOFF:                  { offset: 120, size: 8 },
  WINDOW_START_TIMESTAMP:           { offset: 128, size: 8 },
  SELLOFF_VB_SNAPSHOT:              { offset: 136, size: 8 },
  TOTAL:                            144,
} as const;

/**
 * Pool-admin pending-slot kinds (v6.1 T3): the bit index of
 * `pending_actions_mask`, the `cancel_pool_action(kind)` argument and the
 * `PoolActionProposed.kind` value. Kind 0 is the admin transfer; kinds 1..10
 * map to the `PoolAction` enum variants in order (`tag = kind − 1`).
 */
export const POOL_ACTION_KINDS = [
  "TransferPoolAdmin", "SetDelay", "SetSwapFeeRate", "SetCreatorFeeBps", "SetLiquidityFees", "LockLiquidityFees",
  "LockRangeManager", "SetRangeManager", "SetRangeManagerConfig", "SetMaxSelloff", "SetTokenActive",
] as const;
export type PoolActionKindName = (typeof POOL_ACTION_KINDS)[number];
export const POOL_ACTION_KIND = Object.fromEntries(POOL_ACTION_KINDS.map((n, i) => [n, i])) as Record<PoolActionKindName, number>;

/** Protocol-admin (Treasury) pending-slot kinds (`cancel_action(kind)`; `ProtocolAction` tag = kind − 1). */
export const PROTOCOL_ACTION_KINDS = [
  "TransferAdmin", "SetDelay", "SetSupervisor", "Withdraw", "WithdrawSol", "PoolDebugWithdraw", "PoolSetProtocolFeeRate",
  "PoolSetPoolEnabled", "PoolSetTokenActive", "UnfreezePools", "PoolProtocolAdminTransfer", "UpgradeProgram", "ProgramOp",
] as const;
export type ProtocolActionKindName = (typeof PROTOCOL_ACTION_KINDS)[number];
export const PROTOCOL_ACTION_KIND = Object.fromEntries(PROTOCOL_ACTION_KINDS.map((n, i) => [n, i])) as Record<ProtocolActionKindName, number>;

// ── Treasury (protocol_admin) ────────────────────────────────────────────────

export const TREASURY_LEN_V1 = 786;
export const TREASURY_LEN_V2 = 818;
/** v3 (v6.1 T3): the cooldown block is appended after `supervisor`. */
export const TREASURY_LEN_V3 = 1624;
export const TREASURY_DECODABLE_LENS: readonly number[] = [TREASURY_LEN_V1, TREASURY_LEN_V2, TREASURY_LEN_V3];
export const TREASURY_MAX_TOKENS = 10;

export const TREASURY_LAYOUT = {
  DISCRIMINATOR:   { offset: 0,   size: 8 },
  ADMIN:           { offset: 8,   size: 32 },
  PENDING_ADMIN:   { offset: 40,  size: 32 },
  BUMP:            { offset: 72,  size: 1 },
  TOKEN_COUNT:     { offset: 73,  size: 1 },
  TOKEN_MINTS:     { offset: 74,  size: 320 },
  TOKEN_VAULTS:    { offset: 394, size: 320 },
  CREATED_AT:      { offset: 714, size: 8 },
  RESERVED:        { offset: 722, size: 64 },
  SUPERVISOR:      { offset: 786, size: 32 },
  // ── v6.1 (T3) protocol-admin cooldown block (v3 only) ──
  DELAY_SECS:                            { offset: 818,  size: 4 },
  ADMIN_EPOCH:                           { offset: 822,  size: 4 },
  PENDING_ADMIN_ETA:                     { offset: 826,  size: 8 },
  PENDING_SET_DELAY:                     { offset: 834,  size: 12 },
  PENDING_SET_SUPERVISOR:                { offset: 846,  size: 40 },
  PENDING_WITHDRAW:                      { offset: 886,  size: 80 },
  PENDING_WITHDRAW_SOL:                  { offset: 966,  size: 81 },
  PENDING_POOL_DEBUG_WITHDRAW:           { offset: 1047, size: 72 },
  PENDING_POOL_SET_PROTOCOL_FEE_RATE:    { offset: 1119, size: 42 },
  PENDING_POOL_SET_POOL_ENABLED:         { offset: 1161, size: 40 },
  PENDING_POOL_SET_TOKEN_ACTIVE:         { offset: 1201, size: 41 },
  PENDING_UNFREEZE_POOLS:                { offset: 1242, size: 40 },
  PENDING_POOL_PROTOCOL_ADMIN_TRANSFER:  { offset: 1282, size: 72 },
  PENDING_UPGRADE_PROGRAM:               { offset: 1354, size: 72 },
  PENDING_PROGRAM_OP:                    { offset: 1426, size: 73 },
  RESERVED_V61:                          { offset: 1499, size: 125 },
  TOTAL:           1624,
  TOTAL_V2:        818,
  TOTAL_V1:        786,
} as const;

// ── Cooldown (both scopes) ───────────────────────────────────────────────────

/** Upper bound of either scope's delay (30 days). */
export const MAX_DELAY_SECS = 30 * 86_400;
/** Execute window after a slot's eta (14 days); afterwards the slot is `expired` (cancel / re-propose). */
export const GRACE_PERIOD_SECS = 14 * 86_400;

/**
 * Status of a pending slot at the CHAIN clock `now` (Clock sysvar seconds,
 * never browser time): `none` (empty), `waiting` (before eta), `ready`
 * (executable), `expired` (past eta + grace).
 */
export type PendingStatus = "none" | "waiting" | "ready" | "expired";
export function pendingStatus(eta: bigint | number, now: bigint | number, graceSecs: bigint | number = GRACE_PERIOD_SECS): PendingStatus {
  // `BigInt(1.5)` throws RangeError (a fractional clock is a caller bug); a
  // negative `now` sorts before every ETA and therefore reads "waiting",
  // never "ready".
  const e = BigInt(eta), n = BigInt(now), g = BigInt(graceSecs);
  if (e === 0n) return "none";
  if (n < e) return "waiting";
  if (n > e + g) return "expired";
  return "ready";
}
