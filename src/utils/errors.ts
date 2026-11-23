import cofferPoolIdl from "../idl/coffer_pool.json";
import protocolAdminIdl from "../idl/protocol_admin.json";
import singleTokenLiquidityIdl from "../idl/single_token_liquidity.json";
import { SdkError, SdkErrorCode } from "../types/result";

/**
 * Which on-chain program produced an error code.
 *
 * Anchor numbers every program's errors from 6000, so a bare custom-error
 * code is ambiguous across the three Coffer programs — `6030` is
 * `InvalidTokenProgram` in coffer-pool but `TokenExtensionsUnsupported` in
 * single-token-liquidity. Pass this to {@link toSdkError} when you know
 * which program the failing instruction belonged to; without it the
 * coffer-pool table is used, which is the right default for swap / add /
 * remove but WRONG for a zap or an admin call.
 */
export type CofferProgram = "cofferPool" | "singleTokenLiquidity" | "protocolAdmin";

const ANCHOR_NAME_TO_SDK: Record<string, SdkErrorCode> = {
  InvalidTokenCount: "invalid_input",
  InvalidTokenIndex: "invalid_input",
  InvalidWeights: "invalid_input",
  InvalidVirtualBalances: "invalid_input",
  InsufficientLiquidity: "insufficient_funds",
  SlippageExceeded: "slippage_exceeded",
  InvalidAmounts: "invalid_input",
  InsufficientLpOut: "slippage_exceeded",
  InsufficientTokensOut: "slippage_exceeded",
  FeeRateMaxExceeded: "invalid_input",
  ProtocolFeeRateMaxExceeded: "invalid_input",
  MathOverflow: "math_overflow",
  MathUnderflow: "math_overflow",
  DivisionByZero: "math_overflow",
  TokenMintMismatch: "invalid_input",
  InvalidTokenDecimals: "invalid_input",
  AmountOutExceedsBalance: "invalid_input",
  InvalidLpAmount: "invalid_input",
  Unauthorized: "invalid_input",
  InvalidMint: "invalid_input",
  PoolDisabled: "pool_disabled",
  SwapsDisabled: "swaps_disabled",
  MaxSelloffExceeded: "selloff_window_full",
  TokenInactive: "token_swaps_disabled",
  PoolMustBeDisabled: "invalid_input",
  ZeroAmount: "invalid_input",
  ZeroFeeAmount: "invalid_input",
  /** Deprecated in v6.1 (T19): code 6025 is kept for the append-only error table but never raised. */
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

  // ── coffer-pool 6069, v6 ──────────────────────────────────────────────
  /** Legacy-layout migration refused (the v4 → v5 instruction no longer exists; the code stays declared). */
  UnsafeLegacyMigration: "unsupported_pool_state",

  // ── single-token-liquidity 6033–6039, v6 planned zap ─────────────────
  /** The user's input account does not hold the complete `amount_in`. */
  InsufficientInputBalance: "insufficient_funds",
  /** The join tried to spend wallet funds beyond this zap's budget. */
  TokenBudgetExceeded: "invalid_input",
  ZapTokenExtensionsUnsupported: "unsupported_token_extension",
  /** Declared for the removed helper-PDA deposits; never raised by the shipped entry points. */
  AllocationPlanRequired: "plan_invalid",
  InvalidAllocationPlan: "plan_invalid",
  AllocationPlanExpired: "plan_expired",
  AllocationPlanStale: "plan_stale",

  // ── coffer-pool 6055–6068, new in v5.1 ────────────────────────────────
  /** Mint carries a Token-2022 extension the program cannot move (structural; no policy since v6.1). */
  UnsupportedExtension: "invalid_input",
  /** Destination requires a memo — include the SPL Memo program account. */
  MemoProgramMissing: "invalid_input",
  TransferFeeCalculationMismatch: "invalid_input",
  /** The whole deposit was eaten by the mint's transfer fee. */
  AmountFullyConsumedByTransferFee: "amount_too_small",
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
  RangeManagerConcentrationFactorBandExceeded: "invalid_input",
  RangeManagerOverrideMustDisable: "auth_failed",
  /** An array argument's length != the pool's `token_count`. */
  InvalidArrayLength: "invalid_input",
  FirstDepositRequiresNonzero: "invalid_input",
  TokenLivenessMismatch: "invalid_input",
  /** Deposit too small to mint a single unit of LP — increase the amount. */
  DepositTooSmall: "amount_too_small",
  /** Pool holds no liquidity yet; the pool admin must seed it first. */
  PoolNotSeeded: "unsupported_pool_state",

  // ── coffer-pool 6070–6109, v6.1 ───────────────────────────────────────
  /** L0: the pool is still 1683 bytes; prepend / run `migrate_pool_layout_v61`. */
  LayoutVersionMismatch: "pool_layout_outdated",
  /** L0 / T3: the account is already at the v6.1 size (idempotent no-op from the caller's view). */
  AlreadyMigrated: "unsupported_pool_state",
  /** L0 FIX-6: the live mint's decimals differ from the pinned value. */
  PinnedDecimalsMismatch: "unsupported_pool_state",
  /** T2: `seed_liquidity` on a pool whose LP supply is already > 0. */
  PoolAlreadySeeded: "unsupported_pool_state",
  /** T2: `lp_amount > MAX_INITIAL_LP_SUPPLY`. */
  InitialLpSupplyTooLarge: "invalid_input",
  /** T10: `fund_sidelined_token` on a slot with reserves. */
  TokenNotSidelined: "invalid_input",
  /** T1: LP metadata rejected (`validateLpMetadata` mirrors the rules). */
  LpNameInvalid: "invalid_input",
  LpSymbolInvalid: "invalid_input",
  LpUriInvalid: "invalid_input",
  /** T14 */
  CreatorFeeBpsMaxExceeded: "invalid_input",
  /** T14: `disable_pool_admin` while creator fees are owed — claim first. */
  CreatorFeesUnclaimed: "unsupported_pool_state",
  /** T6 */
  RangeManagerLocked: "unsupported_pool_state",
  RangeManagerMustBeUnset: "unsupported_pool_state",
  /** T7 */
  LiquidityFeeMaxExceeded: "invalid_input",
  LiquidityFeesLocked: "unsupported_pool_state",
  LiquidityFeesAlreadyLocked: "unsupported_pool_state",
  /** T7: a 100 % deposit fee closes deposits. */
  DepositFeeConsumesAll: "amount_too_small",
  /** T7: a 100 % withdraw fee closes withdrawals. */
  WithdrawFeeConsumesAll: "amount_too_small",
  /** T12 */
  SurgeBucketOverflow: "math_overflow",
  /** T3: pool-admin cooldown queue. */
  CooldownRequired: "cooldown",
  CooldownNotElapsed: "cooldown",
  NoPendingAction: "cooldown",
  ActionExpired: "cooldown",
  DelayTooLarge: "invalid_input",
  PendingPayloadMismatch: "cooldown",
  /** T9: native hooks. */
  HookDenied: "hook_rejected",
  HookInvalidResponse: "hook_rejected",
  HookCuExceeded: "hook_rejected",
  HookInvalidConfig: "invalid_input",
  HookAccountsInvalid: "invalid_input",
  HookProgramInvalid: "invalid_input",
  HookPaused: "hook_rejected",
  HookRegisterRejected: "hook_rejected",
  HookFlagsMismatch: "hook_rejected",
  /** T22: strict concentrationFactor invariant (6104–6106). */
  VirtualBalanceNotAboveActual: "concentration_factor_invariant",
  VirtualBalanceBelowFloor: "concentration_factor_invariant",
  InvalidVirtualRescale: "invalid_input",
  /** rc2 (6107): `lock_liquidity_fees` / `disable_pool_admin` with a withdraw fee above the lockable cap — lower it first. */
  WithdrawFeeNotLockable: "invalid_input",
  /** rc2 (6108): `set_range_manager(enabled = true)` with the default (all-zero) manager key. */
  RangeManagerKeyRequired: "invalid_input",
  /** rc2 (6109): LP supply at or below the floor — redeem the whole LP balance in one exit. */
  FullExitRequiredBelowFloor: "invalid_input",
  /** Proposed F-02 append (6110); caller slippage cannot override this bound. */
  DepositRoundingLossTooLarge: "deposit_rounding_loss",

  // ── coffer-pool 6111–6115, LP transfer fee (2026-11-19) ──────────────
  /** `initialize_pool` / `set_lp_transfer_fee` with `bps > 1_000`. */
  LpTransferFeeMaxExceeded: "invalid_input",
  /** The pool's LP mint has no `TransferFeeConfig` (pre-feature pool / legacy SPL mint): the feature is unavailable there. */
  LpTransferFeeUnsupported: "unsupported_pool_state",
  /** `set_lp_transfer_fee_protocol_share` with `bps > 10_000`. */
  LpTransferFeeProtocolShareMaxExceeded: "invalid_input",
  /** `redeem_lp_transfer_fees` while nothing is owed — collect first. */
  NoLpTransferFeesOwed: "unsupported_pool_state",
  /** The LP fee account holds less than `lp_transfer_fees_owed_protocol + lp_transfer_fees_pending_burn` (state corruption / foreign burn). */
  LpFeeAccountUnderfunded: "unsupported_pool_state",

  // ── coffer-pool 6116–6119, v6.1 rc5 (exit gate + pool-native route) ──
  /** rc5 (6116): `remove_liquidity` / `redeem_lp_transfer_fees` burn that pays zero raw units on every slot while the pool holds assets. */
  ExitPaysNothing: "amount_too_small",
  /** rc5 (6117): `swap_route_join_v1` `allocations.len() != token_count`. */
  RouteAllocationsLength: "invalid_input",
  /** rc5 (6118): `swap_route_join_v1` with no positive allocation outside the input slot. */
  RouteNoLegs: "invalid_input",
  /** rc5 (6119): fewer compute units left than one more route leg needs — raise the CU limit. */
  RouteComputeBudgetInsufficient: "simulation_failed",
  /** STLD rc5 (6040): the pool's `RouteReturnV1` was missing / foreign / inconsistent with the wallet deltas. */
  RoutedReturnDataInvalid: "simulation_failed",

  // ── coffer-pool 6120–6121 ────────────────────────────────────────────
  /** 6120: a fee / debug-withdraw recipient that is one of the pool's own vaults. */
  RecipientIsVault: "invalid_input",
  /** 6121: `max_selloff_pct` rounds to a zero cap against the slot's virtual balance — raise the percentage or the virtual balance. */
  MaxSelloffCapZero: "invalid_input",
  /** STLD 6041: `close_helper_token_account` destination is not the authority's token account of the same mint. */
  InvalidRecoveryDestination: "invalid_input",

  // ── protocol-admin ───────────────────────────────────────────────────
  /** New admin cannot be the all-zero pubkey. */
  InvalidAdmin: "invalid_input",
  // T5: a `pool_collect_protocol_fees` recipient that is not the Treasury
  // vault PDA is refused with the existing `InvalidVault` (6002).
  /** T3: protocol-admin cooldown queue (6010–6018); the shared names map above. */
  PendingAccountsMismatch: "cooldown",
  BufferAuthorityMismatch: "invalid_input",
  /** Proposed F-01 append (6019): a full payload and rent exemption are required. */
  UpgradeBufferNotLive: "invalid_input",
  /** 6020: `close_pool_program` / `ProgramOp` close targeting protocol-admin itself. */
  SelfCloseForbidden: "invalid_input",

  // ── single-token-liquidity 6030–6032, new in v5.1 ────────────────────
  /** Zap route can't carry an armed transfer hook's extra accounts. */
  TokenExtensionsUnsupported: "unsupported_pool_state",
  InsufficientHelperSol: "insufficient_funds",
  /** Pool exceeds `STLD_MAX_TOKENS` (10) — use `add_liquidity` instead. */
  PoolTooLargeForZap: "unsupported_pool_state",
};

