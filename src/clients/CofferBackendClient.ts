import { SdkError, SdkResult, err, ok } from "../types/result";
import { PoolSummary } from "../types/pool";
import { RetryOptions, safeCall } from "../utils/retry";
import { isFetchNetworkFailure, toSdkError } from "../utils/errors";

export interface CofferBackendClientParams {
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
  /** Raw expected output for this leg — NET of the v5 sell-off surge fee
   *  (what the user actually receives). */
  expectedOut: string;
  /** Raw minimum output for this leg after slippage — sign this into the
   *  swap instruction. */
  minAmountOut: string;
  percentage: number;
  swapFee: number;
  /** Estimated v5 sell-off surge fee for this leg (raw units of tokenOut).
   *  "0" in the common case — rises as the input token's max-selloff
   *  window fills. */
  surgeFeeAmount: string;
  /** Surge fee rate applied to this leg (%). 0 when the window is calm. */
  surgeFeePct: number;
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
  /** Weighted average fee across routes (%), INCLUDING the v5 surge fee
   *  when one is active. */
  feePercent: number;
  /** Total estimated v5 surge fee across legs (raw units of tokenOut).
   *  "0" in the common case. */
  totalSurgeFee: string;
  /** Estimated XP earned from this swap (based on LP fees generated) */
  estimatedXp: number;
  /** True when a personalized XP boost (e.g. referred user +3%) was
   *  applied to `estimatedXp` — requires the request to carry a JWT. */
  xpBoostApplied: boolean;
}

// ── Leaderboard types ──

