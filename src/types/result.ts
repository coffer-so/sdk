/**
 * Every public SDK method returns a SdkResult<T>. Callers never need try/catch.
 * Use `if (res.ok) { ... } else { ... }` to branch.
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
  | "slippage_exceeded"
  | "simulation_failed"
  | "tx_build_failed"
  | "alt_fetch_failed"
  | "auth_failed"
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
