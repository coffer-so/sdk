import cubicPoolIdl from "../idl/cubic_pool.json";
import protocolAdminIdl from "../idl/protocol_admin.json";
import singleTokenLiquidityIdl from "../idl/single_token_liquidity.json";
import { SdkError, SdkErrorCode } from "../types/result";

/**
 * Which on-chain program produced an error code.
 *
 * Anchor numbers every program's errors from 6000, so a bare custom-error
 * code is ambiguous across the three Cube programs — `6030` is
 * `InvalidTokenProgram` in cubic-pool but `TokenExtensionsUnsupported` in
 * single-token-liquidity. Pass this to {@link toSdkError} when you know
 * which program the failing instruction belonged to; without it the
 * cubic-pool table is used, which is the right default for swap / add /
 * remove but WRONG for a zap or an admin call.
 */
export type CubeProgram = "cubicPool" | "singleTokenLiquidity" | "protocolAdmin";

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

  // ── cubic-pool 6055–6068, new in v5.1 ────────────────────────────────
  /** Mint carries a Token-2022 extension this pool's policy forbids. */
  UnsupportedExtension: "invalid_input",
  /** Destination requires a memo — include the SPL Memo program account. */
  MemoProgramMissing: "invalid_input",
  TransferFeeCalculationMismatch: "invalid_input",
  /** The whole deposit was eaten by the mint's transfer fee. */
  AmountFullyConsumedByTransferFee: "invalid_input",
  /** Only `pool.pool_admin` may make a pool's first (seed) deposit. */
  SeedDepositNotPoolAdmin: "auth_failed",
  StldTokenExtensionsUnsupported: "unsupported_pool_state",
  /**
   * Compare-and-swap guard on `range_manager_update` failed: the pool moved
   * between the read and the write. The bot must re-read the pool and retry
   * with fresh `expectedCurrent` values — it is a retryable race, not a
   * permanent rejection.
   */
  RangeManagerStaleValue: "invalid_input",
  RangeManagerLeverageBandExceeded: "invalid_input",
  RangeManagerOverrideMustDisable: "auth_failed",
  /** An array argument's length != the pool's `token_count`. */
  InvalidArrayLength: "invalid_input",
  FirstDepositRequiresNonzero: "invalid_input",
  TokenLivenessMismatch: "invalid_input",
  /** Deposit too small to mint a single unit of BPT — increase the amount. */
  DepositTooSmall: "invalid_input",
  /** Pool holds no liquidity yet; the pool admin must seed it first. */
  PoolNotSeeded: "unsupported_pool_state",

  // ── protocol-admin ───────────────────────────────────────────────────
  /** New admin cannot be the all-zero pubkey. */
  InvalidAdmin: "invalid_input",

  // ── single-token-liquidity 6030–6032, new in v5.1 ────────────────────
  /** Zap route can't carry an armed transfer hook's extra accounts. */
  TokenExtensionsUnsupported: "unsupported_pool_state",
  InsufficientHelperSol: "insufficient_funds",
  /** Pool exceeds `STLD_MAX_TOKENS` (10) — use `add_liquidity` instead. */
  PoolTooLargeForZap: "unsupported_pool_state",
};

type AnchorIdlError = { code: number; name: string; msg: string };
type ErrorTable = Record<number, { code: SdkErrorCode; message: string; name: string }>;

function buildErrorTable(errors: AnchorIdlError[]): ErrorTable {
  return Object.fromEntries(
    errors.map((anchorError) => [
      anchorError.code,
      {
        code: ANCHOR_NAME_TO_SDK[anchorError.name] ?? "invalid_input",
        message: anchorError.msg,
        name: anchorError.name,
      },
    ])
  );
}

const ERROR_TABLES: Record<CubeProgram, ErrorTable> = {
  cubicPool: buildErrorTable(cubicPoolIdl.errors as AnchorIdlError[]),
  protocolAdmin: buildErrorTable(protocolAdminIdl.errors as AnchorIdlError[]),
  singleTokenLiquidity: buildErrorTable(singleTokenLiquidityIdl.errors as AnchorIdlError[]),
};

const CONTRACT_ERROR_MAP = ERROR_TABLES.cubicPool;

/**
 * Convert a raw error (possibly from Anchor, web3.js, or fetch) into a
 * cleanly-typed SdkError. Used by safeCall wrappers so callers always
 * get structured errors, never exceptions.
 *
 * @param program Which Cube program the failing instruction belonged to.
 *   Anchor numbers each program's errors from 6000 independently, so the
 *   same code means different things in different programs. Defaults to
 *   `"cubicPool"` (correct for swap / add / remove liquidity). Pass
 *   `"singleTokenLiquidity"` for zap failures and `"protocolAdmin"` for
 *   treasury-routed admin calls, or the message will be plausible and wrong.
 */
export function toSdkError(cause: unknown, program: CubeProgram = "cubicPool"): SdkError {
  // Anchor-encoded program errors
  const msg = extractMessage(cause);
  const code = extractErrorCode(msg);
  const table = ERROR_TABLES[program] ?? CONTRACT_ERROR_MAP;
  if (code !== null && table[code]) {
    return {
      code: table[code].code,
      humanMessage: table[code].message,
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
export function contractErrorMapForTests(program: CubeProgram = "cubicPool"): ErrorTable {
  return ERROR_TABLES[program];
}

/**
 * Look up a program error by its numeric code without needing an exception
 * to parse. Returns `undefined` for codes the program does not define.
 */
export function describeProgramError(
  code: number,
  program: CubeProgram = "cubicPool"
): { name: string; message: string; sdkCode: SdkErrorCode } | undefined {
  const hit = ERROR_TABLES[program]?.[code];
  if (!hit) return undefined;
  return { name: hit.name, message: hit.message, sdkCode: hit.code };
}
