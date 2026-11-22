// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Endgame AMM DEX Foundation.
// See LICENSE at the repository root.

/**
 * @coffer_so/sdk — client library for the Cubic Pool AMM on Solana.
 *
 * Entry point barrel. Most consumers will want to import from this root:
 *
 * ```ts
 * import { CubicPoolClient, CofferBackendClient, getConfig } from "@coffer_so/sdk";
 *
 * const cfg = getConfig("mainnet", { backendEndpoint: "https://api.coffer.so" });
 * const pool = new CubicPoolClient({ config: cfg, poolAddress });
 * const info = await pool.sync();
 * if (info.ok) console.log(info.data.tokens.map(t => t.metadata?.symbol));
 * ```
 */

export * from "./config";
export * from "./types";
export * from "./utils";
export * from "./math";
export * from "./parsers";
export * from "./clients";
export * from "./idl";
export * from "./rewards";

// Explicit runtime re-exports keep CommonJS output statically discoverable for
// Vite/Rollup consumers that import named exports from the package root.
export {
  getConfig,
  programId,
  CUBIC_POOL_SEED,
  BPT_MINT_SEED,
  STLD_HELPER_SEED,
  TREASURY_SEED,
  WEIGHT_SCALE,
  MIN_WEIGHT,
  MAX_WEIGHT,
  MIN_TOKENS,
  MAX_TOKENS,
  BPT_DECIMALS,
  SWAP_FEE_PRECISION,
  PROTOCOL_FEE_PRECISION,
  PERCENT_SCALE,
  MAX_SWAP_FEE_RATE,
  MAX_PROTOCOL_FEE_RATE,
  MINIMUM_INITIAL_BPT,
  SLIPPAGE_PRECISION,
  MIN_SLIPPAGE_HBPS,
} from "./config";
export {
  NETWORK_PROGRAMS,
  DEFAULT_RPC_ENDPOINT,
  DEFAULT_RPC_ENDPOINTS,
  DEFAULT_RPC_TIMEOUT_MS,
} from "./config/networks";
export { KNOWN_TOKENS, resolveKnownToken } from "./config/tokens";
export { ok, err } from "./types/result";
export {
  ONE,
  mulDown,
  mulUp,
  divDown,
  divUp,
  complement,
  weightToFp,
} from "./math/fixedPoint";
export { lnFp, expFp, powFp } from "./math/logExp";
export {
  calcOutGivenIn,
  calcBptOutGivenExactTokensIn,
  calcTokensOutGivenBptIn,
  calcSpotOut,
} from "./math/cubicMath";
export { validateWeights, calcSpotPrice } from "./math/weightedMath";
export {
  capDepositAmountsToLpRatio,
  computeAllocations,
  computeTwoTokenOptimalAllocations,
} from "./math/singleToken";
export { applySlippage, applySwapFee, lpBalances, priceImpactHbps } from "./math/slippage";
export {
  computeSelloffWindow,
  projectSelloffWindow,
  calcSurgeFeePct,
  calcSurgeFeeAmount,
  calcSegmentedSurgeFeeAmount,
  SURGE_FEE_SEGMENTS,
} from "./math/maxSelloff";
export { RpcClient } from "./clients/RpcClient";
export { CofferBackendClient } from "./clients/CofferBackendClient";
export { CubicPoolClient } from "./clients/CubicPoolClient";
export { SingleTokenDepositClient } from "./clients/SingleTokenDepositClient";
export { PoolFactoryClient } from "./clients/PoolFactoryClient";
export { AdminClient } from "./clients/AdminClient";
export {
  buildSwapIx,
  buildSwapTx,
  buildAddLiquidityIx,
  buildAddLiquidityTx,
  buildRemoveLiquidityIx,
  buildRemoveLiquidityTx,
  buildSingleTokenDepositIx,
  buildSingleTokenDepositTx,
  buildSingleTokenDepositTxs,
  buildSingleTokenDepositAtaIxs,
  buildInitializeConfigIx,
  buildPoolInitializeConfigIx,
  buildInitializeCubicPoolIx,
  buildDeployPoolTx,
  buildInitializePoolAltIx,
  buildInitializePoolAltTx,
  buildSetRangeManagerIx,
  buildSetRangeManagerConfigIx,
  buildRangeManagerUpdateIx,
  deriveAltAddress,
  STLD_MAX_TOKENS,
  STLD_DEPOSIT_CU_LIMIT,
} from "./clients/tx-builders";
export { buildVersionedTx, compileBuiltTx } from "./clients/versioned";
export type { InitializePoolAltParams } from "./clients/tx-builders";
export { decodePoolAccount, POOL_DISCRIMINATOR_LEN, POOL_LEN, POOL_V4_LEN } from "./parsers/poolAccount";
export { toSdkError, describeProgramError } from "./utils/errors";
export { decodeMintAccount } from "./parsers/mintAccount";
export { parseCubicPoolEvents } from "./parsers/events";
export { BorshReader } from "./parsers/borsh";
export { getRewardsApiError } from "./clients/CofferBackendClient";
export { buildContractInstructionWithProgramId } from "./clients/contract-instructions";
export { COFFER_REWARDS_IDL } from "./idl";
export {
  COFFER_REWARDS_PROGRAM_ID,
  SPL_MEMO_PROGRAM_ID,
  REWARD_CAMPAIGN_SEED,
  REWARD_RECEIPT_SEED,
  REWARD_SOL_VAULT_SEED,
  REWARD_CAMPAIGN_LEN,
  REWARD_RECEIPT_LEN,
  REWARD_PAID_LEN,
  REWARD_CAMPAIGN_METADATA_MAX,
  REWARD_CAMPAIGN_DISCRIMINATOR,
  REWARD_RECEIPT_DISCRIMINATOR,
  REWARD_PAID_DISCRIMINATOR,
  REWARD_VOUCHER_DOMAIN,
  REWARD_VOUCHER_MESSAGE_LEN,
  REWARD_VERIFY_IX_LEN,
  REWARD_CLAIM_CU_LIMIT,
  REWARD_SOL_VAULT_RENT_LAMPORTS,
  REWARD_RECEIPT_RENT_LAMPORTS,
  boostsCampaignId,
  deriveRewardCampaignPda,
  deriveRewardReceiptPda,
  deriveRewardSolVaultPda,
  deriveRewardTokenVault,
  rewardVoucherMessage,
  rewardVerificationInstruction,
  parseRewardVoucher,
  decodeRewardCampaignAccount,
  decodeRewardReceiptAccount,
  decodeRewardPaidEvent,
  parseRewardPaidEvents,
  parseRewardMintTransferFee,
  rewardTransferFeeAt,
  rewardClaimPayout,
  rewardVaultSpendable,
  rewardTokenAccountInfo,
  assertRewardSigner,
  buildRewardClaimIx,
  buildRewardClaimTx,
  loadRewardClaimState,
  buildRewardInitializeIx,
  buildRewardDepositIx,
  buildRewardWithdrawIx,
  buildRewardRotateSignerIx,
  buildRewardReturnSurplusIx,
} from "./rewards";