type AnchorIdlError = { code: number; name: string; msg: string };
type ErrorTable = Record<number, { code: SdkErrorCode; message: string; name: string }>;

/**
 * User-facing messages where the IDL `msg` is too terse to act on. Keyed by
 * error name; everything else shows the program's own message.
 */
const USER_MESSAGES: Record<string, string> = {
  // T22 (6104–6106)
  VirtualBalanceNotAboveActual:
    "Each token's virtual balance must stay strictly above its actual balance. Seed / fund amounts must be below the slot's virtual balance; " +
    "a legacy pool at or below the line is frozen for swaps and deposits until the protocol admin runs rescale_virtual_balances (exits still work).",
  VirtualBalanceBelowFloor:
    "A virtual balance is below the per-slot minimum of one whole token (max(10^decimals, 1000) raw units). Raise it when creating the pool, " +
    "in the range-manager update, or pick a larger rescale multiplier.",
  InvalidVirtualRescale: "The rescale multiplier must be an integer ≥ 2 (1 is a no-op, 0 would zero every price).",
  // LP transfer fee (6111–6115)
  LpTransferFeeMaxExceeded: "The LP transfer fee is capped at 10 % (1_000 bps) — at pool creation and in set_lp_transfer_fee.",
  LpTransferFeeUnsupported:
    "This pool's LP mint has no Token-2022 transfer fee extension (created before the LP transfer fee feature, or a legacy SPL LP mint): " +
    "set_lp_transfer_fee, collect_lp_transfer_fees and redeem_lp_transfer_fees are unavailable for it.",
  LpTransferFeeProtocolShareMaxExceeded: "The protocol share of collected LP transfer fees is capped at 100 % (10_000 bps).",
  NoLpTransferFeesOwed: "The protocol has no collected LP transfer fees to redeem on this pool — run collect_lp_transfer_fees first.",
  LpFeeAccountUnderfunded:
    "The pool's LP fee account holds less LP than the protocol is owed plus the unburned stream (lp_transfer_fees_owed_protocol + lp_transfer_fees_pending_burn); the pool's fee bookkeeping is inconsistent — do not redeem.",
  // rc5 (6116–6119 coffer_pool, 6040 STLD)
  ExitPaysNothing:
    "This LP amount is too small to withdraw a single raw unit of any pool token. Withdraw a larger LP amount " +
    "(for redeem_lp_transfer_fees: wait until more LP transfer fees are owed).",
  RouteAllocationsLength: "The route needs exactly one allocation per pool token (allocations.length must equal the pool's token count).",
  RouteNoLegs: "The route has no swap leg: at least one token other than the input needs a positive allocation (use add_liquidity otherwise).",
  RouteComputeBudgetInsufficient:
    "The transaction ran out of compute units before the next route leg. Request a higher compute unit limit (up to 1_400_000) " +
    "or deposit through the planned (multi-CPI) route.",
  RoutedReturnDataInvalid:
    "The routed single-token deposit could not verify the pool's route result against your token balances; nothing was deposited. " +
    "Retry, or use the planned single-token deposit.",
  // 6120–6121 coffer_pool, 6020 protocol_admin, 6041 STLD
  RecipientIsVault: "A recipient token account must not be one of the pool's own vaults — pass a wallet-owned (or Treasury vault) token account.",
  MaxSelloffCapZero:
    "The max-selloff percentage is too small for this token's virtual balance: the per-window cap would round to zero and block every sale. " +
    "Raise max_selloff_pct (or the virtual balance), or disable the sell-off limit with 0.",
  SelfCloseForbidden: "The protocol-admin program cannot close itself; close_pool_program / ProgramOp(close) accept only the other programs.",
  InvalidRecoveryDestination:
    "close_helper_token_account: the swept balance may only go to a token account of the same mint owned by the authority " +
    "(through protocol-admin: the Treasury vault PDA of that mint).",
};

