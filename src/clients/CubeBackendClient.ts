import { SdkResult, err, ok } from "../types/result";
import { PoolSummary } from "../types/pool";
import { safeCall } from "../utils/retry";

export interface CubeBackendClientParams {
  apiEndpoint: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Called when tokens are refreshed automatically after a 401.
   * The frontend should persist the new tokens (e.g. to localStorage).
   */
  onTokenRefreshed?: (tokens: AuthTokens) => void;
  /**
   * Called when both access and refresh tokens are expired/invalid.
   * The frontend should trigger a full re-authentication (SIWS sign-in).
   */
  onAuthExpired?: () => void;
}

export type StatsKind =
  | "tvl"
  | "volume"
  | "swap_count"
  | "avg_swap"
  | "median_swap"
  | "fees_lp"
  | "fees_protocol"
  | "users_total"
  | "dau"
  | "mau"
  | "deposits"
  | "removals";

export type StatsWindow = "1d" | "7d" | "30d" | "all";

export interface StatsSeriesPoint {
  t: number;
  v: number;
}
export interface StatsSeries {
  points: StatsSeriesPoint[];
}

export interface PriceMap {
  [mint: string]: number;
}

// ── Swap route types ──

export interface SwapRouteEntry {
  poolAddress: string;
  poolName: string;
  amountIn: string;
  expectedOut: string;
  /** Raw minimum output for this leg after slippage — sign this into the
   *  swap instruction. */
  minAmountOut: string;
  percentage: number;
  swapFee: number;
  tokenProgramIn: string;
  tokenProgramOut: string;
  tokenInIndex: number;
  tokenOutIndex: number;
  vaultIn: string | null;
  vaultOut: string | null;
}

export interface SwapRouteResponse {
  routes: SwapRouteEntry[];
  totalAmountIn: string;
  totalExpectedOut: string;
  /** Total raw minimum received after slippage (sum of per-leg
   *  minAmountOut). Always ≤ totalExpectedOut — display this as "Min
   *  received" instead of extrapolating from spot price. */
  minReceived: string;
  /** Slippage tolerance applied by the backend (basis points; 200 = 2%). */
  slippageBps: number;
  effectivePrice: number;
  priceImpact: number;
  spotPrice: number;
  /** Estimated XP earned from this swap (based on LP fees generated) */
  estimatedXp: number;
}

// ── Leaderboard types ──

export interface LeaderboardEntry {
  address: string;
  points: number;
  place: number;
}

export interface LeaderboardResponse {
  total: number;
  page: number;
  limit: number;
  data: LeaderboardEntry[];
}

export interface LeaderboardUserStats {
  place: number;
  address: string;
  points: number;
  lastAccrualSwapUsd: number;
  lastAccrualLiqUsd: number;
  lastAccrualAt: string | null;
}

export interface XpAccrualHistoryEntry {
  accrualTime: string;
  swapVolumeUsd: number;
  swapXp: number;
  lpValueUsd: number;
  lpXp: number;
  totalXp: number;
}

export interface XpAccrualHistoryResponse {
  total: number;
  page: number;
  limit: number;
  data: XpAccrualHistoryEntry[];
}

export interface EpochHistoryEntry {
  epoch: number;
  start: string;
  end: string;
  multiplier: number;
  swapXpPerUsdLpFee: number;
  lpXpPerUsd: number;
  isCurrent: boolean;
}

export interface LeaderboardEpochResponse {
  currentEpoch: number;
  currentEpochStart: string;
  nextEpochStart: string;
  msUntilNextEpoch: number;
  currentMultiplier: number;
  baseRates: {
    swapXpPerUsdLpFee: number;
    lpXpPerUsd: number;
  };
  currentRates: {
    swapXpPerUsdLpFee: number;
    lpXpPerUsd: number;
  };
  epochs: EpochHistoryEntry[];
}

export interface LeaderboardStatsResponse {
  /** Total number of users in the leaderboard */
  totalUsers: number;
  /** Sum of all XP points across all users */
  totalXp: number;
}

