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
  calcJoinRatioAndBpt,
  calcTokensOutGivenBptIn,
  calcSpotOut,
  calcDepositCredit,
  virtualBalanceAfterDeposit,
  virtualBalanceAfterWithdrawal,
  calcEffectiveBptBurn,
} from "./math/cubicMath";
export { ceilDiv, MathError } from "./math/fixedPoint";
export { selectEpochFee, transferFeeOf, netOfTransferFee, inverseTransferFee, grossOfTransferFee, MAX_FEE_BASIS_POINTS } from "./math/transferFee";
export type { TransferFee, TransferFeeConfig } from "./math/transferFee";
export { validateWeights, calcSpotPrice } from "./math/weightedMath";
export { computeAllocations } from "./math/singleToken";
export { quoteZap, replay, swapInPool, validatePlanBudget, validateQuotePool, SimError, isSimFailure } from "./math/planner";
export type { QuotePool, ZapQuote, PlannerSwapQuote } from "./math/planner";
export { applySlippage, applySwapFee, lpBalances, priceImpactHbps } from "./math/slippage";
export { computeSelloffWindow, projectSelloffWindow } from "./math/maxSelloff";
export { calcSurgeFeeRate, calcSurgeFeePct, calcSurgeFeeAmount, SURGE_FEE_SEGMENTS } from "./math/surgeFee";
export type { SurgeFeeAmountParams } from "./math/surgeFee";
export { RpcClient } from "./clients/RpcClient";
export { CofferBackendClient } from "./clients/CofferBackendClient";
export { CubicPoolClient } from "./clients/CubicPoolClient";
export { PlannedZapClient } from "./clients/plannedZap/PlannedZapClient";
export type { PlannedZapClientParams, PlannedZapQuote } from "./clients/plannedZap/PlannedZapClient";
export { buildPlannedZapIx, plannedZapAccounts, encodeAllocationPlan, PLANNED_ZAP_CU_LIMIT, PLANNED_ZAP_MAX_TOKENS, PLANNED_ZAP_MIN_TOKENS, PLANNED_ZAP_DISCRIMINATOR_HEX } from "./clients/plannedZap/instruction";
export type { AllocationPlan, PlannedZapAccounts, PlannedZapArgs } from "./clients/plannedZap/instruction";
export { stateCommitment, PLAN_DOMAIN, MAX_PLAN_AGE_SECONDS, MAX_VALID_FOR_SLOTS, V6_PLAN_HASH_VECTOR } from "./clients/plannedZap/stateCommitment";
export type { SnapshotAccount } from "./clients/plannedZap/stateCommitment";
export { buildWalletLookupPreparation, resolveWalletLookupTable, waitForWalletLookupTable, compilePlannedZapTransaction, PACKET_BYTES, DEFAULT_SETUP_WALLET_RESERVE, DEFAULT_FINANCIAL_WALLET_RESERVE } from "./clients/plannedZap/walletAlt";
export type { AltConnection, WalletLookupPreparation, CompiledPlannedZap } from "./clients/plannedZap/walletAlt";
export { PoolFactoryClient } from "./clients/PoolFactoryClient";
export { AdminClient } from "./clients/AdminClient";
export {
  buildSwapIx,
  buildSwapTx,
  buildAddLiquidityIx,
  buildAddLiquidityTx,
  buildRemoveLiquidityIx,
  buildRemoveLiquidityTx,
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
} from "./clients/tx-builders";
export { buildVersionedTx, compileBuiltTx } from "./clients/versioned";
export { resolveSwapExtraAccounts, resolveAddLiquidityExtraAccounts, resolveRemoveLiquidityExtraAccounts } from "./clients/extra-accounts";
export type { ResolveExtraAccountsParams } from "./clients/extra-accounts";
export { resolveTransferExtraAccounts, executeMetas, MEMO_PROGRAM_ID, UnsupportedTransferProfileError } from "./utils/transferProfile";
export type { AccountReader, TransferLeg, MintSnapshot, ResolveTransferExtraAccountsOptions } from "./utils/transferProfile";
export type { InitializePoolAltParams } from "./clients/tx-builders";
export { decodePoolAccount, POOL_DISCRIMINATOR_LEN, POOL_LEN, POOL_V4_LEN, V5_MIGRATION_MARKER } from "./parsers/poolAccount";
export { toSdkError, describeProgramError } from "./utils/errors";
export { decodeMintAccount } from "./parsers/mintAccount";
export { parseCubicPoolEvents } from "./parsers/events";
export { BorshReader } from "./parsers/borsh";

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
  PlannedZapQuoteOptions,
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
  NonceResponse,
  TxChallengeResponse,
  AuthTokens,
  SwapRouteEntry,
  SwapRouteResponse,
  CubicPoolClientParams,
  PoolFactoryClientParams,
  InitializeConfigParams,
} from "./clients";

export { buildContractInstruction } from "./clients/contract-instructions";
export { decodeContractAccount, decodeContractEvent, parseContractEvents } from "./parsers/contracts";
export type { ContractEvent } from "./parsers/contracts";
export type { ContractInstructionArgs, ContractInstructionAccounts } from "./clients/contract-instructions";
export type { ContractProgram, ContractInstructionMap, ContractAccountMap, ContractEventMap, ContractTypes } from "./types/contracts";
export { buildSetSwapFeeRateIx, buildSetMaxSelloffIx, buildInitiatePoolAdminTransferIx, buildAcceptPoolAdminTransferIx, buildCancelPoolAdminTransferIx, buildDisablePoolAdminIx, buildGetPoolInfoIx } from "./clients/tx-builders";
export type { SelloffParams, AddLiquidityQuote, RemoveLiquidityQuote } from "./types/tx";
export { simulateSwap } from "./math/swapSim";
export type { SwapLeg, SwapLegAfter, SwapSimParams, SwapSimResult } from "./math/swapSim";
export { calculateSwapFee, calculateProtocolFee } from "./math/slippage";
export { checkAndAdvanceSelloff, rebaseSnapshot, rescaleWindowOnVbChange } from "./math/maxSelloff";
export type { SelloffState, SelloffResult } from "./math/maxSelloff";
export type { SurgeCurve } from "./math/surgeFee";
export { calculateInvariant } from "./math/weightedMath";

export { MintExtension, MAX_KNOWN_MINT_EXTENSION, HARD_UNSUPPORTED_MINT_EXTENSIONS, HARD_BANNED_EXTENSIONS, DEFAULT_BANNED_EXTENSIONS, MINT_TLV_OFFSET, mintExtensionName, parseMintExtensions, unsupportedMintExtensions, bannedMintExtensions, tokenTransferBlockers, isTokenTransferable, describeUnsupportedToken, assertTokensSupported } from "./utils/extensions";