function buildErrorTable(errors: AnchorIdlError[]): ErrorTable {
  return Object.fromEntries(
    errors.map((anchorError) => [
      anchorError.code,
      {
        code: ANCHOR_NAME_TO_SDK[anchorError.name] ?? "invalid_input",
        message: USER_MESSAGES[anchorError.name] ?? anchorError.msg,
        name: anchorError.name,
      },
    ])
  );
}

const ERROR_TABLES: Record<CofferProgram, ErrorTable> = {
  cofferPool: buildErrorTable(cofferPoolIdl.errors as AnchorIdlError[]),
  protocolAdmin: buildErrorTable(protocolAdminIdl.errors as AnchorIdlError[]),
  singleTokenLiquidity: buildErrorTable(singleTokenLiquidityIdl.errors as AnchorIdlError[]),
};

const CONTRACT_ERROR_MAP = ERROR_TABLES.cofferPool;

/**
 * rc5 routed-deposit discriminators: STLD `deposit_single_token_routed` and
 * coffer-pool `swap_route_join_v1` (pinned; tests tie them to the builders).
 */
const ROUTED_DEPOSIT_DISCRIMINATORS_HEX = ["f782dde3cee774af", "c81d70ad5bfad0c2"];

/** What the failing transaction was, when the error alone cannot tell. */
export interface SdkErrorContext {
  /** The transaction was a routed deposit (`deposit_single_token_routed` / `swap_route_join_v1`). */
  routedDeposit?: boolean;
  /**
   * The failing transaction's instructions (`TransactionInstruction[]` or
   * `versionedTx.message.compiledInstructions`); a routed deposit is detected
   * from the instruction discriminators.
   */
  instructions?: ReadonlyArray<{ data: Uint8Array }>;
}