// ── Campaign types ──

export interface CampaignStatusResponse {
  /** Active campaign slug the backend is currently running. */
  campaign: string;
  participating: boolean;
  /** ISO time of the ORIGINAL join; null when not participating. */
  joinedAt: string | null;
}

export interface CampaignPrizeTier {
  /** Inclusive place range this prize applies to. */
  fromPlace: number;
  toPlace: number;
  usd: number;
}

export interface CampaignInfoResponse {
  campaign: string;
  startsAt: string;
  endsAt: string;
  /** Server-computed — drive the countdown from this, not client clocks. */
  msUntilEnd: number;
  ended: boolean;
  prizePoolUsd: number;
  /** Fixed for the whole campaign; paid out manually after the end. */
  prizes: CampaignPrizeTier[];
  rates: {
    /** Same swap-XP rate as the leaderboard; LP XP is NOT accrued here. */
    swapXpPerUsdLpFee: number;
  };
}

export interface CampaignRankResponse {
  campaign: string;
  from: string;
  /** Effective window end after server-side clamping to the campaign. */
  to: string;
  participating: boolean;
  /**
   * Place under the same ordering as the public top table; null when not
   * participating or no swap XP earned inside the window.
   */
  place: number | null;
  swapXp: number;
  swapVolumeUsd: number;
  /** Size of the ranked table — for "you are N of M" UI. */
  totalRanked: number;
}

export interface CampaignTopEntry {
  /** Continuous across pages. */
  place: number;
  address: string;
  /** XP earned from swaps inside the window (LP XP not counted). */
  swapXp: number;
  swapVolumeUsd: number;
  joinedAt: string;
}

export interface CampaignTopResponse {
  campaign: string;
  from: string;
  /** Effective window end after server-side clamping to the campaign. */
  to: string;
  /** Participants with swap XP > 0 in the window. */
  total: number;
  page: number;
  limit: number;
  data: CampaignTopEntry[];
}

// ── Platform stats ──

export interface PlatformStatsResponse {
  totalTvlUsd: number;
  totalVirtualTvl: number;
  totalVolume24h: number;
  poolCount: number;
  updatedAt: string | null;
}

// ── Pool admin types ──

export interface AdminPoolEntry {
  poolAddress: string;
  poolName: string;
  /** Off-chain: mint shown first in the token list (null = default order). */
  baseAssetMint: string | null;
  /** Off-chain: short pool description. */
  description: string | null;
  tvlUsd: number;
  apy: number;
  volume24h: number;
  swapFee: number;
  poolEnabled: boolean;
  swapsEnabled: boolean;
  tokens: Array<{
    mintAddress: string;
    ticker: string;
    imageUrl: string | null;
  }>;
}

/** Off-chain, admin-editable pool settings. */
export interface UpdatePoolSettingsBody {
  /** Mint of the base asset (one of the pool tokens); "" clears it. */
  baseAssetMint?: string;
  /** Short description; "" clears it. */
  description?: string;
}

export interface AdminPoolsResponse {
  pools: AdminPoolEntry[];
}

export interface IsAdminResponse {
  poolAddress: string;
  isAdmin: boolean;
}

export interface RenamePoolResponse {
  poolAddress: string;
  name: string;
  updated: true;
}

// ── Referral types ──

export interface ReferralBindResponse {
  referrer: string;
  bound: true;
}

export interface ReferralRates {
  l1Percent: number;
  l2Percent: number;
}

export interface ReferralStats {
  totalReferrals: number;
  l1Count: number;
  l2Count: number;
  totalBonusPoints: number;
  l1BonusPoints: number;
  l2BonusPoints: number;
}

export interface ReferralStatusResponse {
  referredBy: string | null;
  referralCode: string;
  customCodes: string[];
  rates: ReferralRates;
  stats: ReferralStats;
}

export interface ReferralEntry {
  /** Wallet address of the referral */
  address: string;
  /** Total bonus XP this referral has earned for you */
  earnedBonusXp: number;
  /** When this user became your referral */
  boundAt: string;
}

