import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export type CubicPoolEvent =
  | PoolInitializedEvent
  | SwapEvent
  | LiquidityAddedEvent
  | LiquidityRemovedEvent
  | ProtocolFeesCollectedEvent
  | PoolEnabledUpdatedEvent
  | SwapsEnabledUpdatedEvent
  | SingleTokenDepositEvent
  | PoolStateLogEvent
  | MaxSelloffWindowAdvancedEvent
  | UnknownEvent;

export interface PoolInitializedEvent {
  kind: "PoolInitialized";
  pool: PublicKey;
  config: PublicKey;
  tokenCount: number;
  bptMint: PublicKey;
  timestamp: number;
  /**
   * Effective Token-2022 banned-extensions bitmap the pool's tokens were
   * vetted against (creator override, or the config default). Appended in
   * cubic-pool v5 — `null` when decoding pre-v5 historical logs.
   */
  bannedExtensions: BN | null;
}

export interface SwapEvent {
  kind: "Swap";
  pool: PublicKey;
  user: PublicKey;
  tokenIn: PublicKey;
  tokenOut: PublicKey;
  amountIn: BN;
  amountOut: BN;
  feeAmount: BN;
  protocolFeeAmount: BN;
  /**
   * Variable sell-off surge fee taken from the OUTPUT token and routed
   * 100% to the protocol bucket. `0` in the common case, and always `0`
   * when decoding pre-v5 historical logs (the field did not exist).
   * NOTE: `amountOut` is what the user actually received — in v5 it is
   * already NET of this surge fee.
   */
  surgeFeeAmount: BN;
  timestamp: number;
}

export interface LiquidityAddedEvent {
  kind: "LiquidityAdded";
  pool: PublicKey;
  user: PublicKey;
  tokenAmounts: BN[];
  bptAmount: BN;
  timestamp: number;
}

export interface LiquidityRemovedEvent {
  kind: "LiquidityRemoved";
  pool: PublicKey;
  user: PublicKey;
  bptAmount: BN;
  tokenAmounts: BN[];
  timestamp: number;
}

export interface ProtocolFeesCollectedEvent {
  kind: "ProtocolFeesCollected";
  pool: PublicKey;
  authority: PublicKey;
  tokenAmounts: BN[];
  timestamp: number;
}

export interface PoolEnabledUpdatedEvent {
  kind: "PoolEnabledUpdated";
  pool: PublicKey;
  authority: PublicKey;
  oldValue: boolean;
  newValue: boolean;
  timestamp: number;
}

export interface SwapsEnabledUpdatedEvent {
  kind: "SwapsEnabledUpdated";
  pool: PublicKey;
  authority: PublicKey;
  oldValue: boolean;
  newValue: boolean;
  timestamp: number;
}

export interface SingleTokenDepositEvent {
  kind: "SingleTokenDeposit";
  helper: PublicKey;
  pool: PublicKey;
  user: PublicKey;
  tokenInIndex: number;
  amountIn: BN;
  /**
   * Per-leg slippage budget. Removed from the event in stld v5 (legs swap
   * with `min_out = 0`; the final `minimum_bpt_amount` is the only guard) —
   * `null` when decoding v5 logs, set on pre-v5 historical logs.
   */
  slippageHundredthsBps: number | null;
  allocations: BN[];
  depositedAmounts: BN[];
  bptReceived: BN;
  dustRefunded: BN;
  timestamp: number;
}

/**
 * Post-mutation pool state snapshot emitted by `swap`, `add_liquidity` and
 * `remove_liquidity`. Layout is IDENTICAL in v4 and v5 (13 fields).
 *
 * `bptTotalSupply` is the post-tx supply — hardcoded `0` on `swap` (which
 * does not touch supply); read the BPT mint account instead in that case.
 */
export interface PoolStateLogEvent {
  kind: "PoolStateLog";
  pool: PublicKey;
  tokenCount: number;
  tokenMints: PublicKey[];
  normalizedWeights: BN[];
  virtualBalances: BN[];
  actualBalances: BN[];
  bptTotalSupply: BN;
  swapFeeRate: number;
  protocolFeeRate: number;
  protocolFeesOwed: BN[];
  poolEnabled: boolean;
  swapsEnabled: boolean;
  timestamp: number;
}

export interface MaxSelloffWindowAdvancedEvent {
  kind: "MaxSelloffWindowAdvanced";
  pool: PublicKey;
  tokenIndex: number;
  effectiveSelloff: BN;
  /**
   * v5: configured cap as a percent of `vbSnapshot` (`PERCENT_SCALE` units,
   * 10_000 = 100%). `null` when decoding pre-v5 historical logs (v4 stored
   * only the absolute cap).
   */
  maxSelloffPct: BN | null;
  /**
   * Absolute cap for the current window. v5: resolved as
   * `maxSelloffPct × vbSnapshot / PERCENT_SCALE`; v4: the configured value.
   * Window fill % = `effectiveSelloff / maxSelloffCap` — at 1.0 the window
   * is fully consumed.
   */
  maxSelloffCap: BN;
  /**
   * Virtual-balance snapshot the cap was resolved against (taken at window
   * open). `null` on pre-v5 historical logs.
   */
  vbSnapshot: BN | null;
  previousSelloff: BN;
  currentSelloff: BN;
  windowStartTimestamp: number;
  timestamp: number;
}

export interface UnknownEvent {
  kind: "Unknown";
  name: string;
  data: Record<string, unknown>;
}
