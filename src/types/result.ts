/**
 * Result returned by high-level client reads, quotes and transaction builders.
 * Raw builders, parsers, math functions and Anchor instruction methods may
 * throw. Use `if (res.ok) { ... } else { ... }` for result-based methods.
 */
export type SdkResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SdkError };

export interface SdkError {
  /** Stable machine-readable code. */
  code: SdkErrorCode;
  /** Human-readable message, safe to show to end users. */
  humanMessage: string;
  /** Original error for debugging; never render this to end users. */
  cause?: unknown;
}

export type SdkErrorCode =
  | "rpc_unavailable"
  | "rpc_timeout"
  | "rpc_rate_limited"
  | "account_not_found"
  | "invalid_input"
  | "math_overflow"
  | "parse_failure"
  | "backend_unavailable"
  | "backend_invalid_response"
  | "insufficient_funds"
  | "pool_disabled"
  | "swaps_disabled"
  | "selloff_window_full"
  | "token_swaps_disabled"
  | "unsupported_pool_state"
  | "unsupported_token_extension"
  /** The amount is too small to survive fees/rounding (`AmountFullyConsumedByTransferFee`, `DepositTooSmall`). */
  | "amount_too_small"
  | "slippage_exceeded"
  | "simulation_failed"
  | "tx_build_failed"
  | "alt_fetch_failed"
  | "auth_failed"
  /** v6 planned zap: the plan's budget/shape was rejected by the program. */
  | "plan_invalid"
  /** v6 planned zap: the plan is older than 90 s or its slot passed. */
  | "plan_expired"
  /** v6 planned zap: pool, LP supply, a mint or the epoch changed since the quote. */
  | "plan_stale"
  /** v6.1: the pool account is still 1683 bytes — run / prepend `migrate_pool_layout_v61` first (`LayoutVersionMismatch`). */
  | "pool_layout_outdated"
  /** v6.1 (T10): the swap output slot has no reserves (`InsufficientLiquidity` on a sidelined token). */
  | "no_liquidity"
  /** v6.1 (T3): the admin action must go through the propose → wait → execute queue (`CooldownRequired`, `CooldownNotElapsed`, …). */
  | "cooldown"
  /** v6.1 (T9): the pool's hook refused or broke the operation (`HookDenied`, `HookPaused`, …). */
  | "hook_rejected"
  | "unknown";

export const ok = <T>(data: T): SdkResult<T> => ({ ok: true, data });
export const err = (
  code: SdkErrorCode,
  humanMessage: string,
  cause?: unknown
): SdkResult<never> => ({
  ok: false,
  error: { code, humanMessage, cause },
});
