/**
 * v6.1 (T11) event shapes — the camelCase API of `parseCofferPoolEvents`.
 *
 * Every payload that changed since the v6 wire was RE-CUT under a new name
 * (`…V2`, `PoolMigrationV5Applied`) and a new discriminator; nothing is
 * appended under an old discriminator any more, so the decoders are strict
 * (a truncated payload is `Unknown`, never a half value). The legacy
 * discriminators (`Swap`, `LiquidityAdded`, `PoolStateLog`, …) do not
 * decode on the v6.1 IDL: they surface as `Unknown` with `data.legacy`.
 *
 * Vectors are `token_count` long in pool order; amounts are raw `u64` (`BN`);
 * `timestamp` is the Clock second (`number`); rates: `swapFeeRate` /
 * `effectiveFeeRate` hundredths of bps, `protocolFeeRate` bps of the fee,
 * `*Bps` bps.
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { SelloffParams } from "./tx";

/** `actor_kind: u8` on instructions more than one signer class may call. */
export const ACTOR_KINDS = ["USER", "POOL_ADMIN", "PROTOCOL_ADMIN", "SUPERVISOR", "RANGE_MANAGER"] as const;
export type ActorKindName = (typeof ACTOR_KINDS)[number];
export const ACTOR_KIND = { USER: 0, POOL_ADMIN: 1, PROTOCOL_ADMIN: 2, SUPERVISOR: 3, RANGE_MANAGER: 4 } as const satisfies Record<ActorKindName, number>;

/** Name of an `actor_kind` value (`"UNKNOWN(n)"` for a value the SDK does not know). */
export function actorKindName(kind: number): ActorKindName | `UNKNOWN(${number})` {
  return ACTOR_KINDS[kind] ?? `UNKNOWN(${kind})`;
}

/** `SlotState`: one slot's full dynamics (`vault_i = actual + protocol + creator + surge`). */
export interface SlotState {
  virtualBalance: BN;
  actualBalance: BN;
  protocolFeesOwed: BN;
  creatorFeesOwed: BN;
  surgeFeesOwed: BN;
}

/** `SelloffWindow`: the out-token's sell-off window after a swap (`SwapV2.selloffWindow`, only when the token is capped). */
export interface SelloffWindowState {
  /** Window fill before this swap. */
  effectiveSelloffBefore: BN;
  effectiveSelloff: BN;
  maxSelloffCap: BN;
  vbSnapshot: BN;
  previousSelloff: BN;
  currentSelloff: BN;
  windowStartTimestamp: number;
}

export type CofferPoolEvent =
  | SwapV2Event
  | LiquidityAddedV2Event
  | LiquidityRemovedV2Event
  | PoolInitializedV2Event
  | PoolInfoV2Event
  | ProtocolFeesCollectedV2Event
  | CreatorFeesClaimedV2Event
  | SidelinedTokenFundedEvent
  | VirtualBalancesRescaledEvent
  | HookInvokedEvent
  | HookDisabledSetEvent
  | PoolEnabledUpdatedEvent
  | SwapsEnabledUpdatedV2Event
  | TokenActiveSetV2Event
  | RangeManagerUpdatedV2Event
  | MaxSelloffSetV2Event
  | SingleTokenDepositDirectV2Event
  | AdditionalContractEvent
  | UnknownEvent;

/** `swap` — the one event of a swap; carries the two touched slots before / after. */
export interface SwapV2Event {
  kind: "SwapV2";
  pool: PublicKey;
  user: PublicKey;
  /** Token identity is by index: `PoolInitializedV2.mints[i]` or the pool account. */
  tokenInIndex: number;
  tokenOutIndex: number;
  /** Gross input the user signed for. */
  amountIn: BN;
  /** Token-2022 transfer fee withheld on the input leg (`0` for classic mints). */
  transferFeeIn: BN;
  /** `amountIn − transferFeeIn`: what the vault received and the cascade ran on. */
  amountInNet: BN;
  /** Pool's configured base rate (hundredths of bps). */
  swapFeeRate: number;
  /** Rate actually applied: a `DYNAMIC_FEE` hook override clamped into `[hook_fee_min, hook_fee_max]`, else `swapFeeRate`. */
  effectiveFeeRate: number;
  /** Protocol share in force (bps of the fee). */
  protocolFeeRate: number;
  /** Creator share in force (bps of the LP remainder). */
  creatorFeeBps: number;
  /** Base swap fee on the input leg (`ceil(amountInNet · effectiveFeeRate)`). */
  feeAmount: BN;
  protocolFeeAmount: BN;
  creatorFeeAmount: BN;
  /** Curve output before the surge fee. */
  amountOutGross: BN;
  /** Surge fee taken from the output leg; LP share = `surgeFeeAmount − surgeProtocolFeeAmount − surgeCreatorFeeAmount`. */
  surgeFeeAmount: BN;
  surgeProtocolFeeAmount: BN;
  surgeCreatorFeeAmount: BN;
  /** Vault debit (`amountOutGross − surgeFeeAmount`); the user receives `amountOut − transferFeeOut`. */
  amountOut: BN;
  transferFeeOut: BN;
  inBefore: SlotState;
  inAfter: SlotState;
  outBefore: SlotState;
  outAfter: SlotState;
  timestamp: number;
  /** The out-token's window after the swap; `null` unless that token is capped. */
  selloffWindow: SelloffWindowState | null;
}

