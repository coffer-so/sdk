import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { TransferFee } from "@solana/spl-token";
import { TokenInfo } from "../config/tokens";
import type { PoolActionKindName } from "../parsers/layout";

/**
 * A single token slot inside a Coffer Pool, enriched with off-chain metadata
 * (ticker, logo, coingeckoId) when available.
 */
export interface PoolTokenInfo {
  index: number;
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  /** Basis points, sum across all tokens == 10_000. */
  weightBps: number;
  /** In native token units (u64). */
  virtualBalance: BN;
  actualBalance: BN;
  protocolFeesOwed: BN;
  /** PDA: ATA(pool, mint, tokenProgram). */
  vault: PublicKey;
  /** Cached off-chain metadata; `undefined` if no registry hit. */
  metadata?: TokenInfo;
  /** factBalance / virtBalance as a float, for display/math. */
  concentration: number;
  /**
   * Per-token input kill switch. When `false`, swaps with THIS token as
   * input revert (`TokenInactive`); it can still be a swap output and
   * liquidity ops are unaffected. Defaults to `true`.
   */
  isActive: boolean;
  /**
   * Max cumulative sell volume per window, as a percent of virtual balance
   * (`PERCENT_SCALE` units; 10_000 = 100%). `0` ⇒ no cap.
   */
  maxSelloffPct: number;
  maxSelloffPeriodLength?: number;
  variableFeeThresholdPct?: number;
  variableFeeSlopeLowPct?: number;
  variableFeeSlopeHighPct?: number;
  previousSelloff?: BN;
  currentSelloff?: BN;
  windowStartTimestamp?: BN;
  selloffVbSnapshot?: BN;
  /**
   * Surge fee at the curve's KINK (`PERCENT_SCALE` units). New in v5.1 —
   * `0` on pools written by the older program.
   */
  variableFeeSlopeMidPct?: number;
  /**
   * Window fill at which the surge curve kinks, in WHOLE PERCENT (0..=100),
   * not `PERCENT_SCALE` units. `0` ⇒ no kink (single straight line, which is
   * how every pre-v5.1 pool behaves). New in v5.1.
   */
  variableFeeKinkPct?: number;
  /**
   * Token-2022 extension discriminants present on this token's mint
   * (`[]` for classic SPL Token mints). See `MintExtension`.
   */
  extensions?: number[];
  /**
   * Subset of `extensions` the v6 program can never move (`NonTransferable`
   * or an extension type newer than the program knows). Non-empty ⇒ every
   * quote / build that touches this token is refused with
   * `unsupported_token_extension`. Transfer fees, hooks and memo
   * requirements are supported and are NOT listed here.
   */
  unsupportedExtensions?: number[];
  /**
   * Token-2022 transfer-fee schedule in force at `PoolInfo.chainEpoch`
   * (`selectEpochFee` of the mint's `TransferFeeConfig`); `null` for mints
   * without the extension. Quotes net this fee on every leg that moves the
   * token: the vault credits `amount − fee` on the way in and the user
   * receives `amount − fee` on the way out.
   */
  transferFee?: TransferFee | null;
  /**
   * Program of an ARMED transfer hook (`TransferHook.program_id`), or
   * `null` when the mint has no hook or the hook is disarmed
   * (`PublicKey.default`). An armed hook needs its extra-account tail
   * resolved before building (`resolve*ExtraAccounts`).
   */
  transferHookProgram?: PublicKey | null;
  /**
   * `true` while the mint's `Pausable` extension is paused. The program
   * refuses every transfer of a paused mint (`UnsupportedExtension`), so
   * quotes and builders that would move this token are refused.
   */
  paused?: boolean;
  /**
   * v6.1 (FIX-6): the decimals the pool PINNED for this slot at creation /
   * layout migration (`token_decimals[i]`). `undefined` on an unmigrated
   * 1683-byte pool. The program refuses a transfer when the live mint
   * disagrees (`PinnedDecimalsMismatch`).
   */
  pinnedDecimals?: number;
  /**
   * v6.1 (FIX-6): the live mint reports different decimals than the pinned
   * value (a closed-and-recreated mint). The program refuses every transfer
   * of this slot (`PinnedDecimalsMismatch`), so the token is listed in
   * `PoolInfo.unsupportedTokenIndices`.
   */
  pinnedDecimalsMismatch?: boolean;
  /**
   * v6.1 (T14): pool admin's unclaimed share of this slot's fees (raw
   * units). Outside the curve and outside LP NAV. `0` before v6.1.
   */
  creatorFeesOwed?: BN;
  /**
   * v6.1 (T12): the LP holders' surge bucket for this slot (raw units).
   * Part of LP NAV (`actualBalance + surgeFeesOwed`), never traded, paid
   * pro rata on `remove_liquidity`, bought into on `add_liquidity`.
   */
  surgeFeesOwed?: BN;
  /**
   * v6.1 (T10): `actualBalance == 0` — the slot is sidelined: swaps INTO it
   * are allowed (they revive it at the curve price), swaps OUT of it revert
   * with `InsufficientLiquidity`, it takes no deposit, pays nothing on
   * withdraw, and only the pool admin can fund it (`fund_sidelined_token`).
   */
  sidelined?: boolean;
}

