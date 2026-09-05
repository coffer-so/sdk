// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Endgame AMM DEX Foundation.
// See LICENSE at the repository root.

/**
 * @cubee_ee/sdk — client library for the Cubic Pool AMM on Solana.
 *
 * Entry point barrel. Most consumers will want to import from this root:
 *
 * ```ts
 * import { CubicPoolClient, CubeBackendClient, getConfig } from "@cubee_ee/sdk";
 *
 * const cfg = getConfig("mainnet", { backendEndpoint: "https://api.cube.fi" });
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
export { CubeBackendClient } from "./clients/CubeBackendClient";
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

export type {
  CubeConfig,
  CubeConfigOverrides,
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
export type { CubeProgram } from "./utils/errors";
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
  CubeBackendClientParams,
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
  PortfolioChartMetric,
  PortfolioChartRange,
  PortfolioChartResponse,
  PairChartRange,
  TokenPairChartResponse,
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
  SingleTokenDepositClientParams,
  PoolFactoryClientParams,
  InitializeConfigParams,
} from "./clients";