/** `seed_liquidity` / `add_liquidity`. */
export interface LiquidityAddedV2Event {
  kind: "LiquidityAddedV2";
  pool: PublicKey;
  user: PublicKey;
  isSeed: boolean;
  /** Charged per token (gross, incl. the Token-2022 transfer fee). */
  tokenAmounts: BN[];
  /** Net credited per token: `Δactual_i + Δsurge_i`. */
  creditedAmounts: BN[];
  /** Bucket share of the credit (`0` when the bucket is empty). */
  surgeBuyIn: BN[];
  /** LP minted, net of the deposit fee. */
  lpAmount: BN;
  /** LP withheld by the deposit fee (simply not minted). */
  depositFeeLp: BN;
  /** Rate applied (`0` on the fee-exempt seed). */
  depositFeeBps: number;
  lpSupplyBefore: BN;
  /** `lpSupplyBefore + lpAmount`. */
  lpSupplyAfter: BN;
  virtualBalancesBefore: BN[];
  virtualBalancesAfter: BN[];
  actualBalancesBefore: BN[];
  actualBalancesAfter: BN[];
  surgeFeesOwedBefore: BN[];
  surgeFeesOwedAfter: BN[];
  timestamp: number;
}

/** `remove_liquidity` / `remove_liquidity_bypass_hooks`. */
export interface LiquidityRemovedV2Event {
  kind: "LiquidityRemovedV2";
  pool: PublicKey;
  user: PublicKey;
  requestedLp: BN;
  /** Effective burn (`≤ requestedLp`, `MIN_LP_SUPPLY` clamp). */
  lpAmount: BN;
  /** Reserve part of the vault debit per slot (leaves `actual`). */
  tokenAmounts: BN[];
  /** Bucket part of the vault debit per slot (leaves `surge_fees_owed`). */
  surgeAmounts: BN[];
  /** Withheld by the withdraw fee (stays in the pool). */
  withdrawFeeAmounts: BN[];
  withdrawFeeBps: number;
  /** Token-2022 transfer fee per leg; the user receives `tokenAmounts_i + surgeAmounts_i − transferFeesOut_i`. */
  transferFeesOut: BN[];
  /** `true` on `remove_liquidity_bypass_hooks` (no `HookInvoked`). */
  hooksBypassed: boolean;
  lpSupplyBefore: BN;
  /** `lpSupplyBefore − lpAmount`. */
  lpSupplyAfter: BN;
  virtualBalancesBefore: BN[];
  virtualBalancesAfter: BN[];
  actualBalancesBefore: BN[];
  actualBalancesAfter: BN[];
  surgeFeesOwedBefore: BN[];
  surgeFeesOwedAfter: BN[];
  timestamp: number;
}

/** `initialize_pool` — the creation record (the account after init). */
export interface PoolInitializedV2Event {
  kind: "PoolInitializedV2";
  pool: PublicKey;
  config: PublicKey;
  poolId: BN;
  poolAdmin: PublicKey;
  lpMint: PublicKey;
  lpTokenProgram: PublicKey;
  tokenCount: number;
  mints: PublicKey[];
  tokenPrograms: PublicKey[];
  /** Pinned decimals per slot (`bytes` on the wire). */
  decimals: number[];
  normalizedWeights: BN[];
  initialVirtualBalances: BN[];
  swapFeeRate: number;
  protocolFeeRate: number;
  creatorFeeBps: number;
  depositFeeBps: number;
  withdrawFeeBps: number;
  lpName: string;
  lpSymbol: string;
  lpUri: string;
  /** Hook block (`PublicKey.default` / zeros = no hook). */
  hookProgram: PublicKey;
  hookFlags: number;
  hookFeeMin: number;
  hookFeeMax: number;
  hookMaxCu: number;
  hookAccountsLen: number;
  timestamp: number;
}

