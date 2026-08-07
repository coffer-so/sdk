import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

export interface SwapParams {
  user: PublicKey;
  tokenInIndex: number;
  tokenOutIndex: number;
  amountIn: BN;
  /** Hundredths-bps; omit to use SDK config default. */
  slippageHundredthsBps?: number;
  /** Optional explicit minimum; overrides slippage-derived value. */
  minAmountOut?: BN;
}

export interface SwapQuote {
  tokenInIndex: number;
  tokenOutIndex: number;
  amountIn: BN;
  amountOut: BN;
  /** Spot-based upper bound on amountOut; useful for price-impact UI. */
  spotOut: BN;
  /** Absolute price impact in hundredths of basis point. */
  priceImpactHbps: number;
  feeAmount: BN;
  protocolFeeAmount: BN;
  /** Minimum amount_out to pass to the swap ix given the quoted slippage. */
  minAmountOut: BN;
}

export interface AddLiquidityParams {
  user: PublicKey;
  /**
   * Per-token spend CEILING, one entry per pool token, in raw units.
   *
   * ⚠ As of v5.1 (audit M-4 / I-1) this is an upper bound, **not** an exact
   * amount. The program computes the largest strictly-proportional basket
   * that fits inside this vector, deposits that, and leaves the rest in the
   * user's wallet. Passing `[100, 100]` to a 1:9 pool deposits `[11, 100]`,
   * not `[100, 100]`.
   *
   * Consequences for callers:
   *  - Do not render these as "amount you will deposit". Show the quoted
   *    proportional basket and treat this vector as a spend limit.
   *  - Balance checks should validate against the ceiling (that is the most
   *    that can be pulled), but post-tx accounting must read the
   *    `LiquidityAdded` event's `tokenAmounts` for what actually moved.
   *  - Length must equal `pool.tokenCount` or the program reverts with
   *    `InvalidArrayLength` (6064).
   */
  tokenAmounts: BN[];
  /**
   * Slippage floor on BPT minted. Required and must be > 0 — this is the
   * only guard on the join, since `tokenAmounts` is now a ceiling rather
   * than a commitment.
   */
  minimumBptAmount?: BN;
}

export interface RemoveLiquidityParams {
  user: PublicKey;
  bptAmount: BN;
  minimumTokenAmounts?: BN[];
}

/**
 * Single-token deposit ("zap"): deposit one token, the helper swaps it into
 * the pool's proportions and joins on your behalf.
 *
 * Supported on pools of up to 10 tokens as of v5.1 (was 5 — the old cap was
 * a heap-exhaustion limit, audit SF-3). Beyond 10 the program rejects with
 * `PoolTooLargeForZap`.
 *
 * ### Token-2022 transfer fees
 * Transfer-fee mints are supported, but a zap crosses **two** fee-charging
 * hops per token (user→helper→vault on the way in, vault→helper→user for
 * dust), so the user loses roughly **2× the mint's transfer-fee rate on the
 * full notional**, on top of swap and surge fees. `minimumBptAmount` must
 * allow for that or the deposit reverts. Quote it accordingly and say so in
 * the UI — users will otherwise read the shortfall as slippage.
 *
 * Armed transfer hooks are still rejected (`TokenExtensionsUnsupported`).
 */
export interface SingleTokenDepositParams {
  user: PublicKey;
  tokenInIndex: number;
  amountIn: BN;
  /**
   * Used only by the off-chain quote to derive `minimumBptAmount`. There is
   * no per-call slippage argument on the instruction any more — the single
   * `minimumBptAmount` floor bounds the entire zap, and per-leg swaps run
   * with `min_out = 0` (which is what keeps the route correct under the
   * path-dependent surge fee).
   */
  slippageHundredthsBps?: number;
  /**
   * Required, must be > 0. The only slippage guard on the whole route:
   * internal swaps + surge fees + transfer fees + the join.
   */
  minimumBptAmount?: BN;
}

export interface SingleTokenDepositQuote {
  tokenInIndex: number;
  amountIn: BN;
  /** Per-token allocations (sum = amountIn). */
  allocations: BN[];
  /** Per-leg expected swap out. `0` for sidelined tokens. */
  expectedOuts: BN[];
  /** Per-leg min_out derived from slippage. */
  minOuts: BN[];
  /** Amounts the helper will pass to add_liquidity after proportional capping. */
  depositedAmounts: BN[];
  /** Helper-held excess returned to the user after add_liquidity. */
  refundAmounts: BN[];
  /** Projected BPT to receive (ballpark, pre-CPI). */
  estimatedBpt: BN;
  /** Indices of tokens excluded from the deposit (actBal == 0). */
  sidelinedTokenIndices: number[];
}