export type {
  CofferConfig,
  CofferConfigOverrides,
  ProgramIdKind,
  Network,
  NetworkPrograms,
  TokenInfo,
} from "./config";
export type {
  SdkResult,
  SdkError,
  SdkErrorCode,
  PoolTokenInfo,
  PoolInfo,
  PoolSummary,
  SwapParams,
  SwapQuote,
  AddLiquidityParams,
  RemoveLiquidityParams,
  SingleTokenDepositParams,
  SingleTokenDepositQuote,
  BuiltTx,
  DeployPoolParams,
  CubicPoolEvent,
  PoolInitializedEvent,
  SwapEvent,
  LiquidityAddedEvent,
  LiquidityRemovedEvent,
  ProtocolFeesCollectedEvent,
  PoolEnabledUpdatedEvent,
  SwapsEnabledUpdatedEvent,
  SingleTokenDepositEvent,
  PoolStateLogEvent,
  MaxSelloffWindowAdvancedEvent,
  BannedExtensionsUpdatedEvent,
  UnknownEvent,
  TokenChange,
  RangeManagerUpdateParams,
  SetRangeManagerParams,
  SetRangeManagerConfigParams,
} from "./types";
export type { CofferProgram } from "./utils/errors";
export type {
  AllocationResult,
} from "./math/singleToken";
export type {
  SelloffWindowInputs,
  SelloffWindowStatus,
  WindowProjection,
} from "./math/maxSelloff";
export type {
  RawPoolAccount,
  RawMintAccount,
} from "./parsers";
export type {
  RpcClientParams,
  CofferBackendClientParams,
  StatsKind,
  StatsWindow,
  StatsSeriesPoint,
  StatsSeries,
  PriceMap,
  LeaderboardEntry,
  LeaderboardResponse,
  LeaderboardUserStats,
  XpAccrualHistoryEntry,
  XpAccrualHistoryResponse,
  EpochHistoryEntry,
  LeaderboardEpochResponse,
  CampaignStatusResponse,
  CampaignInfoResponse,
  CampaignPrizeTier,
  CampaignPoolRef,
  CampaignBonus,
  CampaignRules,
  CampaignRankResponse,
  CampaignTopEntry,
  CampaignTopResponse,
  EpochSnapshotMethod,
  EpochSnapshotEntry,
  EpochSnapshotResponse,
  EpochSnapshotUser,
  CampaignHistoryEntry,
  CampaignSnapshotTopEntry,
  CampaignSnapshotTopResponse,
  CampaignSnapshotUserResponse,
  PortfolioChartMetric,
  PublicPortfolioChartMetric,
  PortfolioChartRange,
  PortfolioChartResponse,
  PairChartRange,
  TokenPairChartResponse,
  PoolChartMetric,
  PoolChartRange,
  PoolChartBasis,
  PoolChartPoint,
  PoolChartResponse,
  PoolTokenPriceBounds,
  PoolTokenChartEntry,
  PoolTokenChartResponse,
  PortfolioActivityType,
  PortfolioActivityFilter,
  ActivityTokenInfo,
  PortfolioActivityItem,
  PortfolioActivityResponse,
  SortOrder,
  PortfolioActivitySortField,
  PortfolioHoldingsSortField,
  PortfolioHoldingItem,
  PortfolioHoldingsResponse,
  PortfolioPositionsSortField,
  PortfolioPositionItem,
  PortfolioPositionsResponse,
  AttributionLandingInput,
  AttributionLandingResponse,
  AttributionClaimResponse,
  UsernameSource,
  UserProfileCard,
  PublicProfile,
  MyProfile,
  UserProfileCardsResponse,
  UpdateMyProfileBody,
  CreatePoolBody,
  PoolImageResponse,
  NonceResponse,
  TxChallengeResponse,
  AuthTokens,
  SwapRouteEntry,
  SwapRouteResponse,
  PoolBoostStatus,
  PoolBoostItem,
  PoolBoost,
  PoolBoostSnapshot,
  PublicBoostPool,
  PublicBoostsResponse,
  PublicCampaign,
  PublicCampaignsResponse,
  WalletCampaignRewards,
  WalletBoostRewards,
  WalletRewardsResponse,
  RewardVoucherResponse,
  RewardVoucherErrorCode,
  RewardsApiErrorBody,
  RewardsApiError,
  CubicPoolClientParams,
  SingleTokenDepositClientParams,
  PoolFactoryClientParams,
  InitializeConfigParams,
} from "./clients";

