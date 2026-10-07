import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
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
  /**
   * v6 remaining-account tail: transfer-hook extras and/or the memo program
   * for Token-2022 legs (`resolveSwapExtraAccounts`). Omit for pools whose
   * mints have no armed hook and no memo-requiring destinations.
   */
  extraAccounts?: AccountMeta[];
}

export interface SwapQuote {
  tokenInIndex: number;
  tokenOutIndex: number;
  /** Gross input the user signs for. */
  amountIn: BN;
  /**
   * Token-2022 transfer fee withheld on the input leg (`0` for fee-less
   * mints). The vault receives `amountInNet = amountIn − transferFeeIn`;
   * fees, the sell-off window and the curve all work on the net.
   */
  transferFeeIn: BN;
  amountInNet: BN;
  /**
   * What leaves the vault after the surge fee — the `Swap` event's
   * `amount_out`. With an output-side transfer fee the user receives less:
   * see `amountOutReceived`.
   */
  amountOut: BN;
  /** Output before the sell-off surge fee (equals amountOut + surgeFeeAmount). */
  grossAmountOut?: BN;
  /** Token-2022 transfer fee withheld on the output leg (`0` for fee-less mints). */
  transferFeeOut: BN;
  /** `amountOut − transferFeeOut`: what lands in the user's token account. */
  amountOutReceived: BN;
  /** Spot-based upper bound on amountOut; useful for price-impact UI. */
  spotOut: BN;
  /** Absolute price impact in hundredths of basis point. */
  priceImpactHbps: number;
  /** Swap fee, in the input token, charged on `amountInNet`. */
  feeAmount: BN;
  protocolFeeAmount: BN;
  /**
   * Minimum to pass to the swap ix given the quoted slippage. The program
   * compares it to `amountOutReceived` (post-surge, post-transfer-fee).
   */
  minAmountOut: BN;
  /** Variable sell-off surge fee taken from the output. `0` when no surge. */
  surgeFeeAmount: BN;
  /** Static fee (in PERCENT_SCALE units) + surge pct, for UI display. */
  effectiveFeePct: number;
  /** Post-trade window fill in PERCENT_SCALE units. `0` when window disabled. */
  windowFillPct: number;
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
  /** v6 remaining-account tail (`resolveAddLiquidityExtraAccounts`); see `SwapParams.extraAccounts`. */
  extraAccounts?: AccountMeta[];
}

/**
 * Result of `CubicPoolClient.quoteAddLiquidity`. Mirrors
 * `cubic-pool/add_liquidity.rs`: the program crops the caller's ceiling
 * vector to the single limiting ratio `min_i(amount_i / actual_i)`, pulls
 * `depositAmounts` and leaves `refundAmounts` in the wallet.
 */
export interface AddLiquidityQuote {
  /** The ceiling vector that was quoted (echo of the input). */
  tokenAmounts: BN[];
  /**
   * What the program will actually debit per token (`charged_amounts`):
   * the credited basket grossed up by each mint's transfer fee. Same as
   * `chargedAmounts`.
   */
  depositAmounts: BN[];
  /** `tokenAmounts − depositAmounts`; stays in the user's wallet. Same as `unspentAmounts`. */
  refundAmounts: BN[];
  /** Alias of `depositAmounts` (the handler's name). */
  chargedAmounts: BN[];
  /**
   * What the pool credits per token (`credited_amounts`): the net basket,
   * rounded UP from the limiting ratio (`calc_deposit_credit`). Equals
   * `chargedAmounts` for fee-less mints.
   */
  creditedAmounts: BN[];
  /** Alias of `refundAmounts`. */
  unspentAmounts: BN[];
  /** Per-token Token-2022 transfer fee paid on top of the credit (`chargedAmounts − creditedAmounts`). */
  transferFees: BN[];
  /** Per-token virtual balance after the join (`virtual_balance_after_deposit`). */
  virtualBalancesAfter: BN[];
  /** BPT the program will mint for this basket at the synced state. */
  bptOut: BN;
  /** `bptOut` after the quoted slippage; pass as `minimumBptAmount`. */
  minimumBptAmount: BN;
  /** Index of the token that limits the basket (smallest net amount / balance); `-1` for the seed deposit. */
  limitingTokenIndex: number;
}

export interface RemoveLiquidityParams {
  user: PublicKey;
  bptAmount: BN;
  /** Floors on what the user RECEIVES per token (post transfer fee); derive from `quoteRemove().receivedAmounts`. */
  minimumTokenAmounts?: BN[];
  /** v6 remaining-account tail (`resolveRemoveLiquidityExtraAccounts`); see `SwapParams.extraAccounts`. */
  extraAccounts?: AccountMeta[];
}

/** Result of `CubicPoolClient.quoteRemove` (mirrors `remove_liquidity.rs`). */
export interface RemoveLiquidityQuote {
  /** Gross vault payouts per token (`calc_tokens_out_given_bpt_in`, floor). */
  tokenOuts: BN[];
  /** Token-2022 transfer fee withheld per token (`0` for fee-less mints). */
  transferFees: BN[];
  /**
   * `tokenOuts − transferFees`: what lands in the user's accounts. The
   * program compares `minimum_token_amounts` to these; derive the floors
   * from them.
   */
  receivedAmounts: BN[];
  /** Burn after the contract's `MINIMUM_INITIAL_BPT` clamp (`calc_effective_bpt_burn`). */
  effectiveBptIn: BN;
  /** Per-token virtual balance after the exit (`virtual_balance_after_withdrawal`). */
  virtualBalancesAfter: BN[];
}

/**
 * v6 planned zap (`deposit_single_token_planned`): deposit one token; the
 * program executes the swaps and the proportional join of a plan the SDK
 * computed off-chain (`PlannedZapClient.quote`). Supported on pools of 2..10
 * tokens; the single `minimumBpt` floor is the only slippage guard on the
 * whole route (internal swaps run with `min_out = 0`).
 */
export interface PlannedZapQuoteOptions {
  /** Hundredths-bps slippage on the estimated BPT; omit to use the SDK default. */
  slippageHundredthsBps?: number;
  /** Plan validity in slots from the snapshot slot (1..150, default 120 ≈ 48 s). */
  validForSlots?: number;
  /**
   * Clock seconds to simulate the route at (window decay only); defaults to
   * the snapshot's `unix_timestamp`. The plan's `quotedAt` is ALWAYS the
   * snapshot timestamp, so the program's 90 s age check is unaffected.
   */
  nowSeconds?: number;
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
   * THIS pool's tokens against it and store it on the pool. `0` clears the
   * configurable default; the hard floor and runtime restrictions still apply.
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
  /** Pool admin, or config protocol admin for disable-only with the same manager. */
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

/** Per-token sell-off policy, in pool order. Percent fields use 10,000 = 100%,
 * except feeKinkPct, which is a whole percent (0 disables the kink).
 */
export interface SelloffParams {
  maxSelloffPct: number;
  periodLength: number;
  feeThresholdPct: number;
  feeSlopeLowPct: number;
  feeSlopeHighPct: number;
  feeSlopeMidPct: number;
  feeKinkPct: number;
}