export interface LeaderboardEntry {
  address: string;
  points: number;
  place: number;
  /**
   * Public profile card of this wallet, read live on every request; null
   * when it has set none of username, display name, avatar and X link
   * (backend with public profiles, November 2026; absent on older backends).
   */
  profile?: UserProfileCard | null;
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
  /**
   * Public profile card of this wallet, read live on every request; null
   * when it has set none of username, display name, avatar and X link
   * (backend with public profiles, November 2026; absent on older backends).
   */
  profile?: UserProfileCard | null;
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
  /** A frozen snapshot of the board at this epoch's end exists (see getLeaderboardEpochSnapshot). */
  finalized: boolean;
  finalizedAt: string | null;
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
    /** XP per $1 of liquidity per 3-hour accrual tick. */
    lpXpPerUsd: number;
    /**
     * XP per $1 of liquidity per DAY (lpXpPerUsd × 8 ticks) — the "+N XP"
     * badge next to APY. Every pool object returned by /api/pools also
     * carries it as `lpXpPerUsdPerDay`, so a pools table needs no second call.
     */
    lpXpPerUsdPerDay: number;
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

/** A pool a campaign is restricted to, with its display name (for links). */
export interface CampaignPoolRef {
  address: string;
  name: string;
}

/**
 * Flat prize split EQUALLY among every wallet that meets the threshold(s):
 * swap volume in the window (`minVolumeUsd`) and/or swaps on at least
 * `minActiveDays` distinct campaign days (24-hour slots from `startsAt`).
 * Both present = both required; at least one is set.
 */
export interface CampaignBonus {
  usd: number;
  minVolumeUsd?: number | null;
  minActiveDays?: number | null;
}

/**
 * Campaign rules beyond the prize tiers (backend ≥ 2026-10-27; absent on
 * older backends — treat as a plain campaign). Shared by the live info,
 * the history list and the frozen snapshot header.
 */
export interface CampaignRules {
  /** Display name; derive one from the slug when null. */
  title?: string | null;
  /** Only swaps in these pools count. Null = every pool. */
  pools?: CampaignPoolRef[] | null;
  /**
   * No opt-in: every wallet that swapped in the campaign's pools is a
   * participant (`joinCampaign` is a no-op, `getCampaignStatus` always
   * answers `participating: true`, `joinedAt` = its first qualifying swap).
   */
  openEntry?: boolean;
  /** Paid on top of the place prizes; already included in snapshot `prizeUsd`. */
  bonus?: CampaignBonus | null;
}

export interface CampaignInfoResponse extends CampaignRules {
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
  /** Distinct 24-hour campaign days with a qualifying swap (backend ≥ 2026-10-28; absent before). */
  activeDays?: number;
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
  /**
   * Public profile card of this wallet, read live on every request; null
   * when it has set none of username, display name, avatar and X link
   * (backend with public profiles, November 2026; absent on older backends).
   */
  profile?: UserProfileCard | null;
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

// ── Frozen snapshot types (finished epochs and campaigns) ──

/** How an epoch snapshot was produced; `rewind` rows carry a small reconstruction risk, `capture` rows none. */
export type EpochSnapshotMethod = "capture" | "rewind";

export interface EpochSnapshotEntry {
  /** Positional place in the frozen board (same ordering as the live list). */
  place: number;
  address: string;
  /** Cumulative XP at the epoch's end — all epochs so far, referral bonuses included. */
  points: number;
  /** XP earned inside this epoch alone (points minus the previous epoch's frozen points). */
  epochPoints: number;
  /**
   * Public profile card of this wallet. NOT frozen with the row: it is read
   * live on every request; null when the wallet has set none of username,
   * display name, avatar and X link (backend with public profiles,
   * November 2026; absent on older backends).
   */
  profile?: UserProfileCard | null;
}

/**
 * The leaderboard exactly as it stood the instant an epoch ended. Frozen
 * once, never recomputed — the live board keeps moving, this does not.
 */
export interface EpochSnapshotResponse {
  epoch: number;
  start: string;
  /** Exclusive: the instant the next epoch began. */
  end: string;
  finalizedAt: string;
  method: EpochSnapshotMethod;
  multiplier: number;
  /** Everyone on the board at the time, zero-XP users included (as live). */
  totalUsers: number;
  totalXp: number;
  /** Same as totalUsers — pagination total. */
  total: number;
  page: number;
  limit: number;
  data: EpochSnapshotEntry[];
}

export interface EpochSnapshotUser {
  epoch: number;
  place: number;
  address: string;
  points: number;
  epochPoints: number;
  /** Board size, for "N of M". */
  totalUsers: number;
  /**
   * Public profile card of this wallet. NOT frozen with the row: it is read
   * live on every request; null when the wallet has set none of username,
   * display name, avatar and X link (backend with public profiles,
   * November 2026; absent on older backends).
   */
  profile?: UserProfileCard | null;
}

export interface CampaignHistoryEntry extends CampaignRules {
  campaign: string;
  startsAt: string;
  endsAt: string;
  prizePoolUsd: number;
  prizes: CampaignPrizeTier[];
  /** The window has closed. */
  ended: boolean;
  /**
   * Frozen results exist. They appear a grace period (24h) after `endsAt`;
   * until then keep using the live campaign endpoints for this campaign.
   */
  finalized: boolean;
  finalizedAt: string | null;
  /** Null until finalized. */
  totalParticipants: number | null;
  totalRanked: number | null;
}

export interface CampaignSnapshotTopEntry {
  /** Continuous across pages. */
  place: number;
  address: string;
  swapXp: number;
  swapVolumeUsd: number;
  /** Prize for this place under the campaign's tiers — already resolved, no client-side join. */
  prizeUsd: number;
  joinedAt: string;
  /**
   * Public profile card of this wallet. NOT frozen with the row: it is read
   * live on every request; null when the wallet has set none of username,
   * display name, avatar and X link (backend with public profiles,
   * November 2026; absent on older backends).
   */
  profile?: UserProfileCard | null;
}

export interface CampaignSnapshotTopResponse extends CampaignRules {
  campaign: string;
  startsAt: string;
  /** Inclusive. */
  endsAt: string;
  finalizedAt: string;
  prizePoolUsd: number;
  prizes: CampaignPrizeTier[];
  rates: { swapXpPerUsdLpFee: number };
  /** Everyone who joined, ranked or not. */
  totalParticipants: number;
  /** Ranked participants (swap XP > 0) — pagination total. */
  total: number;
  page: number;
  limit: number;
  data: CampaignSnapshotTopEntry[];
}

export interface CampaignSnapshotUserResponse {
  campaign: string;
  participating: boolean;
  /** Null when the wallet did not join or earned no swap XP. */
  place: number | null;
  swapXp: number;
  swapVolumeUsd: number;
  prizeUsd: number;
  joinedAt: string | null;
  /** Table size for "N of M". */
  totalRanked: number;
}

// ── Platform stats ──

export interface PlatformStatsResponse {
  totalTvlUsd: number;
  totalVirtualTvl: number;
  totalVolume24h: number;
  /**
   * All-time swap volume (USD, input side), summed over every indexed
   * swap. The canonical "Total Volume" headline — the landing and the
   * dashboard both read this field, so they always agree.
   */
  totalVolumeAllTime: number;
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
  /**
   * Off-chain: public URL of the pool image the admin uploaded (see
   * `uploadPoolImage`); null = none — compose the picture from the token
   * icons. Opaque: never build or parse it (backend with pool images,
   * November 2026; absent on older backends).
   */
  imageUrl?: string | null;
  /**
   * Off-chain: one https link of the admin's choice (X account, site, …).
   * User-supplied and not moderated — render it as an external link, never
   * as official (same backend as `imageUrl`; absent on older backends).
   */
  additionalUrl?: string | null;
  tvlUsd: number;
  apy: number;
  /**
   * Boosts of the pool (see `PoolBoostSnapshot`); null without one. Backend
   * with boosts (`@coffer_so/sdk` 1.5.0); absent on older backends.
   */
  boost?: PoolBoostSnapshot | null;
  /**
   * Boost APR now, % — simple, paid in the reward token, never part of
   * `apy`; null when no boost is active. Same backend as `boost`.
   */
  boostAprPct?: number | null;
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
  /**
   * Mint of the base asset — one of the pool tokens, any other value is a
   * 400 (a mint outside the pool was a 403 on backends before November
   * 2026); "" clears it.
   */
  baseAssetMint?: string;
  /**
   * Short description: up to 280 characters, counted after the backend's
   * trim (as sent on backends before November 2026); "" clears it.
   */
  description?: string;
  /**
   * One additional link (X account, site, …): an absolute `https://` URL of
   * at most 200 characters; "" clears it (backend with pool images,
   * November 2026; ignored by older backends).
   */
  additionalUrl?: string;
}

/**
 * Body of `createPool` (pool registration). Everything on-chain (fees,
 * admins, tokens, balances) is read from chain state by the backend; the
 * registrant wallet comes from the JWT. The pool image is not part of it —
 * call `uploadPoolImage` right after the registration succeeded.
 */
export interface CreatePoolBody {
  /** On-chain pool address (PDA). */
  poolAddress: string;
  /** 1–12 English letters and digits. */
  poolName: string;
  /**
   * Mint of the base asset (one of the pool tokens), shown first; absent or
   * "" = none. Any other value is a 400 (backends before November 2026:
   * a 403 for a mint outside the pool, a 400 for "").
   */
  baseAssetMint?: string;
  /** Short description: up to 280 characters, counted after the backend's trim. */
  description?: string;
  /**
   * One additional link, same rule as in `UpdatePoolSettingsBody`; absent
   * or "" = none (backend with pool images, November 2026; ignored by older
   * backends).
   */
  additionalUrl?: string;
  /** Optional assertion of the pool's protocol generation (5 or 6); a mismatch is a 422. */
  protocolVersion?: number;
}

/** Answer of `uploadPoolImage` / `removePoolImage`. */
export interface PoolImageResponse {
  poolAddress: string;
  /**
   * The new public URL (a 400×400 WebP); null after a removal. Opaque — it
   * changes with every new image and the previous URL stops working.
   */
  imageUrl: string | null;
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
  /**
   * Public profile card of this wallet, read live on every request; null
   * when it has set none of username, display name, avatar and X link
   * (backend with public profiles, November 2026; absent on older backends).
   */
  profile?: UserProfileCard | null;
}

export interface ReferralListResponse {
  total: number;
  page: number;
  limit: number;
  data: ReferralEntry[];
}

// ── Attribution types ──

/** Backend `MAX_LANDING_URL_LEN`: a longer landingUrl is dropped server-side. */
const ATTRIBUTION_MAX_LANDING_URL_LEN = 4096;
/** Only the referrer's host is used; the cap keeps the body under the 8kb parser limit. */
const ATTRIBUTION_MAX_REFERRER_LEN = 1024;

/**
 * One marketing touch (page load with UTM tags, click id, `ref` or an
 * external referrer, or a single "direct" visit per session). The backend
 * normalizes and stores it; no IP is kept. See the backend's
 * docs/ATTRIBUTION.md for when to send it and how to keep the ids.
 */
export interface AttributionLandingInput {
  /** Browser-scoped anonymous id (UUID v4), shared by landing and app. */
  anonId: string;
  /** Idempotency key (UUID v4): new per touch, the same on every retry. */
  touchId: string;
  /** anonId carried over from another browser (wallet in-app browser deeplink). */
  parentAnonId?: string;
  /** Full landing URL including the query string (`location.href`). */
  landingUrl: string;
  /** `document.referrer`, if any. */
  referrer?: string;
  /** Client time of the touch, unix milliseconds. Clamped by the server. */
  ts?: number;
}

export interface AttributionLandingResponse {
  ok: true;
}

export interface AttributionClaimResponse {
  ok: true;
  /** Number of anonIds linked to the authenticated wallet by this call. */
  linked: number;
}

// ── Profile types (public user profiles) ──

/**
 * Where a username came from: `sns` — seeded once from the wallet's primary
 * SNS name; `custom` — set by the owner. `sns` is the origin, not a proof:
 * the name is never re-checked, so it earns no "verified" badge.
 */
export type UsernameSource = "sns" | "custom";

/**
 * Short public profile of a wallet: the `profile` field of leaderboard,
 * campaign, referral and pool-transaction rows, and the items of
 * `getProfileCards`. Where it is embedded, the WHOLE card is null when the
 * wallet has set none of username, display name, avatar and X link — render
 * such a row from its address. Inside a card every field is null on its own.
 */
export interface UserProfileCard {
  /** Unique, lower-case; can change or move to another wallet at any time. Null → show the shortened address. */
  username: string | null;
  /** Null exactly when `username` is null. */
  usernameSource: UsernameSource | null;
  /** Free text, NOT unique. */
  displayName: string | null;
  /**
   * Opaque absolute URL of a 400×400 WebP — never build or parse it. It
   * changes with every new image and the previous URL stops working (404).
   * Null → draw an identicon from the full address.
   */
  avatarUrl: string | null;
  /** X account as the owner entered it — format-checked only, NOT verified. */
  x: { username: string; url: string } | null;
}

/**
 * Public profile of an address (`getPublicProfile`). Every valid address
 * has one: a wallet that never set anything up answers nulls.
 */
export interface PublicProfile extends UserProfileCard {
  /** The wallet's canonical address — also when the profile was asked for by username. */
  address: string;
  bio: string | null;
  /** Direct (level 1) referrals — `stats.l1Count` of the owner's `getReferralStatus`. */
  referralCount: number;
}

/** The authenticated wallet's profile — `getMyProfile` and the answer of every profile write. */
export interface MyProfile extends PublicProfile {
  edit: {
    /**
     * Locked by moderation (only the owner sees the flag): clearing a field,
     * a username reset and avatar removal still work, any new value is a 403.
     */
    locked: boolean;
  };
}

export interface UserProfileCardsResponse {
  /** One item per distinct requested address, in request order. */
  data: Array<{ address: string; profile: UserProfileCard | null }>;
}

/**
 * Partial update of the authenticated wallet's profile: a field that is
 * absent (or `undefined`) stays as it is, "" clears it. Never send null —
 * the backend answers 400.
 */
export interface UpdateMyProfileBody {
  /** Up to 32 characters: letters, digits, spaces and `. ' _ -`. */
  displayName?: string;
  /** Up to 160 characters: letters, digits, spaces and `. , ! ? ( ) ' : ; % + - – — #` (no links, no emoji). */
  bio?: string;
  /** X profile link (`https://x.com/alice_x`, `twitter.com/alice_x`), `@alice_x` or `alice_x`. */
  x?: string;
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
  /** POOL-wide APY, % — the same number as the pools page (legacy name). */
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

// ── Portfolio v2 types (redesigned portfolio page) ──

export type PortfolioChartMetric = "networth" | "pnl" | "il" | "xp";
/**
 * Metrics of the public chart (`getPublicPortfolioChart`): the private ones
 * without `networth` — the value of a whole wallet is not public.
 */
export type PublicPortfolioChartMetric = "pnl" | "il" | "xp";
export type PortfolioChartRange = "24h" | "1w" | "1m" | "1y" | "all";

export interface PortfolioChartResponse {
  metric: PortfolioChartMetric;
  range: PortfolioChartRange;
  /**
   * Echo of `options.pool` when the chart was narrowed to one position —
   * match a response to the positions-table row it belongs to. Absent on
   * whole-portfolio charts.
   */
  pool?: string;
  /** Distance between series/line points, seconds. */
  granularitySec: number;
  /**
   * Headline value: the last point. For `xp` — the lifetime XP total.
   * For `il` — the NET result (profit − il, the bottom line vs HODL).
   */
  current: number;
  /**
   * Change over the range (for XP: abs = XP earned in the range; for il:
   * the net change). `pct` is null when the base is zero/near-zero
   * (growth from nothing, or a signed pnl/net-il base under $1) — render
   * it as "—".
   */
  change: { abs: number; pct: number | null };
  /**
   * True when the data is partially estimated: wallet history coverage
   * hit its cap / the history API was unavailable (amounts frozen at the
   * horizon); pnl — a position predating the range closed inside it;
   * il — a basis token without price history, a snapshot older than an
   * LP event, or an exit that could not be priced.
   */
  approximate: boolean;
  /**
   * Why `approximate` is set — one human line per cause. Absent when exact,
   * and always absent in a `getPublicPortfolioChart` answer.
   */
  approximateReasons?: string[];
  /**
   * The single line, [unixSeconds, value] pairs ascending — for
   * `networth`, `pnl` and `xp`. ABSENT for `il`, which returns two
   * separate lines in `lines` instead.
   *
   * - networth: whole-portfolio USD value at each point.
   * - pnl: cumulative profit/loss vs invested dollars (never-decreasing
   *   is NOT guaranteed — it moves with the market and with fixations).
   * - xp: the total XP as of each point — cumulative, never decreasing.
   */
  series?: Array<[number, number]>;
  /**
   * `il` metric ONLY: two lines to draw on the same chart, both
   * [unixSeconds, value] ascending on a shared grid, BOTH as POSITIVE
   * magnitudes.
   * - `profit`: LP fees earned since the position's first deposit, as of
   *   each point — a LIFETIME level, not a per-range sum (≥ 0, draw green).
   * - `il`: impermanent loss as a positive number (≥ 0, draw red) — the
   *   red line already means "loss", so it carries no minus sign. Same
   *   formula as the positions table's `il` (HODL value of the deposited
   *   basket minus the position value excluding reinvested fees),
   *   evaluated at every point; realized divergence from withdrawals
   *   stays on the line.
   * The net LP result vs HODL is `profit − il`, and that is what
   * `current` and `change` report. There is no `series` for this metric.
   */
  lines?: {
    profit: Array<[number, number]>;
    il: Array<[number, number]>;
  };
  /**
   * `pnl` / `il` ONLY (whole wallet and `options.pool`): the user's actions
   * on the charted position(s) — liquidity added, zapped in, removed, LP
   * tokens sent / received — to draw as markers. At most one marker per
   * grid step (`granularitySec`): actions closer than that share a marker
   * and its `events` list them. Every `marker.t` IS a point of `series` /
   * `lines`: the grid gets an extra point at each marker, so the line
   * bends exactly where the action happened and the marker's Y is the
   * line's value at that `t` (exact lookup, no interpolation; the points
   * are therefore no longer strictly evenly spaced — pick axis ticks from
   * the regular points). Actions worth less than $1 are left out. Empty
   * when there were no actions in the range; absent for `networth` / `xp`.
   */
  markers?: PortfolioChartMarker[];
}

export type PortfolioChartEventType =
  | "added"
  | "zap"
  | "removed"
  | "sent"
  | "received";

/** One user action behind a chart marker. */
export interface PortfolioChartEvent {
  /** Unix seconds — the exact moment of the transaction. */
  t: number;
  type: PortfolioChartEventType;
  pool: { address: string; name: string };
  /**
   * Signed like the activity feed: + for added / zap / received, − for
   * removed / sent. Deposits and withdrawals carry the indexed transaction's
   * USD (all its LP instructions summed); transfers the LP tokens moved ×
   * the LP price at that moment. `null` when a transfer could not be priced.
   */
  usd: number | null;
  /** LP tokens moved, human units, same sign as `usd`. */
  bptDelta: number;
  /**
   * Transaction signature — pass it as `highlight` to `getPortfolioActivity`
   * to land on that row. `null` when unknown (a transfer older than the
   * wallet-history page cap): render the marker without a link.
   */
  signature: string | null;
}

/** A cluster of actions drawn as one marker on a `pnl` / `il` chart. */
export interface PortfolioChartMarker {
  /** Unix seconds — always a point of `series` / `lines`. */
  t: number;
  /** The cluster's events, ascending by time; `t` is the first one's. */
  events: PortfolioChartEvent[];
}

export type PortfolioActivityType =
  | "swap"
  | "added"
  | "removed"
  | "zap"
  | "sent"
  | "received"
  | "deployed";

export type PortfolioActivityFilter =
  | "all"
  | "liquidity"
  | "zap"
  | "swap"
  | "transfer"
  | "deployed";

export interface ActivityTokenInfo {
  mint: string;
  symbol: string | null;
  logo: string | null;
}

export interface PortfolioActivityItem {
  type: PortfolioActivityType;
  signature: string;
  /** Unix seconds. */
  time: number;
  /**
   * Signed USD: + for added/zap/received, − for removed/sent, unsigned for
   * swap; null when unpriceable and for deployed rows.
   */
  valueUsd: number | null;
  pool: {
    address: string;
    name: string;
    /**
     * Pool image set by the pool admin; null → compose one from the token
     * logos (backend with pool images, November 2026; absent on older
     * backends — read a missing key as null).
     */
    imageUrl?: string | null;
    feePercent: number | null;
    bptMint: string | null;
    tokens: ActivityTokenInfo[];
    /** Pool weights in % (for the deployed row's "80/20 weights" subtitle). */
    weights?: number[];
  } | null;
  /** Only on swap rows. */
  swap?: { tokenIn: ActivityTokenInfo; tokenOut: ActivityTokenInfo };
  /** Only on sent/received rows (wallet-to-wallet LP token transfers). */
  transfer?: { counterparty: string | null };
}

export interface PortfolioActivityResponse {
  total: number;
  /** The page served — with `highlight`, the page that contains that transaction. */
  page: number;
  limit: number;
  data: PortfolioActivityItem[];
  /**
   * The row `options.highlight` asked for: its index in `data` (a
   * transaction with several LP instructions has several rows with the
   * same signature — highlight all of them). `null` when no row of the
   * feed under the given `type` filter has that signature, or when
   * `highlight` was not passed.
   */
  highlight: { signature: string; index: number } | null;
}

export type SortOrder = "desc" | "asc";
export type PortfolioActivitySortField = "time" | "value";
export type PortfolioHoldingsSortField = "value" | "price" | "balance";

export interface PortfolioHoldingItem {
  token: {
    mint: string;
    symbol: string | null;
    /** Full token name (e.g. "USD Coin"); null when metadata has none. */
    name: string | null;
    logo: string | null;
  };
  priceUsd: number;
  /**
   * Total amount: wallet + decomposed LP positions. In a
   * `getPublicPortfolioHoldings` answer — the LP positions alone.
   */
  balance: number;
  valueUsd: number;
  /** Source breakdown for the tooltip; pct is of the token's balance. */
  sources: {
    /** Always `{ amount: 0, pct: 0 }` in a `getPublicPortfolioHoldings` answer. */
    wallet: { amount: number; pct: number };
    pools: Array<{
      poolAddress: string;
      poolName: string;
      amount: number;
      pct: number;
    }>;
  };
}

export interface PortfolioHoldingsResponse {
  total: number;
  page: number;
  limit: number;
  data: PortfolioHoldingItem[];
}

export type PortfolioPositionsSortField =
  | "value"
  | "fees"
  | "il"
  | "pnl"
  | "apy";

export interface PortfolioPositionItem {
  pool: {
    address: string;
    name: string;
    /**
     * Pool image set by the pool admin; null → compose one from the token
     * logos (backend with pool images, November 2026; absent on older
     * backends — read a missing key as null).
     */
    imageUrl?: string | null;
    feePercent: number | null;
    bptMint: string | null;
    tokens: ActivityTokenInfo[];
  };
  /**
   * Position value from the 30s-fresh wallet LP balance. In a
   * `getPublicPortfolioPositions` answer — from the balance of the
   * backend's stored position snapshot.
   */
  valueUsd: number;
  /** Lifetime LP fees earned in this pool. */
  feesEarned: number;
  /** Live unrealized IL (≤ 0); the realized part is `ilRealized`. */
  il: number;
  ilRealized: number;
  /** feesEarned + il + ilRealized. */
  netPnl: number;
  /** POOL-wide APY, % (24h-based) — the same number as the pools page. */
  apy: number;
  /**
   * Boost APR of the pool now, % (simple, in the reward token; never part
   * of `apy`); null without an active boost. Backend with boosts (1.5.0);
   * absent on older backends.
   */
  boostAprPct?: number | null;
}

export interface PortfolioPositionsResponse {
  /** Number of ACTIVE positions (the "N active positions" header). */
  total: number;
  page: number;
  limit: number;
  /** Σ value of ALL active positions (the header total), not the page. */
  totalValueUsd: number;
  data: PortfolioPositionItem[];
}

// ── Boosts (coffer_rewards) types — backend docs/BOOSTS.md ──
//
// Every `…Raw` field is a decimal string of raw u64 units (never a JS
// number); times are ISO 8601 UTC; APRs are percents (18.4 = 18.4 %).

export type PoolBoostStatus = "scheduled" | "active" | "ended" | "cancelled";

/** One boost of a pool (`Pool.boost.items[]`). */
export interface PoolBoostItem {
  /** The boost id. */
  id: number;
  /** The campaign account a voucher and a claim name. */
  campaign: string;
  /** Reward mint; wrapped SOL (So111…112) for a SOL campaign. */
  rewardMint: string;
  rewardSymbol: string | null;
  rewardDecimals: number;
  /** Price when the snapshot was written; null = no price. */
  rewardPriceUsd: number | null;
  /** Recomputed from the clock every time the pool is read. */
  status: PoolBoostStatus;
  /** Whole UTC hours. */
  startAt: string;
  /** Planned end of the terms in force; can move earlier (stop, shorten). */
  endAt: string;
  /** min(cap, budget per day × 365 × price / eligibleTvlUsd), simple; a projection while scheduled, 0 once ended. */
  aprPct: number;
  aprCapPct: number;
  /** The cap is below the budget APR: the rest of the budget is refunded. */
  capBinding: boolean;
  /** Budget per day of the terms in force; "0" once ended. */
  ratePerDayRaw: string;
  budgetRaw: string;
  /** Accrued to LPs by the finalized days. */
  emittedRaw: string;
  /** Back to the campaign: above the cap, rounding, forfeits. */
  refundedRaw: string;
  /** End of the last finalized day; null before the first. */
  finalizedThrough: string | null;
  /** Vouchers are signed for this campaign now. */
  claimsOpen: boolean;
  /** The campaign's liquidity covers what it owes (a pool admin's: plus the rest of its budgets). */
  funded: boolean;
  unreliable: boolean;
  /** No APR cap (a pool admin's boost in a token without a price): show the reward per day, not a cap; aprCapPct is 0. Absent on older backends. */
  uncapped?: boolean;
  /** Paused because its campaign stopped covering it: it pays nothing until funded again. */
  paused?: "underfunded" | null;
  /** Who pays: the protocol, or the pool admin from its own campaign (which it can withdraw from — say so next to the APR). */
  sponsor?: { kind: "protocol" | "pool_admin"; wallet: string | null };
}

/** Plan name of a pool boost item. */
export type PoolBoost = PoolBoostItem;

/**
 * `Pool.boost` (version 1). On every raw pool answer as `boost`
 * (`PoolBoostSnapshot | null`) next to `boostAprPct` (`number | null`).
 * Treat a `v` other than 1 as "no boost".
 */
export interface PoolBoostSnapshot {
  v: 1;
  asOf: string;
  /** Σ aprPct of the active items (= boostAprPct); 0 when none is active. */
  aprPct: number;
  unreliable: boolean;
  /** USD value of the LP held by the wallets that take part; the APR is computed on it. */
  eligibleTvlUsd: number;
  items: PoolBoostItem[];
}

/** An item of `GET /api/rewards/boosts`. */
export interface PublicBoostPool {
  poolAddress: string;
  poolName: string;
  imageUrl: string | null;
  bptMint: string | null;
  tvlUsd: number | null;
  /** null when no item is active (only scheduled boosts). */
  boostAprPct: number | null;
  /** items: active and scheduled only. */
  boost: PoolBoostSnapshot;
}

/** `GET /api/rewards/boosts`: pools with an active or scheduled boost, highest boostAprPct first. */
export interface PublicBoostsResponse {
  asOf: string;
  pools: PublicBoostPool[];
}

/** A live campaign of the backend, as last read from the chain. */
export interface PublicCampaign {
  id: number;
  address: string;
  programId: string;
  admin: string;
  /** Who funds it; absent on older backends (= the protocol). */
  ownerKind?: "protocol" | "pool_admin";
  /** Most gross units all claims together may take per window ("0" = no limit), and the window. */
  payoutLimitRaw?: string;
  payoutWindowSec?: string;
  /** Closed on chain: it pays nothing more. */
  closedAt?: string | null;
  /** 32 bytes, hex: sha256("coffer-boosts:v2:<cluster>:<mint|native>:<generation>"). */
  campaignId: string;
  bump: number;
  native: boolean;
  /** On-chain field: 1111…1111 for SOL. */
  mint: string;
  /** Wrapped SOL for a SOL campaign. */
  rewardMint: string;
  rewardSymbol: string | null;
  tokenProgram: string;
  decimals: number;
  /** Token-2022 extension types of the mint. */
  mintExtensions: number[];
  /** ATA(campaign, mint, tokenProgram), or PDA ["sol", campaign] for SOL. */
  vault: string;
  backendSigner: string;
  signerEpoch: string;
  liquidityRaw: string;
  /** null when the vault was not read yet or does not exist; lamports with rent for SOL. */
  vaultBalanceRaw: string | null;
  stateSlot: string | null;
  stateReadAt: string | null;
  /** Includes backendSigner === signer. */
  claimsOpen: boolean;
  label: string | null;
}

/** `GET /api/rewards/campaigns`. */
export interface PublicCampaignsResponse {
  programId: string;
  cluster: "mainnet" | "devnet";
  /** null while the backend does not sign. */
  signer: string | null;
  campaigns: PublicCampaign[];
}

export interface WalletCampaignRewards {
  /** Backend id of the campaign (not the on-chain 32-byte id). */
  campaignId: number;
  campaign: string;
  rewardMint: string;
  rewardSymbol: string | null;
  rewardDecimals: number;
  /** Finalized all-time total. */
  earnedRaw: string;
  /** Admin additions younger than the change delay: in earnedRaw, not claimable yet. */
  pendingRaw: string;
  claimedRaw: string;
  /** max(0, earned − pending − claimed). */
  claimableRaw: string;
  /** claimableRaw clipped to the last-read liquidity and vault (estimate). */
  claimableNowRaw: string;
  /** Reserved while the wallet's LP history is checked; not in earnedRaw. */
  heldRaw: string;
  finalizedThrough: string | null;
  claimsOpen: boolean;
}

export interface WalletBoostRewards {
  boostId: number;
  poolAddress: string;
  /** null once the boost left Pool.boost (7 days after its end). */
  poolName: string | null;
  campaignId: number;
  campaign: string;
  rewardMint: string;
  rewardSymbol: string | null;
  rewardDecimals: number;
  /** null once the boost left Pool.boost. */
  status: PoolBoostStatus | null;
  startAt: string;
  endAt: string;
  /** null once the boost left Pool.boost. */
  aprPct: number | null;
  earnedRaw: string;
  heldRaw: string;
  /** Stored LP balance of the wallet on that pool. */
  lpBalanceRaw: string;
  /** The wallet takes part (signer key, not a pool holder, not excluded, not the campaign admin). */
  eligible: boolean;
  /** Estimate at the APR now; "0" when active but not earning; null when not active or not computable. */
  estPerDayRaw: string | null;
  finalizedThrough: string | null;
}

/** `GET /api/rewards/wallets/:ref`. */
export interface WalletRewardsResponse {
  wallet: string;
  asOf: string;
  campaigns: WalletCampaignRewards[];
  boosts: WalletBoostRewards[];
}

/** `POST /api/rewards/vouchers` — check and use it with `parseRewardVoucher` / `buildRewardClaimTx`. */
export interface RewardVoucherResponse {
  programId: string;
  campaign: string;
  beneficiary: string;
  /** Campaign.domain, 32 bytes base64 (signed into the voucher). */
  domain: string;
  signerEpoch: string;
  /** Cumulative net total the voucher allows, all time. */
  totalRaw: string;
  /** Unix seconds (decimal string): claim before it, or ask for a new voucher (6009 VoucherExpired). */
  expiresAt: string;
  signer: string;
  /** Ed25519, base64. */
  signature: string;
  /** The 169 signed bytes (voucher V2), base64. */
  message: string;
  /** Receipt.claimed at confirmed; "0" without a receipt. */
  claimedRaw: string;
  /** What a claim would pay now: due, clipped to liquidity, vault and the payout window's allowance. */
  claimableNowRaw: string;
  /** Unix seconds when the payout window's allowance resets; null without a limit or when it is not exhausted. */
  windowResetsAt?: string | null;
  liquidityRaw: string;
  /** 1111…1111 for SOL. */
  mint: string;
  tokenProgram: string;
  decimals: number;
}

// ── Boosts run by a pool admin ──

/** A boost's terms from a pool admin; times ISO or unix seconds, whole UTC hours. */
export interface PoolAdminBoostTerms {
  campaignId: number;
  startAt: string;
  endAt: string;
  /** Total budget, raw net units of the reward token. */
  budgetRaw: string;
  /** APR cap, bps: required for a reward token with a price, left out without one (the budget alone). */
  capBps?: number;
}

/** A registered campaign as the backend stores it (numbers as strings, times ISO). */
export interface PoolAdminCampaign {
  id: number;
  address: string;
  admin: string;
  ownerKind: "protocol" | "pool_admin";
  idGeneration: number;
  native: boolean;
  mint: string;
  tokenProgram: string;
  decimals: number;
  vaultAddress: string;
  backendSigner: string;
  signerEpoch: string;
  liquidityRaw: string;
  payoutLimitRaw: string;
  payoutWindowSec: string;
  issuancePaused: boolean;
  closedAt: string | null;
  label: string | null;
  [key: string]: unknown;
}

/** The funding of a campaign now (backend funding.util): what it owes and what a pool admin's campaign must hold. */
export interface PoolAdminCampaignFunding {
  liquidityRaw: string;
  outstandingGrossRaw: string;
  committedRaw: string;
  requiredFullRaw: string;
  fullyFunded: boolean;
  depositToFullRaw: string;
  withdrawableFullRaw: string;
  payoutLimitRaw: string;
  payoutWindowSec: string;
  payoutLimitPerDayRaw: string | null;
  payoutLimitOk: boolean;
  payoutLimitMinPerDayRaw: string;
  projectedDailyRaw: string;
  [key: string]: unknown;
}

export interface PoolAdminCampaignWithFunding {
  campaign: PoolAdminCampaign;
  /** null when the chain could not be read now, or the campaign is closed. */
  funding: PoolAdminCampaignFunding | null;
}

export interface PoolAdminCampaignParams {
  programId: string;
  cluster: "mainnet" | "devnet";
  admin: string;
  mint: string;
  /** Generation of the campaign id (a closed address is never reused). */
  generation: number;
  /** The 32-byte id, hex: `boostsCampaignId(cluster, mint, generation)`. */
  campaignIdHex: string;
  address: string;
  bump: number;
  /** free: create it; unregistered: it exists, register it; registered: `campaign` is it. */
  state: "free" | "unregistered" | "registered";
  campaign: PoolAdminCampaign | null;
  backendSigner: string;
  /** The longest payout window the backend accepts (the limit is required). */
  payoutWindowSec: number;
  note: string;
}

/** A boost as the backend answers it: the row, its phase and every terms version. */
export interface PoolAdminBoostView {
  boost: { id: number; poolAddress: string; campaignId: number; state: string; startAt: string; endAt: string; fundingPausedAt: string | null; hiddenAt: string | null; [key: string]: unknown };
  phase: "scheduled" | "active" | "ended" | "cancelled";
  terms: Array<{ id: number; kind: string; effectiveFrom: string; endAt: string; budgetRaw: string; capBps: number; delayed: boolean; increases: string[]; [key: string]: unknown }>;
  keptTermsIds: number[];
  currentTermsId: number | null;
}

export interface PoolAdminBoostsOverview {
  poolAddress: string;
  enabled: boolean;
  boosts: Array<PoolAdminBoostView & { ownerKind: "protocol" | "pool_admin"; yours: boolean }>;
  campaigns: PoolAdminCampaignWithFunding[];
}

export interface PoolAdminBoostPreview {
  durationDays: number;
  budgetPerDayRaw: string;
  budgetPerDayUsd: number | null;
  capPct: number;
  uncapped: boolean;
  rewardPriceUsd: number | null;
  rewardHasPrice: boolean;
  capBps: number;
  breakEvenTvlUsd: number | null;
  atCurrent: { tvlUsd: number; aprPct: number; capBinding: boolean; spendPerDayRaw: string; spendPerDayUsd: number | null; refundPerDayRaw: string } | null;
  curve: Array<{ tvlUsd: number; aprPct: number; capBinding: boolean; spendPerDayRaw: string; spendPerDayUsd: number | null; refundPerDayRaw: string }>;
  valid: boolean;
  error: string | null;
  prefund: { liquidityRaw: string; requiredRaw: string; depositRaw: string; fullyFunded: boolean; payoutLimitOk: boolean; payoutLimitMinPerDayRaw: string } | null;
}

/** `code` of a `/api/rewards/*` error answer (`{ statusCode, code, message }`). */
export type RewardVoucherErrorCode =
  | "unknown_campaign" // 404
  | "campaign_closed" // 410
  | "not_funded" // 409 (pool admin boosts)
  | "payout_limit_low" // 409
  | "cap_required" // 400
  | "cap_without_price" // 400
  | "budget_too_small" // 400
  | "not_your_campaign" // 403
  | "not_your_pool" // 400
  | "campaign_checks" // 400
  | "boosts_off" // 503
  | "nothing_accrued" // 404
  | "already_claimed" // 409
  | "change_pending" // 409
  | "issuance_paused" // 423
  | "signer_mismatch" // 423
  | "signing_off" // 503
  | "ledger_check"; // 503

/** The JSON body of a `/api/rewards/*` error. */
/**
 * A failed rewards call's body. BOOSTS.md documents `{ statusCode, code, message }`;
 * a backend whose global exception filter rewrites errors sends
 * `{ success: false, error }` instead, without `code`.
 */
export interface RewardsApiErrorBody {
  statusCode?: number;
  code?: string;
  /** An array for a 400 from validation. */
  message?: string | string[];
  success?: false;
  /** The message in the `{ success: false, error }` shape. */
  error?: string;
}

/** What `getRewardsApiError` reads off a failed rewards call. */
export interface RewardsApiError {
  status: number;
  /**
   * A known code; null for none (400, 429, a plain 503), an unknown one (see
   * `body.code`), or a `{ success: false, error }` body, which carries no code.
   */
  code: RewardVoucherErrorCode | null;
  message: string;
  body: RewardsApiErrorBody | null;
}

const REWARD_VOUCHER_ERROR_CODES: ReadonlySet<string> = new Set([
  "unknown_campaign",
  "nothing_accrued",
  "already_claimed",
  "change_pending",
  "issuance_paused",
  "signer_mismatch",
  "signing_off",
  "ledger_check",
]);

/**
 * The HTTP status and the backend `code` of a failed rewards call
 * (`getRewardBoosts`, `getRewardCampaigns`, `getWalletRewards`,
 * `requestRewardVoucher`); null when no HTTP answer came back.
 */
export function getRewardsApiError(error: SdkError): RewardsApiError | null {
  const cause = error.cause as { status?: unknown; body?: unknown } | null | undefined;
  if (!cause || typeof cause.status !== "number") return null;
  const body = cause.body && typeof cause.body === "object" ? (cause.body as RewardsApiErrorBody) : null;
  const code = typeof body?.code === "string" && REWARD_VOUCHER_ERROR_CODES.has(body.code) ? (body.code as RewardVoucherErrorCode) : null;
  const raw = body ? body.message ?? body.error : undefined;
  const message = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
  return { status: cause.status, code, message: message || error.humanMessage, body };
}

// ── Token pair-chart types (pool creation range picker) ──

export type PairChartRange = "1d" | "1w" | "1m" | "1y" | "all";

/**
 * Price of token `a` expressed in units of token `b` over time — the
 * one-line chart behind the range picker on the pool creation page.
 */
export interface TokenPairChartResponse {
  /** Numerator mint — the token being priced. */
  a: string;
  /** Denominator mint — the token `a` is priced IN. */
  b: string;
  range: PairChartRange;
  /** Spacing between series points, seconds. */
  granularitySec: number;
  current: {
    /**
     * How many units of `b` one unit of `a` is worth right now — the
     * big "1,284.52 SOL/USDT" headline number.
     */
    ratio: number;
    /** Current USD price of `a` — the grey "$345.44" next to it. */
    aUsd: number;
    /** Current USD price of `b`. */
    bUsd: number;
  };
  /**
   * Change of the pair price over the range. `pct` is null when the
   * range started from an unknown (zero) price — render "—".
   */
  change: { abs: number; pct: number | null };
  /**
   * [unixSeconds, priceAinB] ascending — ONE line. Values are rounded
   * to 6 significant digits (pairs like BONK/SOL live around 1e-9).
   */
  series: Array<[number, number]>;
}

// ── Pool chart types (pool page) ──

/**
 * `lpPrice` — USD price of ONE LP token of the pool (backend release
 * of November 2026; backends before it answer 400 for it, and 404 before the
 * chart route existed, September 2026).
 */
export type PoolChartMetric = "apy" | "tvl" | "volume" | "fees" | "lpPrice";
export type PoolChartRange = "24h" | "1w" | "1m" | "6m" | "1y" | "all";
/** Rolling window the APY is computed over. Ignored for other metrics. */
export type PoolChartBasis = "24h" | "7d";

/** One point of a pool series: `t` is unix MILLISECONDS. */
export interface PoolChartPoint {
  t: number;
  v: number;
}

/**
 * Historical series for a single pool — the chart card on the pool page.
 *
 * Values are percent for `apy`, USD for `tvl` / `volume` / `fees`, and USD
 * per one LP token for `lpPrice`. `fees` is the TOTAL fee flow (LP +
 * protocol share) per point.
 */
export interface PoolChartResponse {
  poolAddress: string;
  metric: PoolChartMetric;
  range: PoolChartRange;
  /** Spacing between points, seconds — the grid is uniform. */
  granularitySec: number;
  /** Echo of the APY basis; absent for non-APY metrics. */
  basis?: PoolChartBasis;
  /**
   * Latest value of the series — render this as the headline rather than
   * reading `points.at(-1)`, so the number always matches the line.
   */
  current: number;
  /**
   * Change across the range. `pct` is null when the range starts at zero
   * (a pool with no activity yet) — render "—" instead of an infinity.
   */
  change: { abs: number; pct: number | null };
  /** Ascending by time. */
  points: PoolChartPoint[];
}

// ── Pool token chart types (pool page composition rows) ──

/** Curve price bounds of one pool token, in base-token units. */
export interface PoolTokenPriceBounds {
  /** Lowest price the curve allows. */
  min: number;
  /** Current marginal price. */
  spot: number;
  /** Highest price the curve allows; `null` means unbounded. */
  max: number | null;
}

export interface PoolTokenChartEntry {
  mint: string;
  symbol: string | null;
  /** Position in the pool; the base token is index 0. */
  orderIndex: number;
  /** Weight in percent (e.g. 33.33). */
  weight: number;
  /**
   * Price-range slider bounds. `null` for the base token (nothing to
   * quote it against) and when the pair has no usable state — render "—".
   *
   * These MOVE: they are derived from live virtual/actual balances, not
   * stored settings, so every swap shifts them.
   */
  bounds: PoolTokenPriceBounds | null;
  /** Live price in base-token units per 1 token. */
  currentRatio: number;
  /** Change over the range; `pct` is null on a zero base. */
  change: { abs: number; pct: number | null };
  /** `[unixSeconds, ratio]` ascending. Empty for the base token. */
  series: Array<[number, number]>;
}

/**
 * Every pool token priced in the pool's base token — the composition
 * table's price column and its per-row chart, in one response.
 */
export interface PoolTokenChartResponse {
  poolAddress: string;
  range: PairChartRange;
  /** Spacing between series points, seconds. 0 when nothing is charted. */
  granularitySec: number;
  /** The token every series is quoted in — the pool's first token. */
  base: { mint: string; symbol: string | null };
  tokens: PoolTokenChartEntry[];
}

// ── Auth types ──

export interface NonceResponse {
  nonce: string;
  message: string;
}

/**
 * Challenge for the transaction-based sign-in fallback (wallets whose
 * signMessage path is broken — Ledger through mobile apps first of all).
 */
export interface TxChallengeResponse {
  nonce: string;
  /** Base64-encoded UNSIGNED transaction to pass to wallet.signTransaction. */
  transaction: string;
  /** Human-readable memo embedded in the transaction (agreements + nonce). */
  memo: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  wallet: string;
  expiresIn: string;
}

/**
 * REST wrapper around the Coffer backend. Every method is a SdkResult; no
 * exceptions escape. If a request fails, the result carries a
 * human-readable error plus the original cause.
 *
 * Auto-refresh: when a request gets 401, the client automatically tries
 * to refresh tokens via POST /api/auth/refresh. If successful, the
 * original request is retried once with the new access token.
 *
 * Retries: by default a request is tried up to 3 times (15 s timeout each)
 * when no HTTP answer came back (`backend_unavailable`, e.g. browser
 * "Failed to fetch"), on a timeout (`rpc_timeout`), on HTTP 429
 * (`rpc_rate_limited`) and on HTTP 5xx (`backend_unavailable`). Any other
 * HTTP status is final (`unknown`, `cause.status` holds the status,
 * `humanMessage` reads "METHOD path → HTTP nnn …"), and so are a request
 * the runtime refused to send (invalid URL or header value: `unknown` with
 * the original message) and a 2xx body that is not JSON
 * (`backend_invalid_response`). `claimAttribution` and
 * `requestRewardVoucher` retry only transport errors and timeouts; `verifySignature` and `verifyTransaction` retry only
 * HTTP 429 (the nonce is single-use, and a 5xx, a transport error or a
 * timeout may come after the server already consumed it). Between attempts
 * the client waits 200 ms, then 500 ms; `getPublicPortfolioChart` alone
 * waits 2 s both times (the backend's `Retry-After` for a busy chart).
 *
 * A failed refresh clears the tokens and calls `onAuthExpired` only when the
 * backend rejected the refresh token (HTTP 400/401). If the refresh got no
 * answer (offline, timeout, 5xx) the tokens are kept and the caller gets the
 * original 401.
 */
export class CofferBackendClient {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private refreshToken: string | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private readonly onTokenRefreshed?: (tokens: AuthTokens) => void;
  private readonly onAuthExpired?: () => void;

