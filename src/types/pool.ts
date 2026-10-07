import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { TransferFee } from "@solana/spl-token";
import { TokenInfo } from "../config/tokens";

/**
 * A single token slot inside a Cubic Pool, enriched with off-chain metadata
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
}

/**
 * Parsed operational pool state returned by `CubicPoolClient.sync()`.
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
  /** `Account<CubicPool>.bump`. */
  bump: number;
  /** Integer identifier salt. Pools under the same config differ by pool_id. */
  poolId: BN;
  tokenCount: number;
  tokens: PoolTokenInfo[];
  bptMint: PublicKey;
  /** Owner program of the BPT mint; classic Token for older manually supplied snapshots. */
  bptTokenProgram?: PublicKey;
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
  /** Total supply of BPT tokens at snapshot time. */
  bptTotalSupply: BN;
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
   * Effective Token-2022 banned-extensions bitmap this pool's tokens were
   * vetted against at creation. `0` ⇒ nothing banned (permissive — rug risk;
   * surface to users before they deposit).
   */
  bannedExtensions: BN;
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
}

export interface PoolSummary {
  address: string;
  tvlUsd?: number;
  volume24hUsd?: number;
  feeApr7d?: number;
  poolEnabled: boolean;
  tokens: Array<{ mint: string; symbol?: string; weightBps: number }>;
}
