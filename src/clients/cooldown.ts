/**
 * cooldown — v6.1 (T3) admin cooldown builders, POOL scope
 * (`set_pool_admin_delay`, `propose_pool_action`, `cancel_pool_action`,
 * `execute_<kind>`) plus the PROTOCOL-scope action helpers the
 * `AdminClient` wraps (`ProtocolActions`, `protocolActionKindOf`).
 *
 * Model: while `pool.pool_admin_delay_secs` (or `Treasury.delay_secs`) is
 * non-zero, a direct setter fails with `CooldownRequired` (6089 / 6010).
 * The admin instead proposes the ABSOLUTE payload (`PoolAction` /
 * `ProtocolAction` Borsh enum, tag = kind − 1), waits `delay` seconds
 * (chain clock), then sends the matching `execute_*` within the 14-day
 * grace window; the execute re-derives nothing — it applies the stored
 * payload. One pending slot per kind; the pool-admin epoch voids every
 * slot on an admin change. `pendingStatus()` in `parsers/layout.ts` tells
 * `waiting` / `ready` / `expired` at a chain timestamp.
 *
 * Enum shape (IDL-exact variant names): `{ SetSwapFeeRate: { rate } }`,
 * unit variants `{ LockLiquidityFees: {} }` — use the typed constructors.
 */
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import BN from "bn.js";
import { CofferConfig } from "../config";
import {
  POOL_ACTION_KIND,
  POOL_ACTION_KINDS,
  PROTOCOL_ACTION_KIND,
  PROTOCOL_ACTION_KINDS,
  type PoolActionKindName,
  type ProtocolActionKindName,
} from "../parsers/layout";
import type { ContractTypes } from "../types/contracts";
import type { SelloffParams } from "../types/tx";
import { buildContractInstruction } from "./contract-instructions";

export type PoolAction = ContractTypes["cofferPool"]["PoolAction"];
export type ProtocolAction = ContractTypes["protocolAdmin"]["ProtocolAction"];
type IdlSelloffParams = ContractTypes["cofferPool"]["SelloffParams"];

/** `SelloffParams` (camelCase SDK shape) → IDL field names. */
export function selloffParamsArg(p: SelloffParams): IdlSelloffParams {
  return {
    max_selloff_pct: p.maxSelloffPct, period_length: p.periodLength, fee_threshold_pct: p.feeThresholdPct,
    fee_slope_low_pct: p.feeSlopeLowPct, fee_slope_high_pct: p.feeSlopeHighPct, fee_slope_mid_pct: p.feeSlopeMidPct,
    fee_kink_pct: p.feeKinkPct,
  };
}

// ─── Pool scope ──────────────────────────────────────────────────────────────

/** Typed constructors for every `PoolAction` variant (payload = the absolute value the direct setter takes). */
export const PoolActions = {
  setDelay: (secs: number): PoolAction => ({ SetDelay: { secs } }),
  setSwapFeeRate: (rate: number): PoolAction => ({ SetSwapFeeRate: { rate } }),
  setCreatorFeeBps: (bps: number): PoolAction => ({ SetCreatorFeeBps: { bps } }),
  setLiquidityFees: (depositFeeBps: number, withdrawFeeBps: number): PoolAction => ({ SetLiquidityFees: { deposit_fee_bps: depositFeeBps, withdraw_fee_bps: withdrawFeeBps } }),
  lockLiquidityFees: (): PoolAction => ({ LockLiquidityFees: {} }),
  lockRangeManager: (): PoolAction => ({ LockRangeManager: {} }),
  setRangeManager: (manager: PublicKey, enabled: boolean): PoolAction => ({ SetRangeManager: { manager, enabled } }),
  setRangeManagerConfig: (c: { maxVbChangePct: number; maxWeightChangePct: number; minUpdateIntervalSecs: number; maxLeverageBps: number; minLeverageBps: number }): PoolAction => ({
    SetRangeManagerConfig: {
      max_vb_change_pct: c.maxVbChangePct, max_weight_change_pct: c.maxWeightChangePct, min_update_interval_secs: c.minUpdateIntervalSecs,
      max_leverage_bps: c.maxLeverageBps, min_leverage_bps: c.minLeverageBps,
    },
  }),
  /** The queued slot stores a hash of `params`; the SAME vector must be passed to `execute_set_max_selloff`. */
  setMaxSelloff: (params: SelloffParams[]): PoolAction => ({ SetMaxSelloff: { params: params.map(selloffParamsArg) } }),
  /** Queues a flip of `tokens[token_index].is_active`; the execute applies `!is_active` at execution time. */
  setTokenActive: (tokenIndex: number): PoolAction => ({ SetTokenActive: { token_index: tokenIndex } }),
} as const;