export interface ReferralListResponse {
  total: number;
  page: number;
  limit: number;
  data: ReferralEntry[];
}

// ── Portfolio types ──

export interface PortfolioValueChange {
  abs: number;
  pct: number;
}

export interface PortfolioSummaryResponse {
  value: {
    total: number;
    inPositions: number;
    inWallet: number;
    change: {
      d1: PortfolioValueChange;
      d7: PortfolioValueChange;
    };
  };
  totalPnl: {
    net: number;
    pct: number;
    components: {
      feesEarned: number;
      ilCurrent: number;
      ilRealized: number;
    };
  };
}

export interface PortfolioExposureToken {
  symbol: string;
  mint: string;
  logo: string | null;
  usd: number;
  amount: number;
  pct: number;
  inLp: number;
  inWallet: number;
  pools: string[];
}

export interface PortfolioExposureResponse {
  totalUsd: number;
  tokens: PortfolioExposureToken[];
}

export interface PortfolioHistoryPoint {
  t: number;
  feesCumulative: number;
  ilCumulative: number;
  netPnl: number;
}

export interface PortfolioHistoryResponse {
  range: string;
  series: PortfolioHistoryPoint[];
}

export interface PortfolioPoolEntry {
  poolAddress: string;
  poolName: string;
  tokens: Array<{ symbol: string; mint: string }>;
  value: number;
  feesEarned: number;
  /** LIVE unrealized IL only (≤ 0); realized part is `ilRealized` */
  il: number;
  /** Result locked in on past withdrawals vs HODL ("Realized PnL" in UI) */
  ilRealized: number;
  netPnl: number;
  apr: number;
}

export interface PortfolioPoolsResponse {
  pools: PortfolioPoolEntry[];
}

export interface PortfolioPoolHistoryPoint {
  t: number;
  feesCumulative: number;
  ilCumulative: number;
}

export interface PortfolioPoolHistoryResponse {
  poolAddress: string;
  range: string;
  series: PortfolioPoolHistoryPoint[];
}

// ── Auth types ──

export interface NonceResponse {
  nonce: string;
  message: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  wallet: string;
  expiresIn: string;
}

/**
 * REST wrapper around the Cube backend. Every method is a SdkResult; no
 * exceptions escape. If a request fails, the result carries a
 * human-readable error plus the original cause.
 *
 * Auto-refresh: when a request gets 401, the client automatically tries
 * to refresh tokens via POST /api/auth/refresh. If successful, the
 * original request is retried once with the new access token.
 */
export class CubeBackendClient {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private refreshToken: string | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private readonly onTokenRefreshed?: (tokens: AuthTokens) => void;
  private readonly onAuthExpired?: () => void;

