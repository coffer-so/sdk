/**
 * LP token valuation (v6.1, T2 / T12). The LP's net asset value per slot is
 * `nav_i = actual_balance_i + surge_fees_owed_i` — the trading reserves plus
 * the LP holders' surge bucket. It is NEVER `vault.amount`: the vault also
 * holds `protocol_fees_owed` and `creator_fees_owed` (not LP capital) and
 * any unbooked donation.
 *
 * ```text
 * lp_price_usd = Σ_i (nav_i / 10^dec_i × price_i) / (lp_supply / 10^LP_DECIMALS)
 * position_i   = floor(nav_i × lp_amount / lp_supply)
 * ```
 */
import BN from "bn.js";
import { LP_DECIMALS } from "../config";
import { MathError, assertU64 } from "./fixedPoint";
import { nav } from "./surgeBucket";

/** The slice of a pool snapshot the valuation needs (`PoolInfo` satisfies it). */
export interface LpPricePool {
  tokens: Array<{ mint: { toBase58(): string }; decimals: number; actualBalance: BN | bigint; surgeFeesOwed?: BN | bigint | null }>;
  /** Pool-level `surge_fees_owed`; used when a token slot carries none. */
  surgeFeesOwed?: Array<BN | bigint>;
  lpTotalSupply: BN | bigint;
}

export interface LpTokenValue {
  index: number;
  mint: string;
  /** `actual_balance + surge_fees_owed`, raw units. */
  nav: bigint;
  /** `nav / 10^decimals`. */
  navUi: number;
  priceUsd: number;
  /** `navUi × priceUsd`. */
  valueUsd: number;
}

export interface LpPriceUsd {
  /** USD value of one whole LP token (10^9 raw units). */
  lpPriceUsd: number;
  /** Σ `valueUsd` over the pool. */
  navUsd: number;
  /** `lp_supply / 10^LP_DECIMALS`. */
  lpSupplyUi: number;
  perToken: LpTokenValue[];
}

const big = (v: BN | bigint | null | undefined): bigint => (typeof v === "bigint" ? v : BigInt(v?.toString() ?? "0"));

/** Per-slot NAV (`actual + surge`) of a pool snapshot, raw units. */
export function poolNavBalances(pool: LpPricePool): bigint[] {
  return pool.tokens.map((t, i) => nav(assertU64(big(t.actualBalance), "actual balance"), assertU64(big(t.surgeFeesOwed ?? pool.surgeFeesOwed?.[i]), "surge bucket")));
}

/**
 * `lpPositionValue(pool, lpAmount)`: the per-token NAV share `lpAmount`
 * LP represents, `floor(nav_i × lpAmount / supply)` (raw units). Gross of
 * any withdraw / transfer fee — a valuation, not an exit quote.
 */
export function lpPositionValue(pool: LpPricePool, lpAmount: BN | bigint): bigint[] {
  const supply = assertU64(big(pool.lpTotalSupply), "lp supply");
  const amount = assertU64(big(lpAmount), "lp amount");
  if (supply === 0n) throw new MathError("PoolNotSeeded");
  return poolNavBalances(pool).map((n) => (n * amount) / supply);
}

/**
 * `lpPriceUsd(pool, prices)`: USD price of one LP token from per-mint spot
 * prices (`prices[mintBase58] = USD per whole token`). Every slot with a
 * non-zero NAV needs a price; a missing price throws.
 */
export function lpPriceUsd(pool: LpPricePool, prices: Record<string, number>): LpPriceUsd {
  const supply = assertU64(big(pool.lpTotalSupply), "lp supply");
  if (supply === 0n) throw new MathError("PoolNotSeeded");
  const navs = poolNavBalances(pool);
  const perToken: LpTokenValue[] = pool.tokens.map((t, i) => {
    const mint = t.mint.toBase58();
    const price = prices[mint];
    if (navs[i] > 0n && (typeof price !== "number" || !Number.isFinite(price) || price < 0)) throw new Error(`Missing or invalid USD price for mint ${mint}`);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 18) throw new Error(`Invalid decimals at token index ${i}`);
    const navUi = Number(navs[i]) / 10 ** t.decimals;
    const priceUsd = typeof price === "number" ? price : 0;
    return { index: i, mint, nav: navs[i], navUi, priceUsd, valueUsd: navUi * priceUsd };
  });
  const navUsd = perToken.reduce((s, t) => s + t.valueUsd, 0);
  const lpSupplyUi = Number(supply) / 10 ** LP_DECIMALS;
  return { lpPriceUsd: navUsd / lpSupplyUi, navUsd, lpSupplyUi, perToken };
}
