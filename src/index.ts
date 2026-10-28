// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Endgame AMM DEX Foundation.
// See LICENSE at the repository root.

/**
 * @coffer_so/sdk — client library for the Coffer Pool AMM on Solana.
 *
 * Entry point barrel. Most consumers will want to import from this root:
 *
 * ```ts
 * import { CofferPoolClient, CofferBackendClient, getConfig } from "@coffer_so/sdk";
 *
 * const cfg = getConfig("mainnet", { backendEndpoint: "https://api.coffer.so" });
 * const pool = new CofferPoolClient({ config: cfg, poolAddress });
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
  POOL_SEED,
  LP_MINT_SEED,
  STLD_HELPER_SEED,
  TREASURY_SEED,
  WEIGHT_SCALE,
  MIN_WEIGHT,
  MAX_WEIGHT,
  MIN_TOKENS,
  MAX_TOKENS,
  LP_DECIMALS,
  SWAP_FEE_PRECISION,
  PROTOCOL_FEE_PRECISION,
  PERCENT_SCALE,
  MAX_SWAP_FEE_RATE,
  MAX_PROTOCOL_FEE_RATE,
  MIN_LP_SUPPLY,
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
  calcLpOutGivenExactTokensIn,
  calcJoinRatioAndLp,
  calcTokensOutGivenLpIn,
  calcSpotOut,
  calcDepositCredit,
  virtualBalanceAfterDeposit,
  virtualBalanceAfterWithdrawal,
  calcEffectiveLpBurn,
} from "./math/poolMath";
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
export { CofferPoolClient } from "./clients/CofferPoolClient";
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
  buildInitializePoolIx,
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
export { parseCofferPoolEvents } from "./parsers/events";
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
  CofferPoolEvent,
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
  CofferPoolClientParams,
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

export { MintExtension, MAX_KNOWN_MINT_EXTENSION, HARD_UNSUPPORTED_MINT_EXTENSIONS, MINT_TLV_OFFSET, mintExtensionName, parseMintExtensions, unsupportedMintExtensions, tokenTransferBlockers, isTokenTransferable, describeUnsupportedToken, assertTokensSupported } from "./utils/extensions";

// ─── v6.1 (SDK 0.2.0): layout, builders, quotes, events ─────────────────────
export { POOL_LEN_V5, POOL_LEN_V61, POOL_LEN_V3, POOL_DECODABLE_LENS, POOL_LAYOUT_VERSION_V61, POOL_LAYOUT, TOKEN_SLOT_LAYOUT, TREASURY_LAYOUT, POOL_ACTION_KINDS, POOL_ACTION_KIND, PROTOCOL_ACTION_KINDS, PROTOCOL_ACTION_KIND, GRACE_PERIOD_SECS, pendingStatus } from "./parsers/layout";
export type { PoolActionKindName, ProtocolActionKindName, PendingStatus } from "./parsers/layout";
export { isDecodablePoolLen, poolNeedsLayoutMigration, decodePoolCooldownBlock } from "./parsers/poolAccount";
export { decodeTreasuryAccount, decodeTreasuryCooldownBlock, treasuryNeedsLayoutMigration, TREASURY_DISCRIMINATOR } from "./parsers/treasuryAccount";
export type { RawTreasuryAccount } from "./parsers/treasuryAccount";
export { parseTokenMetadataExtension, lpMetadataOf } from "./parsers/mintAccount";
export {
  MAINNET_V51_FACTORY_PROGRAMS,
} from "./config/networks";
export {
  MIN_INITIAL_LP_SUPPLY, MAX_INITIAL_LP_SUPPLY, DEFAULT_INITIAL_LP_SUPPLY, MAX_CREATOR_FEE_BPS, MAX_LIQUIDITY_FEE_BPS,
  LP_NAME_MAX_LEN, LP_SYMBOL_MAX_LEN, LP_URI_MAX_LEN, LP_METADATA_POOL_KEY, HOOK_FLAGS, HOOK_MIN_CU, HOOK_MAX_CU_CAP, HOOK_DEFAULT_MAX_CU,
  HOOK_MIN_ACCOUNTS, HOOK_MAX_ACCOUNTS, TREASURY_VAULT_SEED,
} from "./config";
export { splitFee, nonLpShare, feeSplitTotal } from "./math/feeSplit";
export type { FeeSplit } from "./math/feeSplit";
export { applyLiquidityFee, applyDepositFee, applyWithdrawFee, lpBurnNetOfWithdrawFee } from "./math/liquidityFee";
export { nav, navBalances, splitDepositCredit, splitExitPayout } from "./math/surgeBucket";
export { poolNavBalances, lpPositionValue, lpPriceUsd } from "./math/lpPrice";
export { simulatePoolSwap, swapLegOf, tokenSurgeBucket, hasDynamicFeeHook, hookPaused, pendingActionsStatusOf } from "./clients/quote-math";
export { clampHookFeeOverride, effectiveSwapFeeRate } from "./math/swapSim";
export {
  buildSeedLiquidityRawIx, buildSeedLiquidityIx, buildSeedLiquidityTx, buildFundSidelinedTokenIx, buildFundSidelinedTokenTx,
  buildMigratePoolLayoutV61Ix, prependLayoutMigration, buildRemoveLiquidityBypassHooksIx, buildSetSwapsEnabledIx,
  buildSetCreatorFeeBpsIx, buildSetLiquidityFeesIx, buildLockLiquidityFeesIx, buildLockRangeManagerIx, buildSetPoolAdminDelayIx,
} from "./clients/tx-builders";
export {
  PoolActions, ProtocolActions, poolActionKindOf, poolActionKindName, protocolActionKindOf, protocolActionKindName,
  POOL_EXECUTE_INSTRUCTION, PROTOCOL_EXECUTE_INSTRUCTIONS, buildProposePoolActionIx, buildCancelPoolActionIx, buildExecutePoolActionIx,
  proposeActionRemainingAccounts, selloffParamsArg,
} from "./clients/cooldown";
export type { PoolAction, ProtocolAction } from "./clients/cooldown";
export {
  treasuryVaultPda, buildClaimAccounts, buildCreatorClaimAccounts, buildCollectProtocolFeesIx, buildClaimCreatorFeesIx, buildRegisterTokenIx,
  buildTreasuryWithdrawIx, legacyTxSize, v0TxSize, uniqueKeys, chooseTxForm, claimComputeBudgetIx, MAX_TX_BYTES, CLAIM_CU_LIMIT, CLAIM_ACCOUNTS_PER_TOKEN, CLAIM_ERROR_NAMES,
} from "./clients/feeClaim";
export type { CollectProtocolFeesParams, TxForm, TxFormOptions } from "./clients/feeClaim";
export { validatePoolIdentity, verifyCreatedPool, randomPoolIdU64, POOL_ACCOUNT_DISCRIMINATOR } from "./clients/poolIdentity";
export type { PoolAccountReader } from "./clients/poolIdentity";
export {
  buildAtomicDeploy, sendAtomicDeploy, sendSignedDeploy, waitForNextSlot, computeUnitsOf, bundleTransactions, assertDontFrontReadOnly, deployHookAccounts,
  v0WireSize, v0AccountCount, randomPoolId, SOLANA_TX_LIMIT, TRACE_BUDGET, ATA_CREATE_TRACE, INIT_POOL_TRACE, seedTrace, JITO_DONT_FRONT, POOL_CONFIG_LEN, POOL_CONFIG_DISCRIMINATOR,
} from "./clients/atomicDeploy";
export type { DeployBuildConnection, DeploySendConnection } from "./clients/atomicDeploy";
export {
  HOOK_CONFIG_LEN, hookCallerPda, HOOK_CALLER_LOCALNET, validateHookConfig, encodeHookConfig, encodeOptionHookConfig, hookConfigArg, hookAccountSlice, hookAccountSliceFor,
  requireHookSlice, HOOK_FIXTURE_PROGRAM_ID, hookFixtureCfgAddress, hookFixtureKycAddress, fixtureHookExtras, resolveHookSlice, hookOpFlags, hookCallbackCount,
  HOOK_BASE_CU, HOOK_CALLBACK_OVERHEAD_CU, hookCuBudget, readonlyMeta, writableMeta,
} from "./utils/hooks";
export {
  LP_URI_SCHEMES, LP_TOKEN_PROGRAM_ID, LP_METADATA_ERRORS, byteLength, isValidLpName, isValidLpSymbol, isValidLpUri, firstInvalidLpMetadataField, validateLpMetadata,
  encodeLpMetadataArgs, lpMetadataArgsSize, LP_METADATA_ARGS_MAX_SIZE, lpMintAccountSize, LP_MINT_BASE_SIZE, rentExemptLamports, defaultLpMetadata,
  LP_METADATA_GOOD, LP_METADATA_MAX, LP_METADATA_FIXTURES, fetchLpMetadata, decodeLpMintAccount,
} from "./utils/lpMetadata";
export type { MintAccountReader, FetchedLpMetadata } from "./utils/lpMetadata";
export { PoolLayoutOutdatedError } from "./types/tx-v61";
export type {
  LpMetadataArgs, LpMetadataField, HookConfigArgs, HookOp, HookExtrasResolver, HookExtrasContext, HookedParams, DeployPoolParamsV61, MigratePoolLayoutParams,
  TxBuildOptionsV61, SeedLiquidityParams, SeedLiquidityRawParams, FundSidelinedTokenParams, ActionKind, ClaimAbi, ClaimSlot, ClaimAccounts, DeployLayout,
  ExpectedPoolIdentity, VerifiedPoolIdentity, AtomicDeployParams, AtomicDeployResult, SendDeployResult,
} from "./types/tx-v61";
export type { PendingPoolAction, PoolHookInfo, LpMetadata } from "./types/pool";
export type { SwapQuoteOptions, LpPriceQuote } from "./types/tx";
export type { PendingActionsStatus, PendingActionStatus } from "./clients/quote-math";
export type { PoolInfoEvent } from "./types/events";