/** `get_pool_info` (simulate-only view, never indexed). */
export interface PoolInfoV2Event {
  kind: "PoolInfoV2";
  pool: PublicKey;
  config: PublicKey;
  poolId: BN;
  layoutVersion: number;
  poolAdmin: PublicKey;
  pendingPoolAdmin: PublicKey;
  pendingPoolAdminEta: BN;
  lpMint: PublicKey;
  tokenCount: number;
  tokens: PublicKey[];
  tokenVaults: PublicKey[];
  tokenPrograms: PublicKey[];
  decimals: number[];
  normalizedWeights: BN[];
  virtualBalances: BN[];
  actualBalances: BN[];
  protocolFeesOwed: BN[];
  creatorFeesOwed: BN[];
  surgeFeesOwed: BN[];
  isActive: boolean[];
  selloffPolicy: SelloffParams[];
  swapFeeRate: number;
  protocolFeeRate: number;
  creatorFeeBps: number;
  depositFeeBps: number;
  withdrawFeeBps: number;
  liquidityFeeLock: number;
  poolEnabled: boolean;
  swapsEnabled: boolean;
  rangeManager: PublicKey;
  rangeManagerEnabled: boolean;
  rangeManagerLocked: boolean;
  rangeManagerMaxVbChangePct: number;
  rangeManagerMaxWeightChangePct: number;
  rangeManagerMinUpdateIntervalSecs: number;
  rangeManagerMaxLeverageBps: number;
  rangeManagerMinLeverageBps: number;
  rangeManagerLastUpdated: BN;
  lookupTable: PublicKey;
  poolAdminDelaySecs: number;
  poolAdminEpoch: number;
  pendingActionsMask: number;
  /** The eleven slot etas in kind order. */
  pendingEtas: BN[];
  hookProgram: PublicKey;
  hookFlags: number;
  hookDisabled: number;
  hookFeeMin: number;
  hookFeeMax: number;
  hookMaxCu: number;
  hookAccountsLen: number;
  timestamp: number;
}

/** `collect_protocol_fees`: `tokenAmounts_i` = `protocol_fees_owed_i` before (after = 0); `recipients_i` = paid account or `PublicKey.default`. */
export interface ProtocolFeesCollectedV2Event {
  kind: "ProtocolFeesCollectedV2";
  pool: PublicKey;
  authority: PublicKey;
  tokenAmounts: BN[];
  recipients: PublicKey[];
  timestamp: number;
}

/** `claim_creator_fees`: same shape as `ProtocolFeesCollectedV2` over `creator_fees_owed`. */
export interface CreatorFeesClaimedV2Event {
  kind: "CreatorFeesClaimedV2";
  pool: PublicKey;
  authority: PublicKey;
  tokenAmounts: BN[];
  recipients: PublicKey[];
  timestamp: number;
}

/** `fund_sidelined_token` (T10): one slot's `actual: 0 → actualAfter`. */
export interface SidelinedTokenFundedEvent {
  kind: "SidelinedTokenFunded";
  pool: PublicKey;
  authority: PublicKey;
  tokenIndex: number;
  amountCharged: BN;
  amountCredited: BN;
  actualAfter: BN;
  virtualBalance: BN;
  lpSupply: BN;
  timestamp: number;
}

/** `rescale_virtual_balances` (T22): every `V_i` multiplied by `multiplier`; price-neutral. */
export interface VirtualBalancesRescaledEvent {
  kind: "VirtualBalancesRescaled";
  pool: PublicKey;
  authority: PublicKey;
  multiplier: BN;
  oldVirtualBalances: BN[];
  newVirtualBalances: BN[];
  timestamp: number;
}

/** One per hook callback, before the instruction's primary event (T9). */
export interface HookInvokedEvent {
  kind: "HookInvoked";
  pool: PublicKey;
  hookProgram: PublicKey;
  /** `HOOK_CALLBACKS[callback].name`. */
  callback: number;
  /** `0` = Allow, `1` = Deny (informational on removes). */
  verdict: number;
  hasFeeOverride: boolean;
  /** Raw override as returned by the hook (unclamped; `SwapV2.effectiveFeeRate` is the clamped rate). */
  feeOverride: number;
  cuUsed: number;
  timestamp: number;
}