  constructor(params: CubeBackendClientParams) {
    this.endpoint = params.apiEndpoint.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
      ...(params.defaultHeaders ?? {}),
    };
    this.onTokenRefreshed = params.onTokenRefreshed;
    this.onAuthExpired = params.onAuthExpired;
  }

  listPools(): Promise<SdkResult<PoolSummary[]>> {
    return this.get<PoolSummary[]>("/api/pools");
  }

  getPool(addr: string): Promise<SdkResult<PoolSummary>> {
    return this.get<PoolSummary>(`/api/pools/${addr}`);
  }

  /**
   * Raw pool-list response in the same envelope the backend returns
   * (`{ data, hasMore, totalCount }`). Kept so the frontend's React
   * Query hooks can map directly.
   */
  listPoolsRaw(
    limit: number,
    offset: number
  ): Promise<SdkResult<{ data: unknown[]; hasMore: boolean; totalCount: number }>> {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return this.getEnvelope(`/api/pools?${qs.toString()}`);
  }

  getPoolRaw(addr: string): Promise<SdkResult<unknown>> {
    return this.getDataField<unknown>(`/api/pools/${addr}`);
  }

  createPool<T>(body: unknown): Promise<SdkResult<T>> {
    return this.postDataField<T>("/api/pools", body);
  }

  getPoolsByTokenPair<T>(tokenA: string, tokenB: string): Promise<SdkResult<T>> {
    const qs = new URLSearchParams({ tokenA, tokenB });
    return this.getDataField<T>(`/api/pools/by-pair?${qs.toString()}`);
  }

  getPlatformStats(): Promise<SdkResult<PlatformStatsResponse>> {
    return this.getDataField<PlatformStatsResponse>("/api/pools/stats");
  }

  getPortfolio<T>(wallet: string): Promise<SdkResult<T>> {
    return this.getDataField<T>(`/api/pools/portfolio?wallet=${encodeURIComponent(wallet)}`);
  }

  getAllTokens<T>(): Promise<SdkResult<T>> {
    return this.getDataField<T>("/api/pools/tokens");
  }

  getTopTokens<T>(limit: number = 20): Promise<SdkResult<T>> {
    return this.getDataField<T>(`/api/pools/top-tokens?limit=${limit}`);
  }

  getPoolTxStats<T>(addr: string): Promise<SdkResult<T>> {
    return this.getDataField<T>(`/api/pools/${addr}/tx-stats`);
  }

  getTransactions<T>(
    addr: string,
    options?: {
      limit?: number;
      offset?: number;
      type?: "swap" | "add_liquidity" | "remove_liquidity";
      user?: string;
    },
  ): Promise<SdkResult<T>> {
    const qs = new URLSearchParams({
      limit: String(options?.limit ?? 20),
      offset: String(options?.offset ?? 0),
    });
    if (options?.type) qs.set("type", options.type);
    if (options?.user) qs.set("user", options.user);
    return this.getDataField<T>(`/api/pools/${addr}/transactions?${qs.toString()}`);
  }

  getSwapRoute(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    decimalsIn: number = 9,
    slippageBps?: number,
    /**
     * Restrict the quote to this single pool: no split routing, all
     * estimates (priceImpact against this pool's own spot, fees, XP) are
     * computed as if swapping only through it.
     */
    pool?: string,
  ): Promise<SdkResult<SwapRouteResponse>> {
    const qs = new URLSearchParams({
      tokenIn,
      tokenOut,
      amountIn,
      decimalsIn: String(decimalsIn),
    });
    if (slippageBps !== undefined) {
      qs.set('slippageBps', String(slippageBps));
    }
    if (pool !== undefined) {
      qs.set('pool', pool);
    }
    return this.getDataField<SwapRouteResponse>(
      `/api/pools/swap-route?${qs.toString()}`,
    );
  }

  // ── Leaderboard ──

  getLeaderboard(
    page: number = 1,
    limit: number = 20,
  ): Promise<SdkResult<LeaderboardResponse>> {
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    return this.get<LeaderboardResponse>(`/api/leaderboard?${qs.toString()}`);
  }

  getLeaderboardUser(
    address: string,
  ): Promise<SdkResult<LeaderboardUserStats>> {
    return this.getDataField<LeaderboardUserStats>(
      `/api/leaderboard/user/${encodeURIComponent(address)}`,
    );
  }

  getLeaderboardUserHistory(
    address: string,
    page: number = 1,
    limit: number = 50,
  ): Promise<SdkResult<XpAccrualHistoryResponse>> {
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    return this.get<XpAccrualHistoryResponse>(
      `/api/leaderboard/user/${encodeURIComponent(address)}/history?${qs.toString()}`,
    );
  }

  getLeaderboardEpoch(): Promise<SdkResult<LeaderboardEpochResponse>> {
    return this.get<LeaderboardEpochResponse>("/api/leaderboard/epoch");
  }

  /** Get overall leaderboard stats: total users and total XP. */
  getLeaderboardStats(): Promise<SdkResult<LeaderboardStatsResponse>> {
    return this.get<LeaderboardStatsResponse>("/api/leaderboard/stats");
  }

  /**
   * Join the active swap-XP campaign. Requires SIWS auth (`setTokens`);
   * the wallet comes from the JWT. IDEMPOTENT — repeat calls are no-ops
   * returning the same status with the original join time.
   */
  joinCampaign(): Promise<SdkResult<CampaignStatusResponse>> {
    return this.post<CampaignStatusResponse>("/api/campaign/join", {});
  }

  /** Participation status of the authenticated wallet (requires SIWS auth). */
  getCampaignStatus(): Promise<SdkResult<CampaignStatusResponse>> {
    return this.get<CampaignStatusResponse>("/api/campaign/me");
  }

  /** Active campaign card: window, server-side countdown, prizes. Public. */
  getCampaignInfo(): Promise<SdkResult<CampaignInfoResponse>> {
    return this.get<CampaignInfoResponse>("/api/campaign/info");
  }

  /**
   * The authenticated wallet's own place in the campaign standings
   * (requires SIWS auth). Same window semantics and ordering as
   * getCampaignTop, so the place always matches the public table.
   */
  getCampaignRank(
    from?: string,
    to?: string,
  ): Promise<SdkResult<CampaignRankResponse>> {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return this.get<CampaignRankResponse>(
      `/api/campaign/me/rank?${qs.toString()}`,
    );
  }

  /**
   * Campaign standings: participants only, ranked by swap XP inside
   * [from, to). Both dates are optional and CLAMPED into the campaign
   * window server-side (defaults: the whole campaign) — omit both for
   * the live standings of the running campaign; they freeze by
   * themselves once it ends. Public endpoint, paginated like the
   * leaderboard.
   */
  getCampaignTop(
    from?: string,
    to?: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<SdkResult<CampaignTopResponse>> {
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return this.get<CampaignTopResponse>(`/api/campaign/top?${qs.toString()}`);
  }

  getTokenPrices(mints: string[]): Promise<SdkResult<PriceMap>> {
    const qs = new URLSearchParams({ mints: mints.join(",") });
    return this.get<PriceMap>(`/api/prices?${qs.toString()}`);
  }

  getStats(
    kind: StatsKind,
    window: StatsWindow = "7d",
    poolAddr?: string,
    unit: "usd" | "token" = "usd"
  ): Promise<SdkResult<StatsSeries>> {
    const qs = new URLSearchParams({ window, unit });
    if (poolAddr) qs.set("pool", poolAddr);
    return this.get<StatsSeries>(`/api/stats/${kind}?${qs.toString()}`);
  }

  // ── Pool admin (auth required) ──

  /**
   * Get pools where the authenticated user is the on-chain admin.
   * Requires authentication.
   */
  getAdminPools(): Promise<SdkResult<AdminPoolsResponse>> {
    return this.get<AdminPoolsResponse>("/api/pools/admin/my-pools");
  }

  /**
   * Check if the authenticated user is the on-chain admin of a specific pool.
   * Requires authentication.
   */
  isPoolAdmin(poolAddress: string): Promise<SdkResult<IsAdminResponse>> {
    return this.get<IsAdminResponse>(
      `/api/pools/admin/is-admin/${encodeURIComponent(poolAddress)}`,
    );
  }

  /**
   * Rename a pool. Only the on-chain pool admin can do this.
   * Requires authentication.
   */
  renamePool(poolAddress: string, name: string): Promise<SdkResult<RenamePoolResponse>> {
    return this.put<RenamePoolResponse>(
      `/api/pools/admin/${encodeURIComponent(poolAddress)}/name`,
      { name },
    );
  }

  /**
   * Update off-chain pool settings (base asset, description). Only fields
   * present are changed; empty string clears a field. Base asset must be
   * one of the pool tokens. Pool admin only; requires authentication.
   */
  updatePoolSettings<T>(
    poolAddress: string,
    settings: UpdatePoolSettingsBody,
  ): Promise<SdkResult<T>> {
    return this.put<T>(
      `/api/pools/admin/${encodeURIComponent(poolAddress)}/settings`,
      settings,
    );
  }

  // ── Referral ──

  /**
   * Bind the authenticated user as a referral of the given referrer.
   * The code can be a wallet address or a custom referral code.
   * Optionally pass UTM parameters from the referral link for analytics.
   * Requires authentication (setTokens must be called first).
   */
  bindReferral(
    code: string,
    utm?: {
      source?: string;
      medium?: string;
      campaign?: string;
      content?: string;
      term?: string;
    },
  ): Promise<SdkResult<ReferralBindResponse>> {
    const body: Record<string, unknown> = { code };
    if (utm) body.utm = utm;
    return this.post<ReferralBindResponse>("/api/referral/bind", body);
  }

  /**
   * Get the authenticated user's referral status: referrer, referral code,
   * custom codes, bonus rates (L1/L2 %), and aggregated stats.
   * Requires authentication.
   */
  getReferralStatus(): Promise<SdkResult<ReferralStatusResponse>> {
    return this.get<ReferralStatusResponse>("/api/referral/my");
  }

  /**
   * Get a paginated list of the authenticated user's direct referrals (L1).
   * Requires authentication.
   */
  getMyReferrals(
    page: number = 1,
    limit: number = 20,
  ): Promise<SdkResult<ReferralListResponse>> {
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    return this.get<ReferralListResponse>(
      `/api/referral/my/referrals?${qs.toString()}`,
    );
  }

  // ── Portfolio (auth required) ──

  /**
   * Portfolio summary: value (LP + wallet) + total PnL (fees, IL current, IL realized).
   * Returns 404 if user has no LP positions.
   */
  getPortfolioSummary(): Promise<SdkResult<PortfolioSummaryResponse>> {
    return this.get<PortfolioSummaryResponse>("/api/portfolio/summary");
  }

  /**
   * Token exposure: per-token breakdown of LP positions + wallet balances.
   */
  getPortfolioExposure(): Promise<SdkResult<PortfolioExposureResponse>> {
    return this.get<PortfolioExposureResponse>("/api/portfolio/exposure");
  }

  /**
   * Portfolio history for charts (fees cumulative + IL cumulative).
   * Daily data points for the selected range.
   */
  getPortfolioHistory(
    range: "7d" | "30d" | "90d" | "all" = "30d",
  ): Promise<SdkResult<PortfolioHistoryResponse>> {
    return this.get<PortfolioHistoryResponse>(
      `/api/portfolio/history?range=${range}`,
    );
  }

  /**
   * Per-pool portfolio metrics (value, fees, unrealized IL, realized
   * IL/PnL, net PnL, APR).
   */
  getPortfolioPools(): Promise<SdkResult<PortfolioPoolsResponse>> {
    return this.get<PortfolioPoolsResponse>("/api/portfolio/pools");
  }

  /**
   * Per-pool history (lazy-loaded on row expand).
   * Fees cumulative + IL cumulative series for a single pool.
   */
  getPortfolioPoolHistory(
    poolAddress: string,
    range: "7d" | "30d" | "90d" | "all" = "30d",
  ): Promise<SdkResult<PortfolioPoolHistoryResponse>> {
    return this.get<PortfolioPoolHistoryResponse>(
      `/api/portfolio/pools/${encodeURIComponent(poolAddress)}/history?range=${range}`,
    );
  }

  // ── Auth ──

  /** Request a SIWS nonce + pre-built message for the given wallet. */
  getNonce(wallet: string): Promise<SdkResult<NonceResponse>> {
    return this.get<NonceResponse>(
      `/api/auth/nonce?wallet=${encodeURIComponent(wallet)}`,
    );
  }

  /** Submit signed SIWS message to receive access + refresh tokens. */
  verifySignature(
    message: string,
    signature: string,
  ): Promise<SdkResult<AuthTokens>> {
    return this.post<AuthTokens>("/api/auth/verify", {
      message,
      signature,
    });
  }

  /**
   * Set both tokens. Call this after verifySignature() and on app init
   * (restoring tokens from storage).
   */
  setTokens(accessToken: string, refreshToken: string): void {
    this.headers["Authorization"] = `Bearer ${accessToken}`;
    this.refreshToken = refreshToken;
  }

  /** Clear both tokens (logout). */
  clearTokens(): void {
    delete this.headers["Authorization"];
    this.refreshToken = null;
  }

  /** @deprecated Use setTokens() instead. */
  setAccessToken(token: string): void {
    this.headers["Authorization"] = `Bearer ${token}`;
  }

  /** @deprecated Use clearTokens() instead. */
  clearAccessToken(): void {
    delete this.headers["Authorization"];
    this.refreshToken = null;
  }

  /** Generic GET with retry. Callers that need it for other endpoints. */
  get<T>(path: string): Promise<SdkResult<T>> {
    return this.requestWithRefresh<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<SdkResult<T>> {
    return this.requestWithRefresh<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown): Promise<SdkResult<T>> {
    return this.requestWithRefresh<T>("PUT", path, body);
  }

  // ── Private: HTTP layer with auto-refresh ──

  /**
   * Core request method with auto-refresh on 401.
   * If a request gets 401 and we have a refresh token:
   *   1. Call POST /api/auth/refresh (deduplicated if concurrent)
   *   2. On success: update tokens, notify via callback, retry original request
   *   3. On failure: notify via onAuthExpired callback, return original error
   */
  private async requestWithRefresh<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<SdkResult<T>> {
    const result = await this.rawRequest<T>(method, path, body);

    // Don't auto-refresh for auth endpoints themselves
    const isAuthPath = path.startsWith("/api/auth/");
    if (!isAuthPath && !result.ok && this.is401(result) && this.refreshToken) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        return this.rawRequest<T>(method, path, body);
      }
    }

    return result;
  }

  private async rawRequest<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown
  ): Promise<SdkResult<T>> {
    const url = `${this.endpoint}${path}`;
    const fetchOpts: RequestInit = {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const raw = await safeCall(async () => {
      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        const error = new Error(
          `${method} ${path} → HTTP ${res.status} ${res.statusText}`,
        );
        (error as any).status = res.status;
        throw error;
      }
      return (await res.json()) as T;
    });
    if (!raw.ok) return raw;
    return ok(raw.data);
  }

  /**
   * Attempt to refresh tokens. Returns true if successful.
   * Deduplicates concurrent refresh attempts.
   */
  private async tryRefresh(): Promise<boolean> {
    // Deduplicate: if a refresh is already in flight, wait for it
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.doRefresh();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async doRefresh(): Promise<boolean> {
    const res = await this.rawRequest<AuthTokens>("POST", "/api/auth/refresh", {
      refreshToken: this.refreshToken,
    });

    if (res.ok) {
      this.setTokens(res.data.accessToken, res.data.refreshToken);
      this.onTokenRefreshed?.(res.data);
      return true;
    }

    // Refresh failed — both tokens are dead
    this.clearTokens();
    this.onAuthExpired?.();
    return false;
  }

  private is401(result: SdkResult<unknown>): boolean {
    if (result.ok) return false;
    return result.error.humanMessage.includes("HTTP 401");
  }

  /**
   * Fetch a response envelope of the form `{ data: T, ... }` and unwrap
   * the `.data` field. The existing Cube backend wraps most endpoints
   * this way.
   */
  private async getDataField<T>(path: string): Promise<SdkResult<T>> {
    const res = await this.get<{ data: T }>(path);
    if (!res.ok) return res;
    return ok(res.data?.data);
  }

  private async postDataField<T>(path: string, body: unknown): Promise<SdkResult<T>> {
    const res = await this.post<{ data: T }>(path, body);
    if (!res.ok) return res;
    return ok(res.data?.data);
  }

  /** Fetch the full envelope (for endpoints that return meta alongside data). */
  private async getEnvelope<T>(path: string): Promise<SdkResult<T>> {
    return this.get<T>(path);
  }
}
