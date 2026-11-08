import cubicPoolIdl from "../idl/cubic_pool.json";
import protocolAdminIdl from "../idl/protocol_admin.json";
import singleTokenLiquidityIdl from "../idl/single_token_liquidity.json";
import { SdkError, SdkErrorCode } from "../types/result";

/**
 * Which on-chain program produced an error code.
 *
 * Anchor numbers every program's errors from 6000, so a bare custom-error
 * code is ambiguous across the three Coffer programs — `6030` is
 * `InvalidTokenProgram` in cubic-pool but `TokenExtensionsUnsupported` in
 * single-token-liquidity. Pass this to {@link toSdkError} when you know
 * which program the failing instruction belonged to; without it the
 * cubic-pool table is used, which is the right default for swap / add /
 * remove but WRONG for a zap or an admin call.
 */
export type CofferProgram = "cubicPool" | "singleTokenLiquidity" | "protocolAdmin";

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

const ERROR_TABLES: Record<CofferProgram, ErrorTable> = {
  cubicPool: buildErrorTable(cubicPoolIdl.errors as AnchorIdlError[]),
  protocolAdmin: buildErrorTable(protocolAdminIdl.errors as AnchorIdlError[]),
  singleTokenLiquidity: buildErrorTable(singleTokenLiquidityIdl.errors as AnchorIdlError[]),
};

const CONTRACT_ERROR_MAP = ERROR_TABLES.cubicPool;

/**
 * Messages that fetch implementations use when no HTTP response came back:
 * Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError when
 * attempting to fetch resource.", undici (Node) "fetch failed", React Native
 * "Network request failed", plus the Node socket codes. Matched on a
 * `TypeError` (what `fetch` rejects with) or on an error the backend client
 * marked as transport-level.
 */
const FETCH_NETWORK_FAILURE_RE =
  /Failed to fetch|Load failed|NetworkError when attempting to fetch resource|fetch failed|Network request failed|The network connection was lost|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i;

/**
 * web3.js turns a non-2xx RPC answer into an Error whose message is
 * "<status> <statusText>: <body>"; method wrappers then prefix it ("failed
 * to get info about account …: Error: 503 Service Unavailable: …"). HTTP/2
 * answers have an empty statusText ("502 : …"). Anchored at the start or
 * after ": " so a base58 address that contains "5" + two digits does not
 * match.
 */
const RPC_HTTP_5XX_RE = /(?:^|: (?:Error: )?)5\d\d [A-Za-z -]*:/;

/**
 * @internal Whether a rejected `fetch()` means "no HTTP answer" (offline,
 * DNS, reset, CORS, timeout/abort) rather than a request the runtime refused
 * to send (invalid URL, invalid header value). Used by `CofferBackendClient`
 * to mark transport errors.
 */
export function isFetchNetworkFailure(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = extractMessage(e);
  // Timeout wording ("Network request timed out" in React Native) and Deno's
  // "error sending request" are network failures too.
  return (
    FETCH_NETWORK_FAILURE_RE.test(msg) ||
    /timed? ?out|ETIMEDOUT|error sending request/i.test(msg)
  );
}

/**
 * Convert a raw error (possibly from Anchor, web3.js, or fetch) into a
 * cleanly-typed SdkError. Used by safeCall wrappers so callers always
 * get structured errors, never exceptions.
 *
 * Structure is checked before text:
 * - `name === "TimeoutError"` (e.g. `AbortSignal.timeout`) → `rpc_timeout`;
 * - a numeric `status` (HTTP error from `CofferBackendClient`) → 429
 *   `rpc_rate_limited`, 5xx `backend_unavailable`, anything else `unknown`;
 *   `humanMessage` keeps the original "METHOD path → HTTP nnn …" text so
 *   callers that match `HTTP 404` still work;
 * - `transport === true` (the backend client's fetch rejected with no HTTP
 *   answer, or the response body broke off) → `backend_unavailable`,
 *   `humanMessage` "Backend unreachable: <original message>";
 * - `transport === false` (the backend client's fetch was refused before it
 *   reached the network: invalid URL, invalid header value) → `unknown`
 *   with the original message, never retried;
 * - `invalidResponse === true` (the backend answered 2xx with a body that is
 *   not JSON) → `backend_invalid_response`, never retried;
 * - an unmarked `TypeError` with a fetch network message → `rpc_unavailable`.
 *
 * Text rules (timeouts, fetch network messages, the web3.js "5xx …:" status
 * prefix, then `429`, `403`, …) only apply to errors none of the above
 * caught — in practice web3.js RPC errors such as "429 Too Many Requests: …",
 * "502 Bad Gateway: …" or "failed to get info about account …: TypeError:
 * Failed to fetch". Digits inside a backend request path or in a backend
 * JSON parse error therefore never change the class of a backend error.
 *
 * @param program Which Coffer program the failing instruction belonged to.
 *   Anchor numbers each program's errors from 6000 independently, so the
 *   same code means different things in different programs. Defaults to
 *   `"cubicPool"` (correct for swap / add / remove liquidity). Pass
 *   `"singleTokenLiquidity"` for zap failures and `"protocolAdmin"` for
 *   treasury-routed admin calls, or the message will be plausible and wrong.
 */
