import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export type CofferPoolEvent =
  | PoolInitializedEvent
  | SwapEvent
  | LiquidityAddedEvent
  | LiquidityRemovedEvent
  | ProtocolFeesCollectedEvent
  | PoolEnabledUpdatedEvent
  | SwapsEnabledUpdatedEvent
  | SingleTokenDepositEvent
  | SingleTokenDepositDirectEvent
  | PoolStateLogEvent
  | PoolInfoEvent
  | MaxSelloffWindowAdvancedEvent
  | AdditionalContractEvent
  | UnknownEvent;

export interface PoolInitializedEvent {
  kind: "PoolInitialized";
  pool: PublicKey;
  config: PublicKey;
  tokenCount: number;
  lpMint: PublicKey;
  timestamp: number;
  /**
   * Wire slot of the former `banned_extensions` bitmap. The Token-2022
   * extension policy was removed in v6.1 (T19): a v6.1 program emits `0`
   * here; logs of older deployments carry whatever bitmap they stored. Never
   * interpret it — the frontend discloses mint extensions from the mint TLV.
   */
  deprecatedBannedExtensions: BN;
  /** PDA salt (`pool_id`). Appended in v6; `0` for logs of older deployments. */
  poolId: BN;
  /** v6.1 (T1): immutable LP metadata; `""` on logs of older deployments. */
  lpName: string;
  lpSymbol: string;
  lpUri: string;
  /** v6.1 (T1): owner program of the LP mint (Token-2022 since v6.1); `PublicKey.default` on older logs. */
  lpTokenProgram: PublicKey;
  /** v6.1 (T14): pool admin's share of the LP fee remainder, bps; `0` on older logs. */
  creatorFeeBps: number;
  /** v6.1 (T7): deposit / withdraw fee bps at creation; `0` on older logs. */
  depositFeeBps: number;
  withdrawFeeBps: number;
  /** v6.1 (T9): the hook block (`PublicKey.default` / zeros = no hook, and on older logs). */
  hookProgram: PublicKey;
  hookFlags: number;
  hookFeeMin: number;
  hookFeeMax: number;
  hookMaxCu: number;
  hookAccountsLen: number;
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
  /**
   * Token-2022 transfer fee withheld on the INPUT leg: the vault received
   * `amountIn − transferFeeIn`. Appended in v6; `0` for classic mints and
   * for logs emitted by a v5 deployment.
   */
  transferFeeIn: BN;
  /**
   * Token-2022 transfer fee withheld on the OUTPUT leg: the user received
   * `amountOut − transferFeeOut` (`amountOut` is the vault debit, net of
   * surge, gross of this fee).
   */
  transferFeeOut: BN;
  /** v6.1 (T15): the pool's base swap fee rate in force (hundredths of bps); `0` on pre-v6.1 logs. */
  swapFeeRate: number;
  /** v6.1 (T15): protocol share in force (bps). */
  protocolFeeRate: number;
  /** v6.1 (T15): protocol share of the surge fee (`ceil(surge · rate)`), booked on the OUTPUT slot. */
  surgeProtocolFeeAmount: BN;
  /** v6.1 (T14): creator share of the base fee (input slot) / of the surge (output slot). */
  creatorFeeAmount: BN;
  surgeCreatorFeeAmount: BN;
  /** v6.1 (T14): creator share in force (bps of the LP remainder). */
  creatorFeeBps: number;
  /** v6.1 (T12): LP share of the surge, booked into `surge_fees_owed[out]` (not the reserves). */
  surgeFeeLpAmount: BN;
  /**
   * v6.1 (T9): the swap fee rate actually applied — a hook override clamped
   * into `[hook_fee_min, hook_fee_max]`, else `swapFeeRate`. Equals
   * `swapFeeRate` on pre-v6.1 logs.
   */
  effectiveFeeRate: number;
  /** `true` when every v6.1 tail field was present in the log (false ⇒ pre-upgrade log, tails are defaults). */
  v61Tail: boolean;
}

export interface LiquidityAddedEvent {
  kind: "LiquidityAdded";
  pool: PublicKey;
  user: PublicKey;
  /** Gross per-token debits (ceilings cropped to the basket, T22 fee included). */
  tokenAmounts: BN[];
  /** LP minted — NET of the deposit fee since v6.1 (T7). */
  lpAmount: BN;
  timestamp: number;
  /** v6.1 (T2): `true` for `seed_liquidity`. */
  isSeed: boolean;
  /** v6.1 (T2): per-token credit the pool booked (`actual_in + surge_buy_in`); `[]` on older logs. */
  creditedAmounts: BN[];
  lpSupplyBefore: BN;
  lpSupplyAfter: BN;
  /** v6.1 (T2): the creator-chosen seed supply (`lp_amount` on a seed, `0` otherwise). */
  initialLpSupply: BN;
  /** v6.1 (T7): LP withheld by the deposit fee (`lp_gross − lpAmount`). */
  depositFeeLp: BN;
  depositFeeBps: number;
  /** v6.1 (T12): per-token part of the credit that went into the surge bucket (buy-in). */
  surgeBuyIn: BN[];
  v61Tail: boolean;
}