  constructor(params: CofferBackendClientParams) {
    this.endpoint = params.apiEndpoint.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
      ...(params.defaultHeaders ?? {}),
    };
    this.onTokenRefreshed = params.onTokenRefreshed;
    this.onAuthExpired = params.onAuthExpired;
  }

  async listPools(): Promise<SdkResult<PoolSummary[]>> {
    const pools: PoolSummary[] = [];
    let path = "/api/pools";
    for (;;) {
      const page = await this.get<PoolSummaryRow[] | { data: PoolSummaryRow[]; hasMore?: boolean }>(path);
      if (!page.ok) return page;
      const body = page.data;
      const rows = Array.isArray(body) ? body : body?.data;
      if (!Array.isArray(rows)) return err("parse_failure", "Invalid pool list from backend");
      for (const row of rows) {
        const pool = toPoolSummary(row);
        if (!pool) return err("parse_failure", "Invalid pool summary from backend");
        pools.push(pool);
      }
      if (Array.isArray(body) || !body.hasMore) return ok(pools);
      if (!rows.length) return err("parse_failure", "Backend returned an empty intermediate pool page");
      path = `/api/pools?limit=${rows.length}&offset=${pools.length}`;
    }
  }

  async getPool(addr: string): Promise<SdkResult<PoolSummary>> {
    const result = await this.get<PoolSummaryRow | { data: PoolSummaryRow }>(`/api/pools/${encodeURIComponent(addr)}`);
    if (!result.ok) return result;
    const body = result.data;
    if (!body || typeof body !== "object") return err("parse_failure", "Invalid pool summary from backend");
    const pool = toPoolSummary("data" in body ? body.data : body);
    return pool ? ok(pool) : err("parse_failure", "Invalid pool summary from backend");
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

  /**
   * Register a pool the authenticated wallet deployed; answers the pool
   * object. The body is `CreatePoolBody` (the parameter stays `unknown` for
   * compatibility). It cannot carry an image: call `uploadPoolImage` right
   * after this succeeded. Requires authentication.
   */
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

  /**
   * Pool transaction history, newest first; `T` is the caller's type of
   * the row array. Every row names its author in `userAddress` (not
   * `address`) and, on a backend with public profiles (November 2026),
   * carries the author's card as `profile: UserProfileCard | null`.
   */
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

  // ── Frozen snapshots: finished epochs and campaigns ──

  /**
   * The leaderboard as it stood the instant `epoch` ended — frozen, never
   * recomputed. Only finished epochs: the current one is a 404, as is an
   * epoch whose snapshot is not finalized yet (check
   * `epochs[].finalized` from getLeaderboardEpoch). Paginated like
   * getLeaderboard. Safe to cache forever once received — except the
   * `profile` card of each row, which is read live.
   */
  getLeaderboardEpochSnapshot(
    epoch: number,
    page: number = 1,
    limit: number = 20,
  ): Promise<SdkResult<EpochSnapshotResponse>> {
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    return this.get<EpochSnapshotResponse>(
      `/api/leaderboard/epoch/${epoch}?${qs.toString()}`,
    );
  }

  /**
   * A wallet's frozen place and points at the end of `epoch` — the place
   * it held in THAT snapshot, not its live rank today. 404 if the wallet
   * was not on the board at the time. Same envelope as getLeaderboardUser.
   */
  getLeaderboardEpochUser(
    epoch: number,
    address: string,
  ): Promise<SdkResult<EpochSnapshotUser>> {
    return this.getDataField<EpochSnapshotUser>(
      `/api/leaderboard/epoch/${epoch}/user/${encodeURIComponent(address)}`,
    );
  }

  /**
   * Every campaign, newest first, with whether its frozen results exist.
   * A campaign is `ended` the moment its window closes and `finalized` a
   * grace period (24h) later; in between, the live campaign endpoints
   * still serve its (already fixed) standings.
   */
  getCampaignHistory(): Promise<SdkResult<CampaignHistoryEntry[]>> {
    return this.get<CampaignHistoryEntry[]>("/api/campaign/history");
  }

  /**
   * Frozen final standings of a finished campaign, prizes resolved per
   * row. Same shape as getCampaignTop plus `prizeUsd` and the tiers in
   * the header, so a results page needs one call. 404 until finalized.
   */
  getCampaignSnapshotTop(
    campaign: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<SdkResult<CampaignSnapshotTopResponse>> {
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    return this.get<CampaignSnapshotTopResponse>(
      `/api/campaign/${encodeURIComponent(campaign)}/top?${qs.toString()}`,
    );
  }

  /**
   * A wallet's frozen result in a finished campaign, by address (no auth —
   * results are public once frozen). Mirrors getCampaignRank. 404 until
   * the campaign is finalized.
   */
  getCampaignSnapshotUser(
    campaign: string,
    address: string,
  ): Promise<SdkResult<CampaignSnapshotUserResponse>> {
    return this.get<CampaignSnapshotUserResponse>(
      `/api/campaign/${encodeURIComponent(campaign)}/user/${encodeURIComponent(address)}`,
    );
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
   * Requires authentication. On a backend with pool images (November 2026)
   * the name follows the rule of pool creation — 1–12 English letters and
   * digits, anything else is a 400; before that, 2–64 characters.
   */
  renamePool(poolAddress: string, name: string): Promise<SdkResult<RenamePoolResponse>> {
    return this.put<RenamePoolResponse>(
      `/api/pools/admin/${encodeURIComponent(poolAddress)}/name`,
      { name },
    );
  }

  /**
   * Update off-chain pool settings (base asset, description, additional
   * link). Only fields present are changed; empty string clears a field
   * (never send null for "no change" — null clears it too). Base asset
   * must be one of the pool tokens. Pool admin only; requires
   * authentication. `T` is the backend's answer as is:
   * `{ success, data: <pool object> }`. The pool image has its own methods:
   * `uploadPoolImage` / `removePoolImage`.
   * Statuses: 400 a refused value, a base asset that is not a token of
   * the pool included (that one was a 403 on backends before November
   * 2026); 403 not the pool admin; 404 pool not registered.
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

  /**
   * Upload the pool image. `image` is base64, bare or as a
   * `data:image/...;base64,` URL (FileReader.readAsDataURL): PNG, JPEG or
   * WebP, at most 512 KB decoded and 2048×2048 px. The backend stores a
   * 400×400 WebP, centre-cropped when the upload is not square — crop on the
   * client and check the size before sending. Pool admin only; requires
   * authentication. At pool creation call it right after `createPool`.
   * Idempotent: the same image ends at the same `imageUrl`, so the default
   * re-sends are safe.
   * Statuses: 400 not base64, 403 not the pool admin, 404 pool not
   * registered, 413 over 512 KB, 422 not a PNG/JPEG/WebP, damaged or over
   * the pixel limit, 429 more than 20 image changes of this pool in 10
   * minutes, 503 encoder busy (re-sent by the SDK).
   */
  uploadPoolImage(
    poolAddress: string,
    image: string,
  ): Promise<SdkResult<PoolImageResponse>> {
    return this.putDataField<PoolImageResponse>(
      `/api/pools/admin/${encodeURIComponent(poolAddress)}/image`,
      { image },
    );
  }

  /**
   * Remove the pool image; answers `imageUrl: null` (the pool reads then
   * return null too — compose the picture from the token icons).
   * Idempotent. Pool admin only; requires authentication. Shares the 429
   * limit of `uploadPoolImage`.
   */
  removePoolImage(
    poolAddress: string,
  ): Promise<SdkResult<PoolImageResponse>> {
    return this.postDataField<PoolImageResponse>(
      `/api/pools/admin/${encodeURIComponent(poolAddress)}/image/remove`,
      {},
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

  // ── Attribution ──

  /**
   * Record a marketing touch (UTM tags, click id, referrer) for an
   * anonymous browser id. Public; if tokens are set, the backend also links
   * the anonId to the wallet. The backend answers `{ ok: true }` (202) and
   * drops invalid or duplicate touches itself. A landingUrl over 4096 chars
   * is not sent at all (the backend would drop it) and also resolves to
   * `{ ok: true }`. Network failures, timeouts, 429 and 5xx are retried
   * (3 attempts) and then return `ok: false`, so cap the app's resend
   * queue. Retries are safe: the backend deduplicates by `touchId`.
   */
  recordAttributionLanding(
    input: AttributionLandingInput,
  ): Promise<SdkResult<AttributionLandingResponse>> {
    // The backend drops a landingUrl over 4096 chars anyway, so it is not
    // sent at all (saves traffic). The backend now attaches CORS headers to
    // the 202 it answers on a body-parser rejection, so this guard is no
    // longer what keeps the browser from seeing "Failed to fetch".
    if (input.landingUrl.length > ATTRIBUTION_MAX_LANDING_URL_LEN) {
      return Promise.resolve(ok({ ok: true }));
    }
    const body: Record<string, unknown> = {
      anonId: input.anonId,
      touchId: input.touchId,
      landingUrl: input.landingUrl,
    };
    if (input.parentAnonId) body.parentAnonId = input.parentAnonId;
    if (input.referrer) {
      body.referrer = input.referrer.slice(0, ATTRIBUTION_MAX_REFERRER_LEN);
    }
    if (input.ts !== undefined) body.ts = input.ts;
    return this.post<AttributionLandingResponse>(
      "/api/attribution/landing",
      body,
    );
  }

  /**
   * Link anonymous browser ids (current one plus `parentAnonId`, up to 5)
   * to the authenticated wallet. Call after every sign-in, token restore
   * and account switch. Idempotent. Only network failures are retried: the
   * backend allows 20 claims per wallet per minute and every retry of a 429
   * would count against that window.
   * Requires authentication (setTokens must be called first).
   */
  claimAttribution(
    anonIds: string[],
  ): Promise<SdkResult<AttributionClaimResponse>> {
    return this.requestWithRefresh<AttributionClaimResponse>(
      "POST",
      "/api/attribution/claim",
      { anonIds },
      { shouldRetry: retryTransportOnly },
    );
  }

  // ── Profile (public user profiles) ──

  /**
   * Public profile of any wallet: username, display name, bio, avatar,
   * X link and the number of direct referrals. Public. `ref` is a wallet
   * address, a username or `@` + username (the wallet's current username,
   * in any letter case); the answer always carries the canonical `address`
   * — key everything else by it. Every valid address answers 200: a wallet
   * that never set anything up comes back with nulls.
   * Statuses: 404 a well-formed username nobody holds, 400 a `ref` that is
   * neither an address nor a username. On a backend before the public
   * portfolio (November 2026) only an address works — a username is a 400.
   */
  getPublicProfile(ref: string): Promise<SdkResult<PublicProfile>> {
    return this.get<PublicProfile>(
      `/api/profiles/${encodeURIComponent(ref)}`,
    );
  }

  /**
   * Profile cards for 1–100 addresses in one request — for views that have
   * addresses but no embedded `profile` (leaderboard, campaign, referral
   * and pool-transaction rows already carry it). Public. One item per
   * distinct address, in request order; `profile` is null for a wallet
   * with nothing set. 400 for more than 100 distinct addresses or a
   * malformed one. An empty list resolves to `{ data: [] }` without a
   * request (the backend would answer 400).
   */
  getProfileCards(
    addresses: string[],
  ): Promise<SdkResult<UserProfileCardsResponse>> {
    if (addresses.length === 0) return Promise.resolve(ok({ data: [] }));
    const qs = new URLSearchParams({ addresses: addresses.join(",") });
    return this.get<UserProfileCardsResponse>(
      `/api/profiles/cards?${qs.toString()}`,
    );
  }

  /**
   * The authenticated wallet's profile plus `edit.locked`. Reading creates
   * nothing: a wallet that never set anything up answers nulls.
   * Requires authentication (setTokens must be called first).
   */
  getMyProfile(): Promise<SdkResult<MyProfile>> {
    return this.get<MyProfile>("/api/profile/me");
  }

  /**
   * Update display name, bio and/or X link. Partial: a field that is absent
   * stays as it is, "" clears it; null and an empty body are a 400. The
   * backend normalises text (spaces collapsed, trimmed) — show what the
   * answer returns, not what was typed. Answers the full profile.
   * Idempotent, so the default re-sends are safe.
   * Requires authentication (setTokens must be called first).
   * Statuses: 400 nothing to update or a value of the wrong shape, 403 the
   * profile is locked and the body sets a new value, 422 display name not
   * allowed (brand or authority words), 429 more than 30 updates in 10
   * minutes.
   */
  updateMyProfile(body: UpdateMyProfileBody): Promise<SdkResult<MyProfile>> {
    return this.put<MyProfile>("/api/profile/me", body);
  }

  /**
   * Set or change the authenticated wallet's username: 3–20 English letters
   * and digits with single `_` or `-` between them; stored lower-case. ""
   * resets it to null (allowed while locked). Answers the full profile.
   * Idempotent — sending the current name again is a 200. There is no "is
   * it free?" call and refused attempts count towards the 429: check the
   * shape locally and submit on save.
   * Requires authentication (setTokens must be called first).
   * Statuses: 400 wrong shape, 403 the profile is locked, 409 taken (also
   * by a look-alike spelling), 422 not allowed (brand, authority or
   * reserved words, another wallet's referral code), 429 more than 20
   * attempts in an hour.
   */
  setUsername(username: string): Promise<SdkResult<MyProfile>> {
    return this.put<MyProfile>("/api/profile/me/username", { username });
  }

  /**
   * Upload the authenticated wallet's avatar. `image` is base64, bare or as
   * a `data:image/...;base64,` URL (FileReader.readAsDataURL): PNG, JPEG or
   * WebP, at most 512 KB decoded and 2048×2048 px. The backend stores a
   * 400×400 WebP, centre-cropped when the upload is not square — crop on the
   * client and check the size before sending (a body over ~1 MB is cut off
   * by the proxy and reads as a network error). Answers the full profile
   * with the new `avatarUrl`. Idempotent: the same image ends at the same
   * URL, so the default re-sends are safe.
   * Requires authentication (setTokens must be called first).
   * Statuses: 400 not base64, 403 the profile is locked, 413 over 512 KB,
   * 422 not a PNG/JPEG/WebP, damaged or over the pixel limit, 429 more than
   * 20 avatar changes in 10 minutes, 503 encoder busy (re-sent by the SDK).
   */
  uploadAvatar(image: string): Promise<SdkResult<MyProfile>> {
    return this.put<MyProfile>("/api/profile/me/avatar", { image });
  }

  /**
   * Remove the authenticated wallet's avatar; answers the full profile with
   * `avatarUrl: null`. Idempotent, and allowed while the profile is locked.
   * Shares the 429 limit of `uploadAvatar`.
   * Requires authentication (setTokens must be called first).
   */
  removeAvatar(): Promise<SdkResult<MyProfile>> {
    return this.post<MyProfile>("/api/profile/me/avatar/remove", {});
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

  // ── Portfolio v2 (redesigned portfolio page, auth required) ──

  /**
   * Chart data for the portfolio page chart card. Most metrics fill
   * `series` (one line); `il` fills `lines` (two lines) instead.
   *
   * Metrics: `networth` — whole portfolio value over time (wallet tokens +
   * LP positions, reconstructed from on-chain wallet history × historical
   * prices); `pnl` — CUMULATIVE profit/loss vs invested dollars:
   * unrealized (LP value minus entry-priced capital) + profit FIXED at
   * every exit (withdrawal = received USD − capital share, transfer-out =
   * amount × LP price at that moment − capital share) — continuous at
   * both top-ups and exits;
   * `il` — TWO lines in `lines`, both POSITIVE: `profit` (cumulative LP
   * fees earned) and `il` (impermanent loss magnitude, vs HODL); there is
   * no `series` for this metric, and `current`/`change` report the net
   * (profit − il);
   * `xp` — the total XP as of each point (cumulative, never decreasing).
   *
   * `all` range spans at least one year even for recent users, so it is
   * never shorter than `1y`.
   *
   * `options.pool` narrows `pnl` / `il` to that single position (the
   * expanded row of the positions table); `all` then starts at the first
   * activity in that pool, without the one-year floor. The backend rejects
   * it for `networth` / `xp`.
   *
   * `pnl` / `il` also carry `markers`: the user's actions on the charted
   * position(s) (added / zap / removed / sent / received), one marker per
   * grid step at most, each `marker.t` being a point of the line — see
   * `PortfolioChartMarker`. A marker's `events[].signature` goes to
   * `getPortfolioActivity({ highlight })` to open that row.
   */
  getPortfolioChart(
    metric: PortfolioChartMetric,
    range: PortfolioChartRange,
    options?: { pool?: string },
  ): Promise<SdkResult<PortfolioChartResponse>> {
    const qs = new URLSearchParams({ metric, range });
    if (options?.pool) qs.set("pool", options.pool);
    return this.get<PortfolioChartResponse>(
      `/api/portfolio/v2/chart?${qs.toString()}`,
    );
  }

  /**
   * On-chain activity feed: swaps, liquidity added/removed, zaps
   * (single-token deposits), LP tokens sent/received (wallet transfers
   * with counterparties) and pools deployed by the user. Newest first,
   * page/limit pagination. The Recent Activity widget is `{ limit: 4 }`;
   * filters: `liquidity` = added + removed, `transfer` = sent + received.
   *
   * `options.highlight` (a chart marker click — `PortfolioChartEvent.signature`)
   * makes the backend answer with the page that CONTAINS that transaction
   * under the given `type` / `sort` / `order` (`page` is then ignored):
   * read the served page from the response's `page` and the row from
   * `highlight.index`.
   */
  getPortfolioActivity(options?: {
    page?: number;
    limit?: number;
    type?: PortfolioActivityFilter;
    /** Sort column; unpriced rows (deployed) always go last on "value". */
    sort?: PortfolioActivitySortField;
    order?: SortOrder;
    /** Transaction signature to land on; overrides `page` (see above). */
    highlight?: string;
  }): Promise<SdkResult<PortfolioActivityResponse>> {
    const qs = new URLSearchParams({
      page: String(options?.page ?? 1),
      limit: String(options?.limit ?? 20),
      type: options?.type ?? "all",
      sort: options?.sort ?? "time",
      order: options?.order ?? "desc",
    });
    if (options?.highlight) qs.set("highlight", options.highlight);
    return this.get<PortfolioActivityResponse>(
      `/api/portfolio/v2/activity?${qs.toString()}`,
    );
  }

  /**
   * Token Holdings: every token the user holds, with LP positions
   * DECOMPOSED into their underlying tokens (per-pool share of actual
   * balances — what the user would receive on withdrawal). LP tokens
   * themselves are never listed. Each row carries a source breakdown
   * (wallet + per-pool amounts/percentages) for the Source tooltip.
   * The widget is `{ limit: 4 }`; sortable by value/price/balance.
   */
  getPortfolioHoldings(options?: {
    page?: number;
    limit?: number;
    sort?: PortfolioHoldingsSortField;
    order?: SortOrder;
  }): Promise<SdkResult<PortfolioHoldingsResponse>> {
    const qs = new URLSearchParams({
      page: String(options?.page ?? 1),
      limit: String(options?.limit ?? 20),
      sort: options?.sort ?? "value",
      order: options?.order ?? "desc",
    });
    return this.get<PortfolioHoldingsResponse>(
      `/api/portfolio/v2/holdings?${qs.toString()}`,
    );
  }

  /**
   * Position Pools: the user's ACTIVE LP positions with per-pool money
   * metrics — value (from the fresh wallet LP balance), fees earned,
   * unrealized + realized IL, net PnL and personal compounded APY.
   * A freshly received (transferred) position appears immediately with
   * its value and zeroed metrics until the background snapshot builds.
   */
  getPortfolioPositions(options?: {
    page?: number;
    limit?: number;
    sort?: PortfolioPositionsSortField;
    order?: SortOrder;
  }): Promise<SdkResult<PortfolioPositionsResponse>> {
    const qs = new URLSearchParams({
      page: String(options?.page ?? 1),
      limit: String(options?.limit ?? 20),
      sort: options?.sort ?? "value",
      order: options?.order ?? "desc",
    });
    return this.get<PortfolioPositionsResponse>(
      `/api/portfolio/v2/positions?${qs.toString()}`,
    );
  }

  // ── Public portfolio (any wallet — the profile page, no auth) ──

  /**
   * `getPortfolioChart` for ANY wallet — the chart card of a profile page.
   * Public. `ref` is a wallet address, a username or `@` + username, as in
   * `getPublicProfile`. Same ranges, same `options.pool` (for `pnl` / `il`)
   * and the same answer: `series` for `pnl` / `xp`, `lines` for `il`,
   * `markers` on `pnl` / `il` — a marker's `events[].signature` goes to
   * `getPublicPortfolioActivity(ref, { highlight })`.
   *
   * Two differences from the private call: there is no `networth` metric
   * (the value of a whole wallet is not public; the backend answers 400),
   * and the answer never has `approximateReasons` — `approximate` itself
   * is still there.
   *
   * A wallet the backend knows nothing about answers 200 with a zero chart.
   * Statuses: 400 a `ref` that is neither an address nor a username, or a
   * refused query; 404 a well-formed username nobody holds; 422 a `pnl` /
   * `il` chart that is not in the backend's cache, of a wallet with more
   * than 200 withdrawals and LP transfers — the backend does not build it
   * for a public read, the call is not retried and asking again does not
   * help (show the chart as unavailable); 503 too many cold chart builds
   * at once.
   *
   * That 503 carries `Retry-After: 2`, and this method — it alone — waits
   * for it: a request that failed in a retryable way is sent again after
   * 2 s and once more after another 2 s (the other methods come back after
   * 200 ms and 500 ms, which is before the backend has a free slot). So a
   * busy chart normally just arrives a few seconds later; only when the
   * third attempt is a 503 too is the result `backend_unavailable` with
   * `cause.status === 503` — ask again a little later.
   */
  getPublicPortfolioChart(
    ref: string,
    metric: PublicPortfolioChartMetric,
    range: PortfolioChartRange,
    options?: { pool?: string },
  ): Promise<SdkResult<PortfolioChartResponse>> {
    const qs = new URLSearchParams({ metric, range });
    if (options?.pool) qs.set("pool", options.pool);
    return this.get<PortfolioChartResponse>(
      `/api/profiles/${encodeURIComponent(ref)}/portfolio/chart?${qs.toString()}`,
      PUBLIC_CHART_RETRY,
    );
  }

  /**
   * `getPortfolioActivity` for ANY wallet — the activity feed of a profile
   * page. Public; `ref` as in `getPublicProfile`. Same options
   * (`highlight` included) and the same answer, `transfer.counterparty` of
   * the sent / received rows included.
   *
   * A wallet the backend knows nothing about answers 200 with an empty
   * list. Statuses: 400 a `ref` that is neither an address nor a username,
   * 404 a well-formed username nobody holds, 422 a feed that is not in the
   * backend's cache, of a wallet with more than 200 withdrawals and LP
   * transfers — not built for a public read, not retried (show the feed as
   * unavailable).
   */
  getPublicPortfolioActivity(
    ref: string,
    options?: {
      page?: number;
      limit?: number;
      type?: PortfolioActivityFilter;
      /** Sort column; unpriced rows (deployed) always go last on "value". */
      sort?: PortfolioActivitySortField;
      order?: SortOrder;
      /** Transaction signature to land on; overrides `page`. */
      highlight?: string;
    },
  ): Promise<SdkResult<PortfolioActivityResponse>> {
    const qs = new URLSearchParams({
      page: String(options?.page ?? 1),
      limit: String(options?.limit ?? 20),
      type: options?.type ?? "all",
      sort: options?.sort ?? "time",
      order: options?.order ?? "desc",
    });
    if (options?.highlight) qs.set("highlight", options.highlight);
    return this.get<PortfolioActivityResponse>(
      `/api/profiles/${encodeURIComponent(ref)}/portfolio/activity?${qs.toString()}`,
    );
  }

  /**
   * Token composition of ANY wallet's LP positions — the holdings table of
   * a profile page. Public; `ref` as in `getPublicProfile`. The options and
   * the shape are those of `getPortfolioHoldings`, but only what is held IN
   * POOLS is listed (the tokens in the wallet itself are not public): every
   * row's `sources.wallet` is `{ amount: 0, pct: 0 }`, `balance` and
   * `valueUsd` are the pool part alone, and a token the wallet holds only
   * outside pools has no row.
   *
   * A wallet the backend knows nothing about answers 200 with an empty
   * list. Statuses: 400 a `ref` that is neither an address nor a username,
   * 404 a well-formed username nobody holds.
   */
  getPublicPortfolioHoldings(
    ref: string,
    options?: {
      page?: number;
      limit?: number;
      sort?: PortfolioHoldingsSortField;
      order?: SortOrder;
    },
  ): Promise<SdkResult<PortfolioHoldingsResponse>> {
    const qs = new URLSearchParams({
      page: String(options?.page ?? 1),
      limit: String(options?.limit ?? 20),
      sort: options?.sort ?? "value",
      order: options?.order ?? "desc",
    });
    return this.get<PortfolioHoldingsResponse>(
      `/api/profiles/${encodeURIComponent(ref)}/portfolio/holdings?${qs.toString()}`,
    );
  }

  /**
   * `getPortfolioPositions` for ANY wallet — the positions table of a
   * profile page. Public; `ref` as in `getPublicProfile`. Same options and
   * the same answer.
   *
   * One difference from the private call: the LP balance behind `valueUsd`
   * is the one of the backend's stored position snapshot, not a live read
   * of the wallet. The two differ for seconds after a deposit or a
   * withdrawal, and after LP tokens were transferred between wallets until
   * the snapshot catches up; formulas and prices are the same.
   *
   * A wallet the backend knows nothing about answers 200 with an empty
   * list. Statuses: 400 a `ref` that is neither an address nor a username,
   * 404 a well-formed username nobody holds.
   */
  getPublicPortfolioPositions(
    ref: string,
    options?: {
      page?: number;
      limit?: number;
      sort?: PortfolioPositionsSortField;
      order?: SortOrder;
    },
  ): Promise<SdkResult<PortfolioPositionsResponse>> {
    const qs = new URLSearchParams({
      page: String(options?.page ?? 1),
      limit: String(options?.limit ?? 20),
      sort: options?.sort ?? "value",
      order: options?.order ?? "desc",
    });
    return this.get<PortfolioPositionsResponse>(
      `/api/profiles/${encodeURIComponent(ref)}/portfolio/positions?${qs.toString()}`,
    );
  }

  // ── Token pair-chart (pool creation range picker, public) ──

  /**
   * Price of token `a` expressed in token `b` over time — one line for
   * the range-picker chart on the pool creation page. Works for ANY two
   * Solana mints; no auth required.
   *
   * Cheap to call in bursts: the backend caches price history PER TOKEN,
   * so charting every token of a pool against one base costs at most one
   * upstream fetch per unique mint — flipping the base token reuses all
   * of them. Rate-limited per IP (90/min) on top of the global limiter.
   *
   * `"all"` is capped at one year — the historical price horizon for
   * arbitrary mints.
   */
  getTokenPairChart(
    a: string,
    b: string,
    range: PairChartRange,
  ): Promise<SdkResult<TokenPairChartResponse>> {
    const qs = new URLSearchParams({ a, b, range });
    return this.get<TokenPairChartResponse>(
      `/api/tokens/pair-chart?${qs.toString()}`,
    );
  }

  /**
   * Historical series for ONE pool — the chart card on the pool page.
   * No auth required.
   *
   * The APY series uses the same compounded formula as the pool card.
   * By default each point is the 7-day rolling APY (`basis: "7d"` — fees
   * over the trailing week, smooth; its trailing point equals
   * `Pool.apy7d`). Pass `basis: "24h"` for the daily one that matches the
   * card headline (`Pool.apy`) — it spikes on single swaps and drops to 0
   * on quiet days.
   *
   * Ranges: `1m` (default), `6m`, `1y`, `all` (whole history, never
   * shorter than a year); `24h`/`1w` remain accepted for older UIs.
   *
   * `metric: "lpPrice"` — the pool's LP token price in USD per token,
   * from the metrics cron's per-bucket pool snapshot ÷ LP supply (no
   * external price feed on the request path). Its points start where the
   * backend's snapshots start (2026-07-26), so an older pool's `all`/`1y`
   * line begins there.
   *
   * Points are computed from 10-minute stats buckets on a uniform grid
   * (~150 points per range, see `granularitySec`) and cached server-side
   * for two minutes, so polling costs nothing extra.
   */
  getPoolChart(
    poolAddress: string,
    options?: {
      metric?: PoolChartMetric;
      range?: PoolChartRange;
      basis?: PoolChartBasis;
    },
  ): Promise<SdkResult<PoolChartResponse>> {
    const qs = new URLSearchParams();
    if (options?.metric) qs.set("metric", options.metric);
    if (options?.range) qs.set("range", options.range);
    if (options?.basis) qs.set("basis", options.basis);
    const query = qs.toString();
    return this.get<PoolChartResponse>(
      `/api/pools/${poolAddress}/chart${query ? `?${query}` : ""}`,
    );
  }

  /**
   * Price of each pool token quoted in the pool's BASE token (its first
   * token), plus the curve bounds the price-range slider shows. No auth.
   *
   * Use this instead of `getTokenPairChart` on an existing pool: the pool
   * already fixes both sides of every pair, so the base is resolved
   * server-side and each row comes back correctly paired. One call covers
   * the whole composition table; pass `token` to refresh a single row.
   *
   * The base token's own row is included for ordering, with `ratio: 1`,
   * an empty `series` and no `bounds` — there is nothing to quote it
   * against.
   */
  getPoolTokenChart(
    poolAddress: string,
    options?: { range?: PairChartRange; token?: string },
  ): Promise<SdkResult<PoolTokenChartResponse>> {
    const qs = new URLSearchParams();
    if (options?.range) qs.set("range", options.range);
    if (options?.token) qs.set("token", options.token);
    const query = qs.toString();
    return this.get<PoolTokenChartResponse>(
      `/api/pools/${poolAddress}/token-chart${query ? `?${query}` : ""}`,
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
    // The nonce is single-use: resend only after a 429 (rejected before the
    // handler ran), never after a lost response or a 5xx.
    return this.requestWithRefresh<AuthTokens>(
      "POST",
      "/api/auth/verify",
      { message, signature },
      { shouldRetry: retryRateLimitOnly },
    );
  }

  /**
   * Request a sign-in challenge transaction (fallback for wallets whose
   * signMessage is broken: Ledger via mobile apps, etc.). The returned
   * transaction is a 0-lamport self-transfer plus a memo with the
   * agreements statement and a single-use nonce; it is verified offline
   * by the backend and never broadcast on-chain.
   */
  getTxChallenge(wallet: string): Promise<SdkResult<TxChallengeResponse>> {
    return this.get<TxChallengeResponse>(
      `/api/auth/tx-challenge?wallet=${encodeURIComponent(wallet)}`,
    );
  }

  /**
   * Submit the signed challenge transaction (base64, from
   * wallet.signTransaction + serialize) to receive the same access +
   * refresh token pair as verifySignature().
   */
  verifyTransaction(
    signedTransactionBase64: string,
  ): Promise<SdkResult<AuthTokens>> {
    // The challenge nonce is single-use: resend only after a 429, never
    // after a lost response or a 5xx.
    return this.requestWithRefresh<AuthTokens>(
      "POST",
      "/api/auth/verify-tx",
      { transaction: signedTransactionBase64 },
      { shouldRetry: retryRateLimitOnly },
    );
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

  // ── Rewards (boosts; backend docs/BOOSTS.md) ──
  //
  // Public, flat JSON. While the backend's rewards module is off the GET
  // routes answer empty lists and the voucher route 503. On a failure
  // `getRewardsApiError(result.error)` gives the status and the backend
  // `code`.

  /**
   * Pools with an active or scheduled boost (from `Pool.boost`), highest
   * `boostAprPct` first; each pool's `boost.items` holds only its active and
   * scheduled items. Public, cached 60 s by the backend.
   */
  getRewardBoosts(): Promise<SdkResult<PublicBoostsResponse>> {
    return this.requestWithRefresh<PublicBoostsResponse>("GET", "/api/rewards/boosts", undefined, {}, true);
  }

  /**
   * The backend's live reward campaigns as last read from the chain and the
   * key it signs vouchers with (`signer`, null while it does not sign).
   * Public, cached 60 s.
   */
  getRewardCampaigns(): Promise<SdkResult<PublicCampaignsResponse>> {
    return this.requestWithRefresh<PublicCampaignsResponse>("GET", "/api/rewards/campaigns", undefined, {}, true);
  }

  /**
   * What a wallet earned, can claim and has held, per campaign and per
   * boost. `ref` is a wallet address, a username or `@` + username (400
   * malformed, 404 a username nobody holds). Public, database only, cached
   * 30 s (dropped when one of the wallet's claims is indexed).
   */
  getWalletRewards(ref: string): Promise<SdkResult<WalletRewardsResponse>> {
    return this.requestWithRefresh<WalletRewardsResponse>("GET", `/api/rewards/wallets/${encodeURIComponent(ref)}`, undefined, {}, true);
  }

  /**
   * A signed voucher for the wallet's finalized all-time total in a
   * campaign; build the claim with `buildRewardClaimTx(voucher, …)`.
   * Public: only the beneficiary can claim with it. Errors (see
   * `getRewardsApiError`): 404 `unknown_campaign` / `nothing_accrued`, 409
   * `already_claimed` / `change_pending`, 423 `issuance_paused` /
   * `signer_mismatch`, 429 rate limit, 503 `signing_off` / `ledger_check`.
   * Only transport errors and timeouts are retried: every 429 counts
   * against the backend's per-wallet window, and a 503 does not clear in
   * milliseconds. Asking again for a voucher already signed returns the same one.
   */
  requestRewardVoucher(params: { wallet: string; campaign: string }): Promise<SdkResult<RewardVoucherResponse>>;
  requestRewardVoucher(wallet: string, campaign: string): Promise<SdkResult<RewardVoucherResponse>>;
  requestRewardVoucher(
    walletOrParams: string | { wallet: string; campaign: string },
    campaignArg?: string,
  ): Promise<SdkResult<RewardVoucherResponse>> {
    const body =
      typeof walletOrParams === "string"
        ? { wallet: walletOrParams, campaign: campaignArg }
        : { wallet: walletOrParams.wallet, campaign: walletOrParams.campaign };
    return this.requestWithRefresh<RewardVoucherResponse>(
      "POST",
      "/api/rewards/vouchers",
      body,
      { shouldRetry: retryTransportOnly },
      true,
    );
  }

  /**
   * Generic GET with retry. Callers that need it for other endpoints.
   * `retry` replaces parts of the default policy for this one call
   * (attempts, backoff, timeout, which errors are retried); without it the
   * call is retried as every other.
   */
  get<T>(path: string, retry?: RetryOptions): Promise<SdkResult<T>> {
    return this.requestWithRefresh<T>("GET", path, undefined, retry);
  }

  post<T>(path: string, body: unknown): Promise<SdkResult<T>> {
    return this.requestWithRefresh<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown): Promise<SdkResult<T>> {
    return this.requestWithRefresh<T>("PUT", path, body);
  }

  // ── Boosts run by a pool admin (backend docs/BOOSTS.md §9) ──
  //
  // JWT of the pool's on-chain admin. The campaign is the admin's own: it is
  // created, funded, limited, withdrawn from and closed with the admin's
  // wallet (`buildPoolAdminCampaignSetup`, `buildRewardDepositIx`,
  // `buildRewardWithdrawIx`, `buildRewardSetPayoutLimitIx`,
  // `buildRewardCloseIx`); these routes register it and run boosts from it.
  // Errors carry `code` (getRewardsApiError): `not_funded` (409, with
  // `depositRaw`), `payout_limit_low` (409), `cap_required` /
  // `cap_without_price` / `budget_too_small` (400), `not_your_campaign` /
  // `not_your_pool` (403 / 400), `campaign_checks` (400, with `checks`),
  // `boosts_off` / `signing_off` (503).

  private poolBoostsPath(poolAddress: string, rest = ""): string {
    return `/api/pools/admin/${encodeURIComponent(poolAddress)}/boosts${rest}`;
  }

  /** Boosts of the pool (yours and the protocol's) and your campaigns with their funding now. */
  getPoolAdminBoosts(poolAddress: string): Promise<SdkResult<PoolAdminBoostsOverview>> {
    return this.requestWithRefresh<PoolAdminBoostsOverview>("GET", this.poolBoostsPath(poolAddress), undefined, {}, true);
  }

  /** What to create your campaign with for `mint` (or "native"): id, address, our backend signer, the payout window; or your existing campaign. */
  getPoolAdminCampaignParams(poolAddress: string, mint: string | "native"): Promise<SdkResult<PoolAdminCampaignParams>> {
    return this.requestWithRefresh<PoolAdminCampaignParams>("GET", this.poolBoostsPath(poolAddress, `/campaign-params?mint=${encodeURIComponent(mint)}`), undefined, {}, true);
  }

  /** Register your campaign once it is on chain (finalized). */
  registerPoolAdminCampaign(poolAddress: string, body: { address: string; label?: string; note?: string }): Promise<SdkResult<PoolAdminCampaign>> {
    return this.requestWithRefresh<PoolAdminCampaign>("POST", this.poolBoostsPath(poolAddress, "/campaigns"), body, {}, true);
  }

  /** Your campaigns with their funding now (owed, committed, required, what to deposit, what you may withdraw, the payout limit). */
  getPoolAdminCampaigns(poolAddress: string): Promise<SdkResult<PoolAdminCampaignWithFunding[]>> {
    return this.requestWithRefresh<PoolAdminCampaignWithFunding[]>("GET", this.poolBoostsPath(poolAddress, "/campaigns"), undefined, {}, true);
  }

  /** Re-read your campaign from the chain after a deposit, a withdrawal or a limit change. */
  refreshPoolAdminCampaign(poolAddress: string, campaignId: number): Promise<SdkResult<PoolAdminCampaign>> {
    return this.requestWithRefresh<PoolAdminCampaign>("POST", this.poolBoostsPath(poolAddress, `/campaigns/${campaignId}/refresh`), {}, {}, true);
  }

  /** APR and spend for these terms, and what your campaign must hold to start them. `capBps` only for a reward token with a price. */
  previewPoolAdminBoost(poolAddress: string, body: PoolAdminBoostTerms): Promise<SdkResult<PoolAdminBoostPreview>> {
    return this.requestWithRefresh<PoolAdminBoostPreview>("POST", this.poolBoostsPath(poolAddress, "/preview"), body, {}, true);
  }

  /** Create a boost on the pool from your campaign: it must already hold what it owes plus every budget (this one included). */
  createPoolAdminBoost(poolAddress: string, body: PoolAdminBoostTerms & { label?: string; note?: string }): Promise<SdkResult<PoolAdminBoostView>> {
    return this.requestWithRefresh<PoolAdminBoostView>("POST", this.poolBoostsPath(poolAddress), body, {}, true);
  }

  /** New terms: a raise (budget, cap, end) waits 1 h and must be on the campaign; a cut starts at the next hour. */
  updatePoolAdminBoost(poolAddress: string, boostId: number, body: { budgetRaw?: string; capBps?: number; endAt?: string; note?: string }): Promise<SdkResult<PoolAdminBoostView>> {
    return this.requestWithRefresh<PoolAdminBoostView>("PUT", this.poolBoostsPath(poolAddress, `/${boostId}`), body, {}, true);
  }

  /** Stop your boost at the next hour; what it has not handed out stays in your campaign. */
  stopPoolAdminBoost(poolAddress: string, boostId: number, note?: string): Promise<SdkResult<PoolAdminBoostView>> {
    return this.requestWithRefresh<PoolAdminBoostView>("POST", this.poolBoostsPath(poolAddress, `/${boostId}/stop`), note ? { note } : {}, {}, true);
  }

  /** Cancel your boost before its first hour. */
  cancelPoolAdminBoost(poolAddress: string, boostId: number): Promise<SdkResult<PoolAdminBoostView>> {
    return this.requestWithRefresh<PoolAdminBoostView>("DELETE", this.poolBoostsPath(poolAddress, `/${boostId}`), undefined, {}, true);
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
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    retry: RetryOptions = {},
    errorBody = false,
  ): Promise<SdkResult<T>> {
    const result = await this.rawRequest<T>(method, path, body, retry, errorBody);

    // Don't auto-refresh for auth endpoints themselves
    const isAuthPath = path.startsWith("/api/auth/");
    if (!isAuthPath && !result.ok && this.is401(result) && this.refreshToken) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        return this.rawRequest<T>(method, path, body, retry, errorBody);
      }
    }

    return result;
  }

  /**
   * `errorBody`: on a non-2xx answer also read the JSON body into
   * `cause.body` (and its string `code` into `cause.code`); a body that is
   * not JSON is ignored.
   */
  private async rawRequest<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    retry: RetryOptions = {},
    errorBody = false,
  ): Promise<SdkResult<T>> {
    const url = `${this.endpoint}${path}`;
    const fetchOpts: RequestInit = {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const raw = await safeCall(async () => {
      let res: Response;
      try {
        res = await fetch(url, fetchOpts);
      } catch (e) {
        // No HTTP answer → transport; refused before sending (invalid URL or
        // header value) → permanent, keeps its own message.
        throw markTransportError(e, isFetchNetworkFailure(e));
      }
      if (!res.ok) {
        const error = new Error(
          `${method} ${path} → HTTP ${res.status} ${res.statusText}`,
        );
        (error as any).status = res.status;
        if (errorBody) {
          try {
            const parsed = await res.json();
            (error as any).body = parsed;
            if (typeof parsed?.code === "string") (error as any).code = parsed.code;
          } catch {
            // Not JSON, or the body broke off: the status alone.
          }
        }
        throw error;
      }
      try {
        return (await res.json()) as T;
      } catch (e) {
        if (e instanceof SyntaxError) {
          const error = new Error(
            `${method} ${path} → HTTP ${res.status}: invalid JSON response (${e.message})`,
          );
          (error as Error & { invalidResponse?: boolean }).invalidResponse = true;
          (error as Error & { cause?: unknown }).cause = e;
          throw error;
        }
        // The body stream broke off (Safari "Load failed", undici
        // "terminated"): the answer never fully arrived.
        throw markTransportError(e, true);
      }
    }, retry);
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

    // Only a rejection of the refresh token itself (401 invalid/expired,
    // 400 malformed) means both tokens are dead. No answer (offline,
    // timeout, 5xx) keeps them: the caller gets the original 401 and the
    // next request tries the refresh again.
    const status = (res.error.cause as { status?: unknown } | null | undefined)
      ?.status;
    if (status === 401 || status === 400) {
      this.clearTokens();
      this.onAuthExpired?.();
    }
    return false;
  }

  private is401(result: SdkResult<unknown>): boolean {
    if (result.ok) return false;
    const status = (result.error.cause as { status?: unknown } | null | undefined)
      ?.status;
    if (typeof status === "number") return status === 401;
    return result.error.humanMessage.includes("HTTP 401");
  }

  /**
   * Fetch a response envelope of the form `{ data: T, ... }` and unwrap
   * the `.data` field. The existing Coffer backend wraps most endpoints
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

  private async putDataField<T>(path: string, body: unknown): Promise<SdkResult<T>> {
    const res = await this.put<{ data: T }>(path, body);
    if (!res.ok) return res;
    return ok(res.data?.data);
  }

  /** Fetch the full envelope (for endpoints that return meta alongside data). */
  private async getEnvelope<T>(path: string): Promise<SdkResult<T>> {
    return this.get<T>(path);
  }
}

type PoolSummaryRow = Omit<Partial<PoolSummary>, "tokens"> & {
  poolAddress?: string;
  volume24h?: number | null;
  tokens?: Array<{
    mint?: string;
    mintAddress?: string;
    symbol?: string;
    ticker?: string;
    weightBps?: number;
    weight?: number;
  }>;
};

/** Older servers return SDK-shaped summaries; the Nest API uses entity field names and percent weights. */
function toPoolSummary(row: PoolSummaryRow | undefined): PoolSummary | undefined {
  if (!row || typeof row.poolEnabled !== "boolean" || !Array.isArray(row.tokens)) return;
  const address = row.address ?? row.poolAddress;
  if (typeof address !== "string") return;
  const tokens: PoolSummary["tokens"] = [];
  for (const token of row.tokens) {
    const mint = token?.mint ?? token?.mintAddress;
    const weightBps = token?.weightBps ?? (
      typeof token?.weight === "number" ? Math.round(token.weight * 100) : undefined
    );
    if (typeof mint !== "string" || typeof weightBps !== "number" || !Number.isFinite(weightBps)) return;
    tokens.push({ mint, symbol: token.symbol ?? token.ticker, weightBps });
  }
  if (row.address && row.tokens.every(token => token.mint !== undefined && token.weightBps !== undefined)) {
    return row as PoolSummary;
  }
  return {
    address,
    poolEnabled: row.poolEnabled,
    tokens,
    tvlUsd: row.tvlUsd ?? undefined,
    volume24hUsd: row.volume24hUsd ?? row.volume24h ?? undefined,
    feeApr7d: row.feeApr7d,
    boost: row.boost,
    boostAprPct: row.boostAprPct,
  };
}

/**
 * Mark a `fetch()` failure so `toSdkError` classifies it by structure
 * instead of by browser-specific message text: `transport = true` (no HTTP
 * answer: offline, DNS, CORS, reset, broken body) → `backend_unavailable`;
 * `transport = false` (the runtime refused to send: invalid URL, invalid
 * header value) → `unknown` with the original message, not retried.
 */
function markTransportError(e: unknown, transport: boolean): unknown {
  if (e !== null && typeof e === "object") {
    try {
      (e as { transport?: boolean }).transport = transport;
      if ((e as { transport?: boolean }).transport === transport) return e;
    } catch {
      // Frozen or exotic error object: wrap it below.
    }
  }
  const wrapped = new Error(
    e instanceof Error ? e.message : String(e ?? "fetch rejected"),
  );
  (wrapped as Error & { transport?: boolean }).transport = transport;
  (wrapped as Error & { cause?: unknown }).cause = e;
  return wrapped;
}

/**
 * Retry schedule of `getPublicPortfolioChart`. The backend builds only a
 * few public charts at a time and refuses one more with 503 and
 * `Retry-After: 2`. The default schedule comes back after 200 ms and
 * 500 ms — while the backend is still busy — and gives up; this one waits
 * the two seconds the backend names, twice. What counts as retryable is the
 * default (no HTTP answer, a timeout, 429, 5xx).
 */
const PUBLIC_CHART_RETRY: RetryOptions = { attempts: 3, backoffMs: [2000, 2000] };

/**
 * Retry only when no HTTP answer came back (timeout, unreachable host).
 * Any HTTP status, 429 included, is final for the caller.
 */
function retryTransportOnly(e: unknown): boolean {
  if (typeof (e as { status?: unknown } | null)?.status === "number") return false;
  const code = toSdkError(e).code;
  return (
    code === "rpc_timeout" ||
    code === "rpc_unavailable" ||
    code === "backend_unavailable"
  );
}

/**
 * For single-use requests (SIWS verify with a one-time nonce): retry only
 * an HTTP 429, which the throttler (or the edge) answers before the handler
 * consumes the nonce. A transport error, a timeout or a 5xx (500 from the
 * handler, 502/504 from the proxy) may come after the server already
 * consumed the nonce, so a resend would answer "nonce already used" (401)
 * and mask the real outcome.
 */
function retryRateLimitOnly(e: unknown): boolean {
  return (e as { status?: unknown } | null)?.status === 429;
}