export function toSdkError(cause: unknown, program: CofferProgram = "cubicPool"): SdkError {
  const msg = extractMessage(cause);
  const structural = classifyByStructure(cause, msg);
  if (structural) return structural;

  // Anchor-encoded program errors
  const code = extractErrorCode(msg);
  const table = ERROR_TABLES[program] ?? CONTRACT_ERROR_MAP;
  if (code !== null && table[code]) {
    return {
      code: table[code].code,
      humanMessage: table[code].message,
      cause,
    };
  }
  // Common network strings (web3.js RPC errors carry the HTTP status only
  // in the message, e.g. "429 Too Many Requests: …" / "403 Forbidden: …")
  if (/timed? ?out|ETIMEDOUT/i.test(msg)) {
    return { code: "rpc_timeout", humanMessage: "RPC timed out", cause };
  }
  // Checked before the bare "429" so an account address with those digits
  // in "failed to get info about account …: TypeError: Failed to fetch"
  // stays a network failure.
  if (FETCH_NETWORK_FAILURE_RE.test(msg)) {
    return { code: "rpc_unavailable", humanMessage: "RPC endpoint unreachable", cause };
  }
  // RPC provider answered 5xx (web3.js "503 Service Unavailable: …"): fail
  // over to the next endpoint.
  if (RPC_HTTP_5XX_RE.test(msg)) {
    return { code: "rpc_unavailable", humanMessage: "RPC endpoint unreachable", cause };
  }
  if (/429|rate limit/i.test(msg)) {
    return { code: "rpc_rate_limited", humanMessage: "RPC rate-limited - slow down", cause };
  }
  if (/Proxy error|-32056|-32052|403/i.test(msg)) {
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

function classifyByStructure(cause: unknown, msg: string): SdkError | null {
  if (!cause || typeof cause !== "object") return null;
  const e = cause as {
    name?: unknown;
    status?: unknown;
    transport?: unknown;
    invalidResponse?: unknown;
  };

  if (e.name === "TimeoutError") {
    return { code: "rpc_timeout", humanMessage: "Request timed out", cause };
  }
  if (typeof e.status === "number") {
    const humanMessage = msg || `HTTP ${e.status}`;
    if (e.status === 429) return { code: "rpc_rate_limited", humanMessage, cause };
    if (e.status >= 500 && e.status <= 599) {
      return { code: "backend_unavailable", humanMessage, cause };
    }
    return { code: "unknown", humanMessage, cause };
  }
  if (e.transport === true) {
    return {
      code: "backend_unavailable",
      humanMessage: msg ? `Backend unreachable: ${msg}` : "Backend unreachable",
      cause,
    };
  }
  if (e.transport === false) {
    return { code: "unknown", humanMessage: msg || "Request could not be sent", cause };
  }
  if (e.invalidResponse === true) {
    return {
      code: "backend_invalid_response",
      humanMessage: msg || "Backend returned an invalid response",
      cause,
    };
  }
  if (cause instanceof TypeError && FETCH_NETWORK_FAILURE_RE.test(msg)) {
    return { code: "rpc_unavailable", humanMessage: "RPC endpoint unreachable", cause };
  }
  return null;
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
export function contractErrorMapForTests(program: CofferProgram = "cubicPool"): ErrorTable {
  return ERROR_TABLES[program];
}

/**
 * Look up a program error by its numeric code without needing an exception
 * to parse. Returns `undefined` for codes the program does not define.
 */
export function describeProgramError(
  code: number,
  program: CofferProgram = "cubicPool"
): { name: string; message: string; sdkCode: SdkErrorCode } | undefined {
  const hit = ERROR_TABLES[program]?.[code];
  if (!hit) return undefined;
  return { name: hit.name, message: hit.message, sdkCode: hit.code };
}