export interface HookDisabledSetEvent {
  kind: "HookDisabledSet";
  pool: PublicKey;
  authority: PublicKey;
  oldDisabled: boolean;
  newDisabled: boolean;
  pauseWhenDisabled: boolean;
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

export interface SwapsEnabledUpdatedV2Event {
  kind: "SwapsEnabledUpdatedV2";
  pool: PublicKey;
  authority: PublicKey;
  /** `ACTOR_KIND.POOL_ADMIN` or `ACTOR_KIND.PROTOCOL_ADMIN`. */
  actorKind: number;
  oldValue: boolean;
  newValue: boolean;
  timestamp: number;
}

export interface TokenActiveSetV2Event {
  kind: "TokenActiveSetV2";
  pool: PublicKey;
  authority: PublicKey;
  actorKind: number;
  tokenIndex: number;
  oldValue: boolean;
  newValue: boolean;
  timestamp: number;
}

/** `range_manager_update`: sparse — only the touched indices, old (= the CAS `expected_current`) / new. */
export interface RangeManagerUpdatedV2Event {
  kind: "RangeManagerUpdatedV2";
  pool: PublicKey;
  manager: PublicKey;
  vbIndices: number[];
  vbOldValues: BN[];
  vbNewValues: BN[];
  weightIndices: number[];
  weightOldValues: BN[];
  weightNewValues: BN[];
  timestamp: number;
}

/** `set_max_selloff`: the whole policy per token, before / after (all seven fields). */
export interface MaxSelloffSetV2Event {
  kind: "MaxSelloffSetV2";
  pool: PublicKey;
  authority: PublicKey;
  oldParams: SelloffParams[];
  newParams: SelloffParams[];
  timestamp: number;
}

/**
 * `deposit_single_token_planned` receipt (STLD) — the LAST event of the
 * transaction and self-contained: the zap row needs nothing from the inner
 * legs (`innerSwapCount` × `SwapV2` then one `LiquidityAddedV2`, attributed to
 * coffer-pool at CPI depth 2).
 */
export interface SingleTokenDepositDirectV2Event {
  kind: "SingleTokenDepositDirectV2";
  pool: PublicKey;
  user: PublicKey;
  tokenInIndex: number;
  /** Gross input the user signed for (the plan's allocations sum to it). */
  amountIn: BN;
  minimumLpAmount: BN;
  /** The plan: gross input spent on each swap leg; the input slot is the amount reserved for the join. */
  allocations: BN[];
  /** `stateCommitment` the plan was quoted against (32 bytes). */
  planExpectedState: Buffer;
  planQuotedAt: number;
  planValidUntilSlot: BN;
  innerSwapCount: number;
  /** Measured per-token debits of the join. */
  depositedAmounts: BN[];
  lpReceived: BN;
  /** Per-token unspent budget left in the user's accounts (each entry in a different mint). */
  dustRemaining: BN[];
  lpSupplyBefore: BN;
  lpSupplyAfter: BN;
  timestamp: number;
}

/**
 * A `Program data:` line the SDK could not decode as a current event. `name`
 * is the pinned legacy / retired name when the discriminator is a known
 * pre-T11 one (`data.legacy === true`, `data.replacedBy` names the re-cut
 * event, `data.retired === true` when nothing replaced it), the current name
 * when the payload was malformed (`data.error`), else `"unknown"`.
 */
export interface UnknownEvent {
  kind: "Unknown";
  name: string;
  data: Record<string, unknown>;
}

/**
 * Every other current event, decoded through the IDL coder with camelCase
 * keys (nested structs included). The cooldown events' `kind: u8` data field
 * is exposed as `actionKind` so it cannot shadow the event discriminator.
 * Use `parseContractEvents` for exact IDL names and BN timestamps.
 */
type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<CamelCase<Tail>>}` : S;
type CamelEventData<T> = { [K in keyof T as K extends "kind" ? "actionKind" : K extends string ? CamelCase<K> : K]: K extends "timestamp" ? number : T[K] };
export type TypedEventName =
  | "SwapV2" | "LiquidityAddedV2" | "LiquidityRemovedV2" | "PoolInitializedV2" | "PoolInfoV2" | "ProtocolFeesCollectedV2" | "CreatorFeesClaimedV2"
  | "SidelinedTokenFunded" | "VirtualBalancesRescaled" | "HookInvoked" | "HookDisabledSet" | "PoolEnabledUpdated" | "SwapsEnabledUpdatedV2" | "TokenActiveSetV2"
  | "RangeManagerUpdatedV2" | "MaxSelloffSetV2" | "SingleTokenDepositDirectV2";
export type AdditionalContractEvent = {
  [P in keyof import("./contracts").ContractEventMap]: {
    [E in Exclude<keyof import("./contracts").ContractEventMap[P], TypedEventName>]:
      { kind: E } & CamelEventData<import("./contracts").ContractEventMap[P][E]>
  }[Exclude<keyof import("./contracts").ContractEventMap[P], TypedEventName>]
}[keyof import("./contracts").ContractEventMap];