export { buildContractInstruction } from "./clients/contract-instructions";
export { decodeContractAccount, decodeContractEvent, parseContractEvents } from "./parsers/contracts";
export type { ContractEvent } from "./parsers/contracts";
export type { ContractInstructionArgs, ContractInstructionAccounts } from "./clients/contract-instructions";
export type {
  RewardsCluster,
  ParsedRewardVoucher,
  ParseRewardVoucherExpect,
  RewardCampaignAccount,
  RewardReceiptAccount,
  RewardPaidEvent,
  RewardTransferFee,
  RewardTransferFeeConfig,
  RewardClaimFailure,
  RewardClaimPayout,
  RewardClaimPayoutInput,
  RewardCampaignAsset,
  RewardClaimIxParams,
  RewardInitializeIxParams,
  RewardLiquidityIxParams,
  RewardReturnSurplusIxParams,
  RewardClaimState,
  BuildRewardClaimTxOptions,
  RewardClaimTx,
  LoadRewardClaimStateOptions,
  LoadedRewardClaimState,
} from "./rewards";
export type { ContractProgram, ContractInstructionMap, ContractAccountMap, ContractEventMap, ContractTypes } from "./types/contracts";
export { buildSetSwapFeeRateIx, buildSetMaxSelloffIx, buildInitiatePoolAdminTransferIx, buildAcceptPoolAdminTransferIx, buildCancelPoolAdminTransferIx, buildDisablePoolAdminIx, buildGetPoolInfoIx } from "./clients/tx-builders";
export type { SelloffParams, AddLiquidityQuote } from "./types/tx";
export { calculateSwapFee, calculateProtocolFee } from "./math/slippage";
export { checkAndAdvanceSelloff, rescaleSelloffWindow } from "./math/maxSelloff";
export type { SelloffState, SelloffResult } from "./math/maxSelloff";
export type { SurgeCurve } from "./math/surgeFee";
export { calculateInvariant } from "./math/weightedMath";

export { MintExtension, MAX_KNOWN_MINT_EXTENSION, HARD_UNSUPPORTED_MINT_EXTENSIONS, DEFAULT_BANNED_EXTENSIONS, mintExtensionName, parseMintExtensions, unsupportedMintExtensions, bannedMintExtensions, describeUnsupportedToken, assertTokensSupported } from "./utils/extensions";

// ── Legacy aliases (pre-rebrand identifiers) ────────────────────────────
// The package was renamed @cubee_ee/sdk → @coffer_so/sdk. These aliases
// keep old import names compiling so migration is just a package-name
// swap. New code should use the Coffer* names.
/** @deprecated Use `CofferBackendClient`. */
export { CofferBackendClient as CubeBackendClient } from "./clients/CofferBackendClient";
/** @deprecated Use `CofferConfig` / `CofferConfigOverrides`. */
export type {
  CofferConfig as CubeConfig,
  CofferConfigOverrides as CubeConfigOverrides,
} from "./config";
/** @deprecated Use `CofferProgram`. */
export type { CofferProgram as CubeProgram } from "./utils/errors";
/** @deprecated Use `CofferBackendClientParams`. */
export type { CofferBackendClientParams as CubeBackendClientParams } from "./clients";