/** v6.1 (T3): one pending pool-admin action as `PoolInfo` exposes it. */
export interface PendingPoolAction {
  /** Bit index in `pendingActionsMask`; `cancel_pool_action(kind)` argument. */
  kind: number;
  name: PoolActionKindName;
  /** Unix seconds the slot becomes executable; `0` when the slot is empty. */
  eta: BN;
  /** Absolute payload stored in the slot (plain values; hashes as hex). */
  payload: Record<string, string | number | boolean | PublicKey | BN>;
}

/** v6.1 (T9): the pool's native hook as `PoolInfo` exposes it (`null` = no hook). */
export interface PoolHookInfo {
  program: PublicKey;
  /** `coffer_hook_interface::flags` bitmap (see `HOOK_FLAGS`). */
  flags: number;
  /** Protocol-admin emergency switch. */
  disabled: boolean;
  /** `program != default && !disabled`: the remaining-accounts tail of swap / add / seed / remove starts with the hook slice. */
  active: boolean;
  /** Fee-override clamp (hundredths of bps, `SWAP_FEE_PRECISION`). */
  feeMin: number;
  feeMax: number;
  /** Per-callback CU ceiling. */
  maxCu: number;
  /** Length of the hook account slice `[hook_program, hook_caller, extras..]` (2..=12). */
  accountsLen: number;
}

/** v6.1 (T1): in-mint `TokenMetadata` of a Token-2022 LP mint. */
export interface LpMetadata {
  name: string;
  symbol: string;
  uri: string;
  /** The `("pool", <pool pubkey>)` pair and any other additional metadata. */
  additionalMetadata: Array<[string, string]>;
  /** `null` once the authority was revoked (every v6.1 LP mint). */
  updateAuthority: PublicKey | null;
}

/**
 * Parsed operational pool state returned by `CofferPoolClient.sync()`.
 * Padding and unused token slots are available through decodePoolAccount;
 * decodeContractAccount preserves the complete exact ABI shape.
 */
export interface PoolInfo {
  /**
   * Indices of tokens the program cannot transfer right now: a non-empty
   * `unsupportedExtensions`, a paused mint, or the Token-2022 native mint
   * (see `tokenTransferBlockers`). Empty for a pool without
   * runtime-incompatible mints. Swap/add/remove guards check affected
   * transfer legs; the zap builder checks all mints.
   */
  unsupportedTokenIndices?: number[];
  /** Pool PDA address. */
  address: PublicKey;
  /** Pool config account referenced by the pool. */
  config: PublicKey;
  /** `Account<CofferPool>.bump`. */
  bump: number;
  /** Integer identifier salt. Pools under the same config differ by pool_id. */
  poolId: BN;
  tokenCount: number;
  tokens: PoolTokenInfo[];
  lpMint: PublicKey;
  /** Owner program of the LP mint; classic Token for older manually supplied snapshots. */
  lpTokenProgram?: PublicKey;
  poolAdmin?: PublicKey;
  pendingPoolAdmin?: PublicKey;
  rangeManager?: PublicKey;
  rangeManagerEnabled?: boolean;
  rangeManagerMaxVbChangePct?: number;
  rangeManagerMaxWeightChangePct?: number;
  rangeManagerMinUpdateIntervalSecs?: number;
  rangeManagerLastUpdated?: BN;
  /** Solana Clock timestamp at sync, used for time-dependent selloff quotes. */
  chainTimestamp?: number;
  /** Solana Clock slot at sync (`Clock.slot`); the planned zap's `valid_until_slot` counts from it. */
  chainSlot?: number;
  /**
   * Solana Clock epoch at sync (`Clock.epoch`). Transfer-fee schedules are
   * epoch-gated, and the planned zap's state commitment includes the epoch:
   * a plan quoted in one epoch is `AllocationPlanStale` in the next.
   */
  chainEpoch?: number;
  /**
   * `true` once `migrate_to_v5` stamped the `"V5M1"` marker into the
   * account's reserved bytes. A pool created by the v5/v6 program is marked
   * at creation; an unmarked pool still needs the guarded migration before
   * its per-token kill switches and leverage band are trustworthy.
   */
  v5Migrated?: boolean;
  /** Total supply of LP tokens at snapshot time. */
  lpTotalSupply: BN;
  /** Hundredths-of-basis-point units (1_000_000 == 100 %). */
  swapFeeRate: number;
  /** Basis points (10_000 == 100 %). */
  protocolFeeRate: number;
  poolEnabled: boolean;
  swapsEnabled: boolean;
  createdAt: number;
  /**
   * Per-pool Address Lookup Table. `PublicKey.default` ⇒ no ALT provisioned
   * yet (call `initialize_pool_alt` to bootstrap). When set and non-default,
   * v0-tx builders compress per-token accounts via this ALT.
   */
  lookupTable: PublicKey;
  /**
   * Absolute UPPER bound on `virtual_balance / actual_balance` the range
   * manager may leave a token at, in basis points (10_000 = 1.0×). `0` ⇒
   * band disabled. New in v5.1 — `0` on pools written by the older program.
   */
  rangeManagerMaxLeverageBps?: number;
  /**
   * Absolute LOWER bound on the same ratio, same units. `0` ⇒ floor
   * disabled. New in v5.1.
   */
  rangeManagerMinLeverageBps?: number;
  /** Unix timestamp (ms) when sync() ran. Useful for staleness checks. */
  syncedAt: number;

