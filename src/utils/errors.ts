import cubicPoolIdl from "../idl/cubic_pool.json";
import { SdkError, SdkErrorCode } from "../types/result";

const ANCHOR_NAME_TO_SDK: Record<string, SdkErrorCode> = {
  InvalidTokenCount: "invalid_input",
  InvalidTokenIndex: "invalid_input",
  InvalidWeights: "invalid_input",
  InvalidVirtualBalances: "invalid_input",
  InsufficientLiquidity: "insufficient_funds",
  SlippageExceeded: "slippage_exceeded",
  InvalidAmounts: "invalid_input",
  InsufficientBptOut: "slippage_exceeded",
  InsufficientTokensOut: "slippage_exceeded",
  FeeRateMaxExceeded: "invalid_input",
  ProtocolFeeRateMaxExceeded: "invalid_input",
  MathOverflow: "math_overflow",
  MathUnderflow: "math_overflow",
  DivisionByZero: "math_overflow",
  TokenMintMismatch: "invalid_input",
  InvalidTokenDecimals: "invalid_input",
  AmountOutExceedsBalance: "invalid_input",
  InvalidBptAmount: "invalid_input",
  Unauthorized: "invalid_input",
  InvalidMint: "invalid_input",
  PoolDisabled: "pool_disabled",
  SwapsDisabled: "swaps_disabled",
  MaxSelloffExceeded: "selloff_window_full",
  TokenInactive: "token_swaps_disabled",
  PoolMustBeDisabled: "invalid_input",
  ZeroAmount: "invalid_input",
  ZeroFeeAmount: "invalid_input",
  BannedExtension: "invalid_input",
  TokenProgramMismatch: "invalid_input",
  UserTokenAccountOwnerMismatch: "invalid_input",
  InitialLiquidityTooSmall: "invalid_input",
  InvalidTokenProgram: "invalid_input",
  InvalidVault: "invalid_input",
  InvalidSourceOwner: "invalid_input",
  WouldBreakRentExempt: "invalid_input",
  PoolAdminDisabled: "invalid_input",
  ProtocolAdminUnset: "invalid_input",
  NoPendingAdmin: "invalid_input",
  NotPendingAdmin: "invalid_input",
  InvalidPendingAdmin: "invalid_input",
  ProtocolAdminNotTreasury: "invalid_input",
};

const CONTRACT_ERROR_MAP: Record<number, { code: SdkErrorCode; message: string }> =
  Object.fromEntries(
    (cubicPoolIdl.errors as Array<{ code: number; name: string; msg: string }>).map(
      (anchorError) => [
        anchorError.code,
        {
          code: ANCHOR_NAME_TO_SDK[anchorError.name] ?? "invalid_input",
          message: anchorError.msg,
        },
      ]
    )
  );

/**
 * Convert a raw error (possibly from Anchor, web3.js, or fetch) into a
 * cleanly-typed SdkError. Used by safeCall wrappers so callers always
 * get structured errors, never exceptions.
 */
export function toSdkError(cause: unknown): SdkError {
  // Anchor-encoded program errors
  const msg = extractMessage(cause);
  const code = extractErrorCode(msg);
  if (code !== null && CONTRACT_ERROR_MAP[code]) {
    return {
      code: CONTRACT_ERROR_MAP[code].code,
      humanMessage: CONTRACT_ERROR_MAP[code].message,
      cause,
    };
  }
  // Common network strings
  if (/timed? ?out|ETIMEDOUT/i.test(msg)) {
    return { code: "rpc_timeout", humanMessage: "RPC timed out", cause };
  }
  if (/429|rate limit/i.test(msg)) {
    return { code: "rpc_rate_limited", humanMessage: "RPC rate-limited - slow down", cause };
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|Proxy error|-32056|-32052|403/i.test(msg)) {
    return { code: "rpc_unavailable", humanMessage: "RPC endpoint unreachable", cause };
  }
  if (/Account does not exist|account not found/i.test(msg)) {
    return { code: "account_not_found", humanMessage: "Account does not exist on-chain", cause };
  }
  if (/insufficient funds/i.test(msg)) {
    return { code: "insufficient_funds", humanMessage: "Insufficient funds for this operation", cause };
  }
  return { code: "unknown", humanMessage: msg || "Unknown error", cause };
}

function extractMessage(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message?: string }).message ?? "");
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function extractErrorCode(msg: string): number | null {
  // Anchor error format: "custom program error: 0x1774"
  const hex = msg.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  // Anchor SDK format: "Error Number: 6007"
  const dec = msg.match(/Error Number:\s*(\d+)/);
  if (dec) return parseInt(dec[1], 10);
  return null;
}

/** @internal Exported for tests */
export function contractErrorMapForTests(): typeof CONTRACT_ERROR_MAP {
  return CONTRACT_ERROR_MAP;
}