export interface BuiltTx {
  instructions: TransactionInstruction[];
  /** Accounts that should sign (user is implicit). */
  extraSigners?: PublicKey[];
  /** Suggested CU limit — caller decides whether to prepend ComputeBudget ix. */
  suggestedCuLimit: number;
}

export interface DeployPoolParams {
  payer: PublicKey;
  configKey: PublicKey;
  poolId: BN;
  /**
   * Pool's token mints, in the same order as `weightsBps`/`virtualBalances`.
   * There is no `tokens` field in the on-chain `initialize_cubic_pool` ix
   * data — the program derives the token set solely from remaining_accounts
   * (one mint per token). The SDK still requires this array so it can build
   * that remaining_accounts list in the right order.
   */
  tokens: PublicKey[];
  weightsBps: number[];
  virtualBalances: BN[];
  swapFeeRate: number;
  /** SPL Token program to use for the BPT mint (classic SPL Token recommended). */
  bptTokenProgram?: PublicKey;
  /**
   * Optional creator-chosen Token-2022 banned-extensions bitmap. Omit
   * (`undefined`/`null`) to inherit the config default. Set a bitmap to vet
   * THIS pool's tokens against it and store it on the pool. `0` allows every
   * extension.
   *
   * ⚠ A permissive policy (un-banning PermanentDelegate / TransferHook /
   * TransferFee) makes the pool drainable/abusable by the token issuer —
   * surface this to the user before deploying.
   */
  bannedExtensions?: BN | number | null;
}

// ============================================================
// Range manager
// ============================================================

/**
 * One compare-and-swap entry in a `range_manager_update`.
 *
 * ⚠ `expectedCurrent` was inserted **between** `index` and `newValue` in
 * v5.1 (audit M-6). It is not optional padding and it is not appended at
 * the end: the on-chain struct is `{ index: u8, expected_current: u64,
 * new_value: u64 }` in exactly that order.
 */
export interface TokenChange {
  /** Token index within the pool, `0 .. tokenCount-1`. */
  index: number;
  /**
   * The value the caller believes is currently stored for this token —
   * `virtualBalance` for a `vbChanges` entry, `weightBps` (as a BN) for a
   * `weightChanges` entry.
   *
   * The program compares this against the live value and reverts the whole
   * instruction with `RangeManagerStaleValue` (6061) on any mismatch. This
   * makes every update a compare-and-swap: two managers racing, or a bot
   * replaying a stale quote, can no longer clobber each other's writes.
   *
   * It must come from the same pool read that produced `newValue`. Do not
   * synthesise it, and do not carry it across a re-read — on a stale
   * failure, re-read the pool and recompute both fields together.
   */
  expectedCurrent: BN;
  /** The value to write if `expectedCurrent` still matches. */
  newValue: BN;
}

export interface RangeManagerUpdateParams {
  /** Must be the pool's configured `range_manager` and it must be enabled. */
  authority: PublicKey;
  /** Sparse virtual-balance changes. May be empty. */
  vbChanges?: TokenChange[];
  /**
   * Sparse normalized-weight changes (basis points). May be empty. The
   * resulting weight vector must still sum to 10_000.
   */
  weightChanges?: TokenChange[];
}

export interface SetRangeManagerParams {
  /**
   * Pool's governance config account. New in v5.1 (audit L-1) — it is
   * PREPENDED before `pool` in the account list.
   */
  config: PublicKey;
  /** Pool-admin only; protocol-admin cannot reach this instruction. */
  authority: PublicKey;
  /** Pubkey allowed to call `range_manager_update`. */
  newManager: PublicKey;
  /** Gate flag; `false` blocks the manager even when the pubkey is set. */
  enabled: boolean;
}

export interface SetRangeManagerConfigParams {
  /** Pool-admin only. */
  authority: PublicKey;
  /** Max per-update virtual-balance change, `PERCENT_SCALE` (10_000 = 100%). */
  maxVbChangePct: number;
  /** Max per-update weight change, same units. */
  maxWeightChangePct: number;
  minUpdateIntervalSecs: number;
  /**
   * Absolute UPPER bound on `virtual_balance / actual_balance`, in basis
   * points (10_000 = 1.0×). `0` disables the band. New in v5.1 (M-2/SF-20).
   *
   * The per-update percentage caps velocity, not distance — 5% steps
   * compound to ~131× in 100 updates. This is the distance limit.
   */
  maxLeverageBps: number;
  /**
   * Absolute LOWER bound on the same ratio, same units. `0` disables the
   * floor. New in v5.1.
   */
  minLeverageBps: number;
}
