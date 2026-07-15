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
  /** Variable sell-off surge fee taken from the output. `0` when no surge. */
  surgeFeeAmount: BN;
  /** Static fee (in PERCENT_SCALE units) + surge pct, for UI display. */
  effectiveFeePct: number;
  /** Post-trade window fill in PERCENT_SCALE units. `0` when window disabled. */
  windowFillPct: number;
}

export interface AddLiquidityParams {
  user: PublicKey;
  tokenAmounts: BN[];
  minimumBptAmount?: BN;
}

export interface RemoveLiquidityParams {
  user: PublicKey;
  bptAmount: BN;
  minimumTokenAmounts?: BN[];
}

export interface SingleTokenDepositParams {
  user: PublicKey;
  tokenInIndex: number;
  amountIn: BN;
  slippageHundredthsBps?: number;
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
