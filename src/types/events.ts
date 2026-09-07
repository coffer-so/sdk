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
  | BannedExtensionsUpdatedEvent
  | AdditionalContractEvent
  | UnknownEvent;

export interface PoolInitializedEvent {
  kind: "PoolInitialized";
  pool: PublicKey;
  config: PublicKey;
  tokenCount: number;
  bptMint: PublicKey;
  timestamp: number;
  /**
   * Effective Token-2022 banned-extensions bitmap this pool's tokens were
   * vetted against at creation (creator override OR-ed with the protocol's
   * hard floor, or the parent config's default).
   *
   * Appended to the event in v5.1 — decodes as `0` for logs emitted by an
   * older deployment, which is indistinguishable from a genuinely
   * permissive `0`. Prefer the pool account's `bannedExtensions` field when
   * the distinction matters.
   */
  bannedExtensions: BN;
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
   * 100% to the protocol bucket. `0` in the common case.
   *
   * ⚠ On the wire this field sits AFTER `timestamp`, not before it (see
   * the `Swap` type in the IDL). The ordering here is presentational only.
   */
  surgeFeeAmount: BN;
  timestamp: number;
  /** Legacy compatibility field; the deployed without-SF event omits transfer
   * fees, so this is zero for current events. No transfer-fee support is implied.
   */
  transferFeeIn: BN;
  /** Legacy compatibility field; zero for the deployed without-SF event. */
  transferFeeOut: BN;
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
  /** Per-token share of `amountIn` routed into each internal swap leg. */
  allocations: BN[];
  /** Per-token amounts actually passed to `add_liquidity`. */
  depositedAmounts: BN[];
  bptReceived: BN;
  /**
   * Per-token dust returned to the user after the proportional join,
   * index-aligned with the pool's tokens.
   *
   * ⚠ Was a scalar `u64` before v5.1 — the helper only ever refunded the
   * input token. It now refunds leftovers of every token, so this is a
   * `Vec<u64>` on the wire and a `BN[]` here. Consumers summing "dust" must
   * NOT add these together: each entry is denominated in a different mint.
   */
  dustRefunded: BN[];
  timestamp: number;
}

/**
 * `set_banned_extensions` / `pool_set_banned_extensions` audit trail.
 *
 * `hard*` values are the protocol-level floor a pool creator's per-pool
 * override can never clear (`PermanentDelegate`, `TransferHook`, …); the
 * plain values are the config's default policy for new pools.
 */
export interface BannedExtensionsUpdatedEvent {
  kind: "BannedExtensionsUpdated";
  config: PublicKey;
  authority: PublicKey;
  oldValue: BN;
  newValue: BN;
  timestamp: number;
  /** New in v5.1 — `0` for logs emitted by an older deployment. */
  oldHardValue: BN;
  /** New in v5.1 — `0` for logs emitted by an older deployment. */
  newHardValue: BN;
}

export interface PoolStateLogEvent {
  kind: "PoolStateLog";
  pool: PublicKey;
  virtualBalances: BN[];
  actualBalances: BN[];
  protocolFeesOwed: BN[];
  timestamp: number;
}

export interface MaxSelloffWindowAdvancedEvent {
  kind: "MaxSelloffWindowAdvanced";
  pool: PublicKey;
  tokenIndex: number;
  effectiveSelloff: BN;
  maxSelloffCap: BN;
  vbSnapshot: BN;
  previousSelloff: BN;
  currentSelloff: BN;
  windowStartTimestamp: number;
  timestamp: number;
  /**
   * Window fill % = `effectiveSelloff / maxSelloffCap`. When this ratio
   * reaches 1.0 the sell-off cap for the window is fully consumed.
   */
}

export interface UnknownEvent {
  kind: "Unknown";
  name: string;
  data: Record<string, unknown>;
}

/** Additional current-ABI events, with the camelCase fields used by the legacy
 * event API. Use parseContractEvents for exact IDL names and BN timestamps.
 */
type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<CamelCase<Tail>>}` : S;
type CamelEventData<T> = { [K in keyof T as K extends string ? CamelCase<K> : K]: K extends "timestamp" ? number : T[K] };
type ExistingEventName = "PoolInitialized" | "Swap" | "LiquidityAdded" | "LiquidityRemoved" | "ProtocolFeesCollected" | "PoolEnabledUpdated" | "SwapsEnabledUpdated" | "SingleTokenDeposit" | "PoolStateLog" | "MaxSelloffWindowAdvanced" | "BannedExtensionsUpdated";
export type AdditionalContractEvent = {
  [P in keyof import("./contracts").ContractEventMap]: {
    [E in Exclude<keyof import("./contracts").ContractEventMap[P], ExistingEventName>]:
      { kind: E } & CamelEventData<import("./contracts").ContractEventMap[P][E]>
  }[Exclude<keyof import("./contracts").ContractEventMap[P], ExistingEventName>]
}[keyof import("./contracts").ContractEventMap];