/** True when any instruction is `deposit_single_token_routed` or `swap_route_join_v1` (by discriminator). */
export function containsRoutedDepositInstruction(instructions: ReadonlyArray<{ data: Uint8Array }>): boolean {
  return instructions.some((ix) => ix.data.length >= 8 && ROUTED_DEPOSIT_DISCRIMINATORS_HEX.includes(Buffer.from(ix.data.subarray(0, 8)).toString("hex")));
}

const ROUTED_HEAP_FRAME_MESSAGE =
  "The routed single-token deposit failed to complete: the pool ran out of heap (or compute). The transaction must request a 64 KiB heap frame " +
  "(ComputeBudgetProgram.requestHeapFrame({ bytes: 65536 }), ROUTED_ZAP_HEAP_FRAME_BYTES) and enough compute units (setComputeUnitLimit, up to 1_400_000) — " +
  "use depositRouted() / buildRoutedTx() or compileTransaction({ heapFrameBytes: ROUTED_ZAP_HEAP_FRAME_BYTES }), or deposit through the planned route.";

/**
 * Convert a raw error (possibly from Anchor, web3.js, or fetch) into a
 * cleanly-typed SdkError. Used by safeCall wrappers so callers always
 * get structured errors, never exceptions.
 *
 * @param program Which Coffer program the failing instruction belonged to.
 *   Anchor numbers each program's errors from 6000 independently, so the
 *   same code means different things in different programs. Defaults to
 *   `"cofferPool"` (correct for swap / add / remove liquidity). Pass
 *   `"singleTokenLiquidity"` for zap failures and `"protocolAdmin"` for
 *   treasury-routed admin calls, or the message will be plausible and wrong.
 * @param context What the failing transaction was. With `routedDeposit: true`
 *   (or `instructions` containing a routed deposit), a `ProgramFailedToComplete`
 *   / "Program failed to complete" failure maps to `routed_heap_frame_required`
 *   (the pool hit its heap limit: the transaction lacks `requestHeapFrame(64 KiB)`).
 *   Without that context the failure stays `unknown`: other instructions fail
 *   to complete for unrelated reasons.
 */
export function toSdkError(cause: unknown, program: CofferProgram = "cofferPool", context?: SdkErrorContext): SdkError {
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
  const routed = context?.routedDeposit === true || (context?.instructions !== undefined && containsRoutedDepositInstruction(context.instructions));
  if (routed && /ProgramFailedToComplete|Program failed to complete/i.test(msg)) {
    return { code: "routed_heap_frame_required", humanMessage: ROUTED_HEAP_FRAME_MESSAGE, cause };
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
export function contractErrorMapForTests(program: CofferProgram = "cofferPool"): ErrorTable {
  return ERROR_TABLES[program];
}

/**
 * Look up a program error by its numeric code without needing an exception
 * to parse. Returns `undefined` for codes the program does not define.
 */
export function describeProgramError(
  code: number,
  program: CofferProgram = "cofferPool"
): { name: string; message: string; sdkCode: SdkErrorCode } | undefined {
  const hit = ERROR_TABLES[program]?.[code];
  if (!hit) return undefined;
  return { name: hit.name, message: hit.message, sdkCode: hit.code };
}