  // ── v6.1 appended state (every field below is 0 / empty / null on an
  // unmigrated 1683-byte pool and `undefined` on a manually supplied v5
  // snapshot; quotes treat `undefined` as the v5 reading) ──────────────────

  /** Account size the snapshot was decoded from: 1683 (unmigrated) or 2304 (v6.1). */
  dataLen?: number;
  /**
   * `CofferPool.layout_version`: `1` on a v6.1 account, `0` on an
   * unmigrated 1683-byte account. While `0` every program instruction fails
   * with `LayoutVersionMismatch` (6070); the transaction builders prepend
   * the permissionless `migrate_pool_layout_v61` (payer = user, rent
   * ≈ 0.0043 SOL) unless told not to.
   */
  layoutVersion?: number;
  /** `layoutVersion === 0`: the pool still needs `migrate_pool_layout_v61`. */
  needsLayoutMigration?: boolean;
  /** FIX-6 decimals pins, `tokenCount` entries; `[]` before v6.1. */
  tokenDecimals?: number[];
  /** v6.1 (T14): pool admin's share of the LP fee remainder, bps (0 = off). */
  creatorFeeBps?: number;
  /** v6.1 (T14): `creator_fees_owed`, `tokenCount` entries (raw units); `[]` before v6.1. */
  creatorFeesOwed?: BN[];
  /** v6.1 (T12): LP-claimable surge bucket per slot, `tokenCount` entries; `[]` before v6.1. */
  surgeFeesOwed?: BN[];
  /** v6.1 (T7): deposit fee bps (LP haircut on `add_liquidity`; the seed is exempt). */
  depositFeeBps?: number;
  /** v6.1 (T7): withdraw fee bps (payout haircut on every leg of `remove_liquidity`). */
  withdrawFeeBps?: number;
  /** v6.1 (T7): raw `liquidity_fee_lock` byte. */
  liquidityFeeLock?: number;
  /** v6.1 (T7): `true` once `lock_liquidity_fees` ran — the two fees can never change. */
  liquidityFeesLocked?: boolean;
  /** v6.1 (T6): `true` ⇒ the pool can never have a range manager again. */
  rangeManagerLocked?: boolean;
  /** v6.1 (T3): pool-admin cooldown in force (seconds; 0 = direct instructions work). */
  poolAdminDelaySecs?: number;
  /** v6.1 (T3): bumped on every pool-admin change; voids every pending slot. */
  poolAdminEpoch?: number;
  /** v6.1 (T3): eta of the pending admin transfer (`pendingPoolAdmin` is the nominee); 0 = none. */
  pendingPoolAdminEta?: BN;
  /** v6.1 (T3): the eleven typed pending slots in kind order; `[]` before v6.1. */
  pendingActions?: PendingPoolAction[];
  /** v6.1 (T3): bit `kind` set ⇔ that slot is live. */
  pendingActionsMask?: number;
  /** v6.1 (T9): the pool's native hook, `null` when none. */
  hook?: PoolHookInfo | null;
  /** v6.1: layout-drift notes from the decoder (empty on a healthy account). */
  layoutDrift?: string[];
  /**
   * v6.1 (T1): in-mint LP metadata (Token-2022 LP mints created since v6.1).
   * `null` for a legacy SPL Token LP mint (older pools) — show a synthetic
   * label. `undefined` when the snapshot did not fetch it.
   */
  lpMetadata?: LpMetadata | null;
}

export interface PoolSummary {
  address: string;
  tvlUsd?: number;
  volume24hUsd?: number;
  feeApr7d?: number;
  poolEnabled: boolean;
  tokens: Array<{ mint: string; symbol?: string; weightBps: number }>;
}