export interface LiquidityRemovedEvent {
  kind: "LiquidityRemoved";
  pool: PublicKey;
  user: PublicKey;
  /** LP burned (after the `MIN_LP_SUPPLY` clamp). */
  lpAmount: BN;
  /** Per-token NET reserve payout (`actual_balance` delta); the surge part is in `surgeAmounts`. */
  tokenAmounts: BN[];
  timestamp: number;
  /** v6.1 (T7): per-token withdraw fee withheld (reserve part + bucket part). */
  withdrawFeeAmounts: BN[];
  withdrawFeeBps: number;
  lpSupplyBefore: BN;
  lpSupplyAfter: BN;
  /** v6.1 (T12): per-token surge-bucket payout (paid in the same transfer as `tokenAmounts[i]`). */
  surgeAmounts: BN[];
  v61Tail: boolean;
}

export interface ProtocolFeesCollectedEvent {
  kind: "ProtocolFeesCollected";
  pool: PublicKey;
  authority: PublicKey;
  tokenAmounts: BN[];
  timestamp: number;
  /** v6.1 (T5): the recipient of every paid slot (Treasury vault PDAs); `[]` on older logs. */
  recipients: PublicKey[];
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
  lpReceived: BN;
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
 * v6 planned single-token deposit receipt (`deposit_single_token_planned`).
 * Swaps and the join run with the user's own token accounts, so there is
 * no helper and no refund: `dustRemaining` is what this zap left unspent
 * in the user's accounts (prior balances excluded).
 */
export interface SingleTokenDepositDirectEvent {
  kind: "SingleTokenDepositDirect";
  pool: PublicKey;
  user: PublicKey;
  tokenInIndex: number;
  /** Gross input the user signed for (the plan's allocations sum to it). */
  amountIn: BN;
  /** The plan: gross input spent on each swap leg; the input slot is the amount reserved for the join. */
  allocations: BN[];
  /** Measured per-token debits of the join (after the pool's own crop). */
  depositedAmounts: BN[];
  lpReceived: BN;
  /** Per-token unspent budget left in the user's accounts; each entry is in a different mint. */
  dustRemaining: BN[];
  timestamp: number;
}

export interface PoolStateLogEvent {
  kind: "PoolStateLog";
  pool: PublicKey;
  virtualBalances: BN[];
  actualBalances: BN[];
  protocolFeesOwed: BN[];
  timestamp: number;
  /** v6.1 (T14) */
  creatorFeesOwed: BN[];
  /** v6.1 (T7) */
  depositFeeBps: number;
  withdrawFeeBps: number;
  liquidityFeeLock: number;
  /** v6.1 (T12) */
  surgeFeesOwed: BN[];
  /** v6.1 (T3) */
  poolAdminDelaySecs: number;
  poolAdminEpoch: number;
  pendingActionsMask: number;
  v61Tail: boolean;
}

/** `get_pool_info` read-only event (v6.1 tails appended; defaults on pre-upgrade logs). */
export interface PoolInfoEvent {
  kind: "PoolInfo";
  pool: PublicKey;
  config: PublicKey;
  lpMint: PublicKey;
  tokenCount: number;
  poolId: BN;
  tokens: PublicKey[];
  tokenVaults: PublicKey[];
  normalizedWeights: BN[];
  virtualBalances: BN[];
  actualBalances: BN[];
  protocolFeesOwed: BN[];
  swapFeeRate: number;
  protocolFeeRate: number;
  poolEnabled: boolean;
  swapsEnabled: boolean;
  tokenPrograms: PublicKey[];
  timestamp: number;
  creatorFeeBps: number;
  creatorFeesOwed: BN[];
  rangeManagerLocked: boolean;
  depositFeeBps: number;
  withdrawFeeBps: number;
  liquidityFeeLock: number;
  surgeFeesOwed: BN[];
  poolAdminDelaySecs: number;
  poolAdminEpoch: number;
  pendingActionsMask: number;
  /** The eleven slot etas in kind order (`[]` on older logs). */
  pendingEtas: BN[];
  hookProgram: PublicKey;
  hookFlags: number;
  hookDisabled: number;
  hookFeeMin: number;
  hookFeeMax: number;
  hookMaxCu: number;
  hookAccountsLen: number;
  v61Tail: boolean;
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
/** The cooldown events' `kind: u8` data field is exposed as `actionKind` (the event discriminator keeps `kind`). */
type CamelEventData<T> = { [K in keyof T as K extends "kind" ? "actionKind" : K extends string ? CamelCase<K> : K]: K extends "timestamp" ? number : T[K] };
type ExistingEventName = "PoolInitialized" | "Swap" | "LiquidityAdded" | "LiquidityRemoved" | "ProtocolFeesCollected" | "PoolEnabledUpdated" | "SwapsEnabledUpdated" | "SingleTokenDeposit" | "SingleTokenDepositDirect" | "PoolStateLog" | "PoolInfo" | "MaxSelloffWindowAdvanced";
export type AdditionalContractEvent = {
  [P in keyof import("./contracts").ContractEventMap]: {
    [E in Exclude<keyof import("./contracts").ContractEventMap[P], ExistingEventName>]:
      { kind: E } & CamelEventData<import("./contracts").ContractEventMap[P][E]>
  }[Exclude<keyof import("./contracts").ContractEventMap[P], ExistingEventName>]
}[keyof import("./contracts").ContractEventMap];
