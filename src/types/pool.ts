import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
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
}

/**
 * Fully parsed pool state. Returned by `CubicPoolClient.sync()`.
 * All raw on-chain numerics plus a few convenience derivations.
 */
export interface PoolInfo {
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
