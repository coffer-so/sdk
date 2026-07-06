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
  slippageHundredthsBps: number;
  allocations: BN[];
  depositedAmounts: BN[];
  bptReceived: BN;
  dustRefunded: BN;
  timestamp: number;
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
