import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { PendingPoolAction, PoolInfo, PoolTokenInfo } from "../types/pool";
import { simulateSwap, SwapLeg, SwapSimResult } from "../math/swapSim";
import { MathError } from "../math/fixedPoint";
import { HOOK_FLAGS } from "../config";
import { pendingStatus, PendingStatus, POOL_ACTION_KINDS } from "../parsers/layout";

const U64_MAX = (1n << 64n) - 1n;
export function u64(value: bigint, label: string): bigint {
  if (value < 0n || value > U64_MAX) throw new Error(`${label} must fit u64`);
  return value;
}
const bi = (value: BN | undefined | null): bigint => BigInt(value?.toString() ?? "0");
const bn = (value: bigint): BN => new BN(value.toString());

/** `PoolTokenInfo` (BN snapshot) → simulator leg (bigint). v6.1 buckets fall back to the pool-level arrays, then 0. */
export function swapLegOf(t: PoolTokenInfo, pool?: Pick<PoolInfo, "creatorFeesOwed" | "surgeFeesOwed">): SwapLeg {
  if (t.maxSelloffPct > 0 && [t.maxSelloffPeriodLength, t.previousSelloff, t.currentSelloff, t.windowStartTimestamp, t.selloffVbSnapshot].some((v) => v === undefined)) {
    throw new Error("Selloff state missing: sync the pool before quoting");
  }
  return {
    virtualBalance: bi(t.virtualBalance),
    actualBalance: bi(t.actualBalance),
    protocolFeesOwed: bi(t.protocolFeesOwed),
    creatorFeesOwed: bi(t.creatorFeesOwed ?? pool?.creatorFeesOwed?.[t.index]),
    surgeFeesOwed: bi(t.surgeFeesOwed ?? pool?.surgeFeesOwed?.[t.index]),
    weightBps: BigInt(t.weightBps),
    isActive: t.isActive,
    maxSelloffPct: t.maxSelloffPct,
    maxSelloffPeriodLength: t.maxSelloffPeriodLength ?? 0,
    curve: {
      thresholdPct: t.variableFeeThresholdPct ?? 0,
      slopeLowPct: t.variableFeeSlopeLowPct ?? 0,
      slopeMidPct: t.variableFeeSlopeMidPct ?? 0,
      slopeHighPct: t.variableFeeSlopeHighPct ?? 0,
      kinkPct: t.variableFeeKinkPct ?? 0,
    },
    window: { previousSelloff: bi(t.previousSelloff), currentSelloff: bi(t.currentSelloff), windowStartTimestamp: bi(t.windowStartTimestamp), selloffVbSnapshot: bi(t.selloffVbSnapshot) },
    transferFee: t.transferFee ?? null,
  };
}

/** v6.1 (T12): one slot's NAV `actual + surge_fees_owed` as the quotes read it from a snapshot. */
export function tokenSurgeBucket(t: PoolTokenInfo, pool?: Pick<PoolInfo, "surgeFeesOwed">): bigint {
  return bi(t.surgeFeesOwed ?? pool?.surgeFeesOwed?.[t.index]);
}

function applyLeg(pool: PoolInfo, t: PoolTokenInfo, after: SwapSimResult["inputAfter"]): void {
  t.virtualBalance = bn(after.virtualBalance);
  t.actualBalance = bn(after.actualBalance);
  t.protocolFeesOwed = bn(after.protocolFeesOwed);
  t.creatorFeesOwed = bn(after.creatorFeesOwed);
  t.surgeFeesOwed = bn(after.surgeFeesOwed);
  t.sidelined = after.actualBalance === 0n;
  if (pool.creatorFeesOwed?.[t.index] !== undefined) pool.creatorFeesOwed[t.index] = bn(after.creatorFeesOwed);
  if (pool.surgeFeesOwed?.[t.index] !== undefined) pool.surgeFeesOwed[t.index] = bn(after.surgeFeesOwed);
  t.previousSelloff = bn(after.window.previousSelloff);
  t.currentSelloff = bn(after.window.currentSelloff);
  t.windowStartTimestamp = bn(after.window.windowStartTimestamp);
  t.selloffVbSnapshot = bn(after.window.selloffVbSnapshot);
}

/** v6.1 (T9): `true` when the pool's hook is `DYNAMIC_FEE` and active — the swap fee may differ from `swapFeeRate`. */
export function hasDynamicFeeHook(pool: Pick<PoolInfo, "hook">): boolean {
  return !!pool.hook && pool.hook.active && (pool.hook.flags & HOOK_FLAGS.DYNAMIC_FEE) !== 0;
}

/** v6.1 (T9) `hooks::check_hook_gate(Gate::Blocking)`: a disabled fail-closed hook pauses swaps / deposits (`HookPaused`). */
export function hookPaused(pool: Pick<PoolInfo, "hook">): boolean {
  return !!pool.hook && pool.hook.disabled && (pool.hook.flags & HOOK_FLAGS.PAUSE_WHEN_DISABLED) !== 0;
}

export interface SimulatePoolSwapOptions {
  /** v6.1 (T9): dynamic-fee hook rate for this swap; see `SwapQuoteOptions.hookFeeOverride`. */
  hookFeeOverride?: number;
}

/**
 * Compute one v6.1 swap against a `PoolInfo` snapshot; with `mutate` the
 * snapshot is advanced in place (used for sequential simulations).
 * Throws with the program's error name on a program-equivalent failure.
 */