/** `PoolAction` variant name → pending-slot kind (`cancel_pool_action` arg; bit of `pending_actions_mask`). */
export function poolActionKindOf(action: PoolAction): number {
  const name = variantName(action, "PoolAction");
  const kind = POOL_ACTION_KIND[name as PoolActionKindName];
  if (kind === undefined || kind === 0) throw new Error(`${name} is not a PoolAction variant`);
  return kind;
}

/** Kind → `execute_*` instruction name on coffer_pool (kind 0 = the admin transfer: `accept_pool_admin_transfer`). */
export const POOL_EXECUTE_INSTRUCTION = {
  TransferPoolAdmin: "accept_pool_admin_transfer",
  SetDelay: "execute_set_delay",
  SetSwapFeeRate: "execute_set_swap_fee_rate",
  SetCreatorFeeBps: "execute_set_creator_fee_bps",
  SetLiquidityFees: "execute_set_liquidity_fees",
  LockLiquidityFees: "execute_lock_liquidity_fees",
  LockRangeManager: "execute_lock_range_manager",
  SetRangeManager: "execute_set_range_manager",
  SetRangeManagerConfig: "execute_set_range_manager_config",
  SetMaxSelloff: "execute_set_max_selloff",
  SetTokenActive: "execute_set_token_active",
} as const satisfies Record<PoolActionKindName, string>;

export function poolActionKindName(kind: number | PoolActionKindName): PoolActionKindName {
  if (typeof kind === "string") {
    if (!(kind in POOL_ACTION_KIND)) throw new Error(`unknown pool action kind ${kind}`);
    return kind;
  }
  const name = POOL_ACTION_KINDS[kind];
  if (name === undefined) throw new Error(`pool action kind ${kind} out of range 0..${POOL_ACTION_KINDS.length - 1}`);
  return name;
}

/** `propose_pool_action(action)` — pool admin; one live slot per kind (re-proposing overwrites it). */
export function buildProposePoolActionIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey, action: PoolAction): TransactionInstruction {
  poolActionKindOf(action); // validates the variant name early with a clear message
  return buildContractInstruction(cfg, "cofferPool", "propose_pool_action", { action }, { pool, authority });
}

/** `cancel_pool_action(kind)` — pool admin; kind 0 cancels the pending admin transfer. */
export function buildCancelPoolActionIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey, kind: number | PoolActionKindName): TransactionInstruction {
  const k = typeof kind === "string" ? POOL_ACTION_KIND[poolActionKindName(kind)] : kind;
  if (!Number.isInteger(k) || k < 0 || k >= POOL_ACTION_KINDS.length) throw new Error(`cancel_pool_action: kind ${kind} out of range`);
  return buildContractInstruction(cfg, "cofferPool", "cancel_pool_action", { kind: k }, { pool, authority });
}

/**
 * `execute_<kind>` for a ready slot. Kind 9 (`SetMaxSelloff`) takes the
 * SAME `params` vector that was proposed (the slot stores its hash,
 * `PendingPayloadMismatch` otherwise). Kind 0 maps to
 * `accept_pool_admin_transfer`, signed by the NOMINEE (`new_admin`).
 */
export function buildExecutePoolActionIx(
  cfg: CofferConfig,
  pool: PublicKey,
  authority: PublicKey,
  kind: number | PoolActionKindName,
  params?: SelloffParams[],
): TransactionInstruction {
  const name = poolActionKindName(kind);
  const ixName = POOL_EXECUTE_INSTRUCTION[name];
  if (name === "SetMaxSelloff") {
    if (!params || params.length === 0) throw new Error("execute_set_max_selloff: pass the proposed SelloffParams[] (the slot stores only their hash)");
    return buildContractInstruction(cfg, "cofferPool", "execute_set_max_selloff", { params: params.map(selloffParamsArg) }, { pool, authority });
  }
  if (params !== undefined) throw new Error(`${ixName} takes no params`);
  if (name === "TransferPoolAdmin") {
    return buildContractInstruction(cfg, "cofferPool", "accept_pool_admin_transfer", {}, { pool, new_admin: authority });
  }
  return buildContractInstruction(cfg, "cofferPool", ixName as Exclude<typeof ixName, "accept_pool_admin_transfer" | "execute_set_max_selloff">, {}, { pool, authority });
}

// ─── Protocol scope (payload helpers; instructions live on AdminClient) ──────