export function simulatePoolSwap(pool: PoolInfo, tokenInIndex: number, tokenOutIndex: number, amountIn: bigint, now: bigint, mutate = false, options: SimulatePoolSwapOptions = {}): SwapSimResult {
  if (!Number.isInteger(tokenInIndex) || !Number.isInteger(tokenOutIndex) || tokenInIndex === tokenOutIndex ||
      tokenInIndex < 0 || tokenOutIndex < 0 || tokenInIndex >= pool.tokenCount || tokenOutIndex >= pool.tokenCount) {
    throw new Error("InvalidTokenIndex");
  }
  if (!pool.poolEnabled) throw new Error("PoolDisabled");
  if (!pool.swapsEnabled) throw new Error("SwapsDisabled");
  if (hookPaused(pool)) throw new Error("HookPaused");
  u64(amountIn, "amountIn");
  const input = pool.tokens[tokenInIndex], output = pool.tokens[tokenOutIndex];
  let r: SwapSimResult;
  try {
    r = simulateSwap({
      input: swapLegOf(input, pool), output: swapLegOf(output, pool), amountIn,
      swapFeeRate: pool.swapFeeRate, protocolFeeRate: pool.protocolFeeRate, creatorFeeBps: pool.creatorFeeBps ?? 0,
      hookFeeOverride: options.hookFeeOverride, hookFeeMin: pool.hook?.feeMin ?? 0, hookFeeMax: pool.hook?.feeMax ?? 0,
      now,
    });
  } catch (e) {
    // Surface program error names to the client's code mapping.
    if (e instanceof MathError) throw new Error(e.message);
    throw e;
  }
  if (mutate) {
    applyLeg(pool, input, r.inputAfter);
    applyLeg(pool, output, r.outputAfter);
  }
  return r;
}

/** Clock from sync; callers may supply the transaction's expected Unix timestamp explicitly. */
export function quoteTimestamp(pool: PoolInfo, nowSeconds?: number): bigint {
  const now = nowSeconds ?? pool.chainTimestamp;
  if (now === undefined) {
    if (pool.tokens.some(t => t.maxSelloffPct > 0)) throw new Error("Chain timestamp missing: sync or supply nowSeconds");
    return 0n;
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid quote timestamp");
  return BigInt(now);
}

// ── v6.1 (T3) pending-action read model ─────────────────────────────────────

export interface PendingActionStatus extends PendingPoolAction {
  /** `pendingStatus(eta, now)` at the CHAIN clock. */
  status: PendingStatus;
  /** Seconds until `eta` (`0` once ready / expired / empty). */
  secondsUntilReady: number;
}

export interface PendingActionsStatus {
  /** Chain seconds the statuses were evaluated at (`Clock.unix_timestamp` of the sync, or the explicit override). */
  now: number;
  /** `pool_admin_delay_secs`: `0` ⇒ the direct admin instructions work. */
  delaySecs: number;
  /** `pool_admin_epoch`; a bump voids every pending slot. */
  epoch: number;
  /** `delaySecs === 0`. */
  directPathOpen: boolean;
  /** The eleven typed slots in kind order (`TransferPoolAdmin` = kind 0 carries the nominee). */
  actions: PendingActionStatus[];
  /** Kinds whose slot is `ready` right now. */
  readyKinds: number[];
  /** `pending_actions_mask` as the snapshot reports it. */
  mask: number;
}

/**
 * Status of every pool-admin pending slot at the chain clock. `now`
 * defaults to the snapshot's `chainTimestamp` (Clock sysvar) and is NEVER
 * browser time: pass `chainNow` explicitly only when quoting for a later
 * block. A snapshot without `pendingActions` (pre-v6.1 / manual) reports
 * eleven empty slots.
 */
export function pendingActionsStatusOf(pool: PoolInfo, chainNow?: number): PendingActionsStatus {
  const now = chainNow ?? pool.chainTimestamp;
  if (now === undefined || !Number.isSafeInteger(now) || now < 0) throw new Error("Chain timestamp missing: sync the pool or pass chainNow (Clock seconds, never Date.now())");
  const slots: PendingPoolAction[] = pool.pendingActions && pool.pendingActions.length > 0
    ? pool.pendingActions
    : POOL_ACTION_KINDS.map((name, kind): PendingPoolAction => ({
        kind, name,
        eta: kind === 0 ? new BN((pool.pendingPoolAdminEta ?? new BN(0)).toString()) : new BN(0),
        payload: kind === 0 ? { newAdmin: pool.pendingPoolAdmin ?? PublicKey.default } : {},
      }));
  const actions = slots.map((s): PendingActionStatus => {
    const eta = BigInt(s.eta.toString());
    const status = pendingStatus(eta, now);
    const until = status === "waiting" ? Number(eta - BigInt(now)) : 0;
    return { ...s, status, secondsUntilReady: until };
  });
  const delaySecs = pool.poolAdminDelaySecs ?? 0;
  return {
    now,
    delaySecs,
    epoch: pool.poolAdminEpoch ?? 0,
    directPathOpen: delaySecs === 0,
    actions,
    readyKinds: actions.filter((a) => a.status === "ready").map((a) => a.kind),
    mask: pool.pendingActionsMask ?? actions.reduce((m, a) => (a.status === "none" ? m : m | (1 << a.kind)), 0),
  };
}