/** Typed constructors for every `ProtocolAction` variant. */
export const ProtocolActions = {
  setDelay: (secs: number): ProtocolAction => ({ SetDelay: { secs } }),
  setSupervisor: (key: PublicKey): ProtocolAction => ({ SetSupervisor: { key } }),
  withdraw: (mint: PublicKey, recipient: PublicKey, amount: BN): ProtocolAction => ({ Withdraw: { mint, recipient, amount } }),
  /** `route`: 0 = `withdraw_sol` (Treasury lamports), 1 = `pool_withdraw_sol`, 2 = `stld_withdraw_sol` (`source` = config / pool / helper accordingly). */
  withdrawSol: (route: number, source: PublicKey, recipient: PublicKey, amount: BN): ProtocolAction => ({ WithdrawSol: { route, source, recipient, amount } }),
  poolDebugWithdraw: (pool: PublicKey, tokenAmounts: BN[], recipients: PublicKey[]): ProtocolAction => ({ PoolDebugWithdraw: { pool, token_amounts: tokenAmounts, recipients } }),
  /** T15: 0..=10_000 bps, per pool. */
  poolSetProtocolFeeRate: (pool: PublicKey, rate: number): ProtocolAction => ({ PoolSetProtocolFeeRate: { pool, rate } }),
  /** Queues a flip of `pool_enabled` (the execute applies `!pool_enabled`). */
  poolSetPoolEnabled: (pool: PublicKey): ProtocolAction => ({ PoolSetPoolEnabled: { pool } }),
  poolSetTokenActive: (pool: PublicKey, tokenIndex: number): ProtocolAction => ({ PoolSetTokenActive: { pool, token_index: tokenIndex } }),
  unfreezePools: (pools: PublicKey[]): ProtocolAction => ({ UnfreezePools: { pools } }),
  poolProtocolAdminTransfer: (config: PublicKey, newAdmin: PublicKey): ProtocolAction => ({ PoolProtocolAdminTransfer: { config, new_admin: newAdmin } }),
  /** The upgrade BUFFER must also be passed as remaining account 0 of `propose_action` (authority check). */
  upgradeProgram: (program: PublicKey, buffer: PublicKey): ProtocolAction => ({ UpgradeProgram: { program, buffer } }),
  /** `op`: 0 = transfer_upgrade_authority (`target` = new authority), 1 = freeze_pool_program, 2 = close_pool_program (`target` = recipient). */
  programOp: (op: number, program: PublicKey, target: PublicKey): ProtocolAction => ({ ProgramOp: { op, program, target } }),
} as const;

/** `ProtocolAction` variant name → Treasury pending-slot kind (`cancel_action` arg). */
export function protocolActionKindOf(action: ProtocolAction): number {
  const name = variantName(action, "ProtocolAction");
  const kind = PROTOCOL_ACTION_KIND[name as ProtocolActionKindName];
  if (kind === undefined || kind === 0) throw new Error(`${name} is not a ProtocolAction variant`);
  return kind;
}

export function protocolActionKindName(kind: number | ProtocolActionKindName): ProtocolActionKindName {
  if (typeof kind === "string") {
    if (!(kind in PROTOCOL_ACTION_KIND)) throw new Error(`unknown protocol action kind ${kind}`);
    return kind;
  }
  const name = PROTOCOL_ACTION_KINDS[kind];
  if (name === undefined) throw new Error(`protocol action kind ${kind} out of range 0..${PROTOCOL_ACTION_KINDS.length - 1}`);
  return name;
}

/**
 * Kind → `execute_*` instruction(s) on protocol_admin. Kinds with several
 * routes (`WithdrawSol` by `route`, `ProgramOp` by `op`) list them in route
 * order; kind 0 = `accept_admin_transfer` (signed by the nominee).
 */
export const PROTOCOL_EXECUTE_INSTRUCTIONS = {
  TransferAdmin: ["accept_admin_transfer"],
  SetDelay: ["execute_set_delay"],
  SetSupervisor: ["execute_set_supervisor"],
  Withdraw: ["execute_withdraw"],
  WithdrawSol: ["execute_withdraw_sol", "execute_pool_withdraw_sol", "execute_stld_withdraw_sol"],
  PoolDebugWithdraw: ["execute_pool_debug_withdraw"],
  PoolSetProtocolFeeRate: ["execute_pool_set_protocol_fee_rate"],
  PoolSetPoolEnabled: ["execute_pool_set_pool_enabled"],
  PoolSetTokenActive: ["execute_pool_set_token_active"],
  UnfreezePools: ["execute_unfreeze_pools"],
  PoolProtocolAdminTransfer: ["execute_pool_protocol_admin_transfer"],
  UpgradeProgram: ["execute_upgrade_program"],
  ProgramOp: ["execute_transfer_upgrade_authority", "execute_freeze_pool_program", "execute_close_pool_program"],
} as const satisfies Record<ProtocolActionKindName, readonly string[]>;

/** Remaining accounts `propose_action` needs for `action` (the upgrade buffer for `UpgradeProgram`, else none). */
export function proposeActionRemainingAccounts(action: ProtocolAction): AccountMeta[] {
  if ("UpgradeProgram" in action) return [{ pubkey: action.UpgradeProgram.buffer, isSigner: false, isWritable: false }];
  return [];
}

function variantName(action: object, typeName: string): string {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error(`${typeName} must be an object with exactly one variant key`);
  const keys = Object.keys(action);
  if (keys.length !== 1) throw new Error(`${typeName} must have exactly one variant key, got [${keys.join(", ")}]`);
  return keys[0];
}
